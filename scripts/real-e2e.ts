#!/usr/bin/env bun
/**
 * Real end-to-end test: PKCE OAuth login → bridge server → goose CLI.
 *
 * Usage:
 *   bun scripts/real-e2e.ts
 *
 * Requires: OCA_IDCS_URL and OCA_CLIENT_ID in env (or defaults).
 * Opens a browser for Oracle IDCS login, then runs goose against
 * the real OCA backend through the bridge.
 */

import { spawn } from "node:child_process"
import { resolveOauthConfig, exchangeCodeForTokens, normalizeUrl, nonEmpty } from "oca-auth-core"
function openBrowser(url: string) {
  const platform = process.platform
  const command = platform === "darwin" ? "open" : platform === "win32" ? "cmd" : "xdg-open"
  const args = platform === "darwin" ? [url] : platform === "win32" ? ["/c", "start", "", url] : [url]
  const child = spawn(command, args, { stdio: "ignore", detached: true })
  child.on("error", () => {})
  child.unref()
}
import { createApp } from "../src/app"
import { resolveBridgeConfig } from "../src/config"
import { installGooseProvider, resolveGooseConfigDir } from "../src/goose-provider"

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

function stripProviderPrefix(modelId: string) {
  const slashIndex = modelId.indexOf("/")
  return slashIndex >= 0 ? modelId.slice(slashIndex + 1) : modelId
}

// ── OAuth flow ────────────────────────────────────────────────────────

const CALLBACK_PORT = 48801
const CALLBACK_PATH = "/auth/oca"
const redirectUri = `http://127.0.0.1:${CALLBACK_PORT}${CALLBACK_PATH}`

async function obtainTokens() {
  const oauth = resolveOauthConfig(undefined, process.env)
  const idcsUrl = normalizeUrl(oauth.idcsUrl)
  const clientId = oauth.clientId

  console.log(`[e2e] IDCS URL: ${idcsUrl}`)
  console.log(`[e2e] Client ID: ${clientId}`)

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
            console.log("[e2e] Exchanging authorization code for tokens...")
            const tokens = await exchangeCodeForTokens(
              idcsUrl,
              clientId,
              code,
              redirectUri,
              codes.verifier,
            )
            clearTimeout(timeout)
            // Keep server alive briefly so browser can load the success page
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

      console.log(`[e2e] Opening browser for IDCS login...`)
      console.log(`[e2e] If browser doesn't open, visit:\n  ${authorizeUrl}\n`)
      openBrowser(authorizeUrl)
    },
  )
}

// ── Main ──────────────────────────────────────────────────────────────

async function main() {
  console.log("=== Real E2E: OAuth → Bridge → Goose CLI ===\n")

  // Step 1: Obtain real OAuth tokens
  console.log("[e2e] Step 1: Obtaining OAuth tokens via PKCE flow...")
  const tokens = await obtainTokens()
  console.log(`[e2e] Got access token (${tokens.access_token.slice(0, 12)}...)`)
  // Decode JWT payload to check scopes
  try {
    const payload = JSON.parse(atob(tokens.access_token.split(".")[1]))
    console.log(`[e2e] Token scopes: ${payload.scope ?? "(none)"}`)
    console.log(`[e2e] Token sub: ${payload.sub ?? "(none)"}`)
    console.log(`[e2e] Token exp: ${payload.exp ? new Date(payload.exp * 1000).toISOString() : "(none)"}`)
  } catch { console.log("[e2e] (could not decode JWT)") }
  if (tokens.refresh_token) {
    console.log(`[e2e] Got refresh token (${tokens.refresh_token.slice(0, 12)}...)`)
  }

  // Step 2: Start bridge server with real tokens
  console.log("\n[e2e] Step 2: Starting bridge server...")
  const bridgeConfig = resolveBridgeConfig({
    GOOSE_OCA_HOST: "127.0.0.1",
    GOOSE_OCA_PORT: "0", // random port
    OCA_ACCESS_TOKEN: tokens.access_token,
    OCA_REFRESH_TOKEN: tokens.refresh_token ?? "",
    OCA_ACCESS_TOKEN_EXPIRES_AT: tokens.expires_in
      ? String(Date.now() + tokens.expires_in * 1000)
      : undefined,
    OCA_IDCS_URL: process.env.OCA_IDCS_URL,
    OCA_CLIENT_ID: process.env.OCA_CLIENT_ID,
    OCA_BASE_URL: process.env.OCA_BASE_URL,
  })
  const app = createApp(bridgeConfig)
  const bridge = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (req) => app.handle(req),
  })
  const bridgeUrl = `http://127.0.0.1:${bridge.port}`
  console.log(`[e2e] Bridge listening on ${bridgeUrl}`)

  // Step 3: Test discovery through bridge
  console.log("\n[e2e] Step 3: Testing model discovery...")
  const modelsResp = await fetch(`${bridgeUrl}/v1/models`)
  const modelsBody = await modelsResp.json()
  console.log(`[e2e] /v1/models status: ${modelsResp.status}`)
  console.log(`[e2e] Models found: ${(modelsBody as any).data?.length ?? 0}`)
  for (const m of (modelsBody as any).data ?? []) {
    console.log(`  - ${m.id}`)
  }

  if (!(modelsBody as any).data?.length) {
    bridge.stop(true)
    console.error("\n[e2e] FAIL: No models discovered — cannot proceed with chat test.")
    process.exit(1)
  }

  // Prefer gpt-5.4 if available, otherwise use first model
  const allModels = (modelsBody as any).data as Array<{ id: string }>
  const preferred = allModels.find((m) => stripProviderPrefix(m.id) === "gpt-5.4")
  const firstModelId = preferred?.id ?? allModels[0].id
  console.log(`[e2e] Using model: ${firstModelId}`)

  // Step 4: Install goose custom provider and run goose CLI
  console.log("\n[e2e] Step 4: Running goose CLI through bridge...")
  const gooseConfigDir = resolveGooseConfigDir()
  const providerPath = await installGooseProvider(gooseConfigDir, {
    baseUrl: bridgeUrl,
    defaultModel: firstModelId,
  })
  console.log(`[e2e] Installed provider at: ${providerPath}`)

  const upstreamBaseUrl = normalizeUrl(
    bridgeConfig.upstreamBaseUrl
      ?? "https://code-internal.aiservice.us-chicago-1.oci.oraclecloud.com/20250206/app/litellm",
  )
  const upstreamProbeUrl = `${upstreamBaseUrl}/responses`
  const upstreamProbeBody = JSON.stringify({
    model: stripProviderPrefix(firstModelId),
    input: [{ role: "user", content: [{ type: "input_text", text: "Reply with exactly one word: hello" }] }],
    max_output_tokens: 10,
  })

  console.log("\n[e2e] Step 4a: Probing upstream /responses directly...")
  try {
    const resp = await fetch(upstreamProbeUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "authorization": `Bearer ${tokens.access_token}`,
      },
      body: upstreamProbeBody,
      signal: AbortSignal.timeout(30_000),
    })
    const body = await resp.text()
    console.log(`[e2e]   /responses → ${resp.status}: ${body.slice(0, 300)}`)
    if (resp.ok) {
      console.log(`[e2e]   ^^^ SUCCESS!`)
    }
  } catch (err) {
    console.log(`[e2e]   /responses → ERROR: ${err}`)
  }

  console.log("\n[e2e] Step 4b: Running goose CLI through bridge...")
  const gooseResult = await new Promise<{ stdout: string; stderr: string; exitCode: number | null }>(
    (resolve, reject) => {
      const child = spawn(
        "goose",
        [
          "run",
          "--text", "Reply with exactly one word: hello",
          "--provider", "oca_bridge",
          "--model", firstModelId,
          "--no-session",
          "--no-profile",
          "--quiet",
        ],
        { stdio: ["ignore", "pipe", "pipe"] },
      )

      let stdout = ""
      let stderr = ""
      child.stdout.on("data", (chunk) => { stdout += chunk.toString() })
      child.stderr.on("data", (chunk) => { stderr += chunk.toString() })
      child.on("error", reject)
      child.on("close", (exitCode) => resolve({ stdout, stderr, exitCode }))
    },
  )

  bridge.stop(true)

  // Step 5: Report results
  console.log("\n=== Results ===")
  console.log(`Exit code: ${gooseResult.exitCode}`)
  console.log(`Stdout:\n${gooseResult.stdout}`)
  if (gooseResult.stderr.trim()) {
    console.log(`Stderr:\n${gooseResult.stderr}`)
  }

  if (gooseResult.exitCode === 0) {
    console.log("\n[e2e] PASS: Real end-to-end test succeeded!")
  } else {
    console.error("\n[e2e] FAIL: goose exited with non-zero status.")
    process.exit(1)
  }
}

main().catch((err) => {
  console.error(`\n[e2e] Fatal error: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
})