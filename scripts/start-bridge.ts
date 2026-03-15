#!/usr/bin/env bun
/**
 * Start the OCA auth bridge for Goose.
 *
 * 1. Performs PKCE OAuth login (opens browser for Oracle IDCS)
 * 2. Starts the bridge server on localhost:8787
 * 3. Keeps running until Ctrl-C
 *
 * Usage:
 *   bun scripts/start-bridge.ts
 *
 * Requires: OCA_IDCS_URL and OCA_CLIENT_ID in env (or defaults).
 */

import { spawn } from "node:child_process"
import { resolveOauthConfig, exchangeCodeForTokens, normalizeUrl } from "oca-auth-core"
import { createApp } from "../src/app"
import { resolveBridgeConfig } from "../src/config"
import {
  installGooseProvider,
  resolveGooseConfigDir,
  resolveGooseProviderInstallOptions,
} from "../src/goose-provider"

// ── PKCE helpers ──────────────────────────────────────────────────────

function random(length: number) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~"
  const limit = 256 - (256 % chars.length)
  const result: string[] = []
  while (result.length < length) {
    const bytes = crypto.getRandomValues(new Uint8Array(length - result.length))
    for (const b of bytes) {
      if (b < limit) result.push(chars[b % chars.length])
      if (result.length === length) break
    }
  }
  return result.join("")
}

function encode(buffer: ArrayBuffer) {
  const bytes = new Uint8Array(buffer)
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "")
}

async function pkce() {
  const verifier = random(43)
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))
  return { verifier, challenge: encode(hash) }
}

// ── OAuth flow ────────────────────────────────────────────────────────

const CALLBACK_PORT = 48801
const CALLBACK_PATH = "/auth/oca"
const redirectUri = `http://127.0.0.1:${CALLBACK_PORT}${CALLBACK_PATH}`

async function obtainTokens() {
  const oauth = resolveOauthConfig(undefined, process.env)
  const idcsUrl = normalizeUrl(oauth.idcsUrl)
  const clientId = oauth.clientId

  const codes = await pkce()
  const state = encode(crypto.getRandomValues(new Uint8Array(32)).buffer)
  const nonce = encode(crypto.getRandomValues(new Uint8Array(32)).buffer)

  const authorizeParams = new URLSearchParams({
    client_id: clientId,
    response_type: "code",
    scope: "openid offline_access",
    code_challenge: codes.challenge,
    code_challenge_method: "S256",
    redirect_uri: redirectUri,
    state,
    nonce,
  })
  const authorizeUrl = `${idcsUrl}/oauth2/v1/authorize?${authorizeParams}`

  return new Promise<{ access_token: string; refresh_token?: string; expires_in?: number }>(
    (resolve, reject) => {
      const timeout = setTimeout(() => {
        server.stop(true)
        reject(new Error("OAuth callback timed out after 5 minutes"))
      }, 5 * 60 * 1000)

      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: CALLBACK_PORT,
        async fetch(req) {
          const url = new URL(req.url)
          if (url.pathname !== CALLBACK_PATH) {
            return new Response("Not found", { status: 404 })
          }

          const error = url.searchParams.get("error")
          if (error) {
            const desc = url.searchParams.get("error_description") ?? error
            clearTimeout(timeout)
            server.stop(true)
            reject(new Error(desc))
            return new Response(`<h1>Error</h1><p>${desc}</p>`, {
              headers: { "content-type": "text/html" },
            })
          }

          const code = url.searchParams.get("code")
          const returnedState = url.searchParams.get("state")

          if (!code || returnedState !== state) {
            clearTimeout(timeout)
            server.stop(true)
            reject(new Error("Invalid callback: missing code or state mismatch"))
            return new Response("Bad request", { status: 400 })
          }

          try {
            const tokens = await exchangeCodeForTokens(
              idcsUrl,
              clientId,
              code,
              redirectUri,
              codes.verifier,
            )
            clearTimeout(timeout)
            setTimeout(() => server.stop(true), 2000)
            resolve(tokens)
            return new Response(
              "<h1>Success!</h1><p>You can close this tab.</p><script>setTimeout(()=>window.close(),1500)</script>",
              { headers: { "content-type": "text/html" } },
            )
          } catch (err) {
            clearTimeout(timeout)
            setTimeout(() => server.stop(true), 1000)
            reject(err)
            return new Response(`<h1>Token exchange failed</h1><p>${err}</p>`, {
              status: 500,
              headers: { "content-type": "text/html" },
            })
          }
        },
      })

      console.log("[bridge] Opening browser for IDCS login...")
      console.log(`[bridge] If browser doesn't open, visit:\n  ${authorizeUrl}\n`)
      spawn("open", [authorizeUrl], { stdio: "ignore" })
    },
  )
}

// ── Main ──────────────────────────────────────────────────────────────

async function main() {
  console.log("=== OCA Bridge for Goose ===\n")

  // Step 1: OAuth login
  console.log("[bridge] Authenticating with Oracle IDCS...")
  const tokens = await obtainTokens()
  console.log("[bridge] Authentication successful.")

  // Step 2: Start bridge
  const bridgeConfig = resolveBridgeConfig({
    ...process.env,
    OCA_ACCESS_TOKEN: tokens.access_token,
    OCA_REFRESH_TOKEN: tokens.refresh_token ?? "",
    OCA_ACCESS_TOKEN_EXPIRES_AT: tokens.expires_in
      ? String(Date.now() + tokens.expires_in * 1000)
      : undefined,
  })
  const app = createApp(bridgeConfig)
  const bridge = Bun.serve({
    hostname: bridgeConfig.host,
    port: bridgeConfig.port,
    fetch: (req) => app.handle(req),
  })

  // Step 3: Ensure goose provider is installed pointing to correct port
  const gooseConfigDir = resolveGooseConfigDir()
  await installGooseProvider(
    gooseConfigDir,
    resolveGooseProviderInstallOptions(bridgeConfig, `http://127.0.0.1:${bridge.port}`),
  )

  console.log(`[bridge] Listening on http://127.0.0.1:${bridge.port}`)
  console.log("[bridge] Goose provider installed. Run: goose session")
  console.log("[bridge] Press Ctrl-C to stop.\n")

  // Keep alive until SIGINT/SIGTERM
  await new Promise<void>((resolve) => {
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      process.on(signal, () => {
        console.log(`\n[bridge] ${signal} received, shutting down.`)
        bridge.stop(true)
        resolve()
      })
    }
  })
}

main().catch((err) => {
  console.error(`[bridge] Fatal: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
})
