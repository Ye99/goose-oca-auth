/// <reference types="bun-types" />
import { spawn } from "node:child_process"

import { exchangeCodeForTokens, normalizeUrl, resolveOauthConfig } from "oca-auth-core"

export const CALLBACK_PORT = 48801
export const CALLBACK_PATH = "/auth/oca"
export const redirectUri = `http://127.0.0.1:${CALLBACK_PORT}${CALLBACK_PATH}`

type ObtainTokensOptions = {
  logPrefix: string
  env?: Record<string, string | undefined>
}

type TokenResponse = {
  access_token: string
  refresh_token?: string
  expires_in?: number
}

function openBrowser(url: string) {
  const platform = process.platform
  const command = platform === "darwin" ? "open" : platform === "win32" ? "cmd" : "xdg-open"
  const args = platform === "darwin" ? [url] : platform === "win32" ? ["/c", "start", "", url] : [url]
  const child = spawn(command, args, { stdio: "ignore", detached: true })
  child.on("error", () => {})
  child.unref()
}

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

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

export function buildOauthErrorHtml(title: string, message: string) {
  return `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p>`
}

export function buildOauthSuccessHtml() {
  return "<h1>Success!</h1><p>You can close this tab.</p><script>setTimeout(()=>window.close(),1500)</script>"
}

export async function obtainTokens({ logPrefix, env = process.env }: ObtainTokensOptions): Promise<TokenResponse> {
  const oauth = resolveOauthConfig(undefined, env)
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

  return new Promise<TokenResponse>((resolve, reject) => {
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
          return new Response(buildOauthErrorHtml("Error", desc), {
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
          return new Response(buildOauthSuccessHtml(), {
            headers: { "content-type": "text/html" },
          })
        } catch (err) {
          clearTimeout(timeout)
          setTimeout(() => server.stop(true), 1000)
          reject(err)
          return new Response(
            buildOauthErrorHtml(
              "Token exchange failed",
              err instanceof Error ? err.message : String(err),
            ),
            {
              status: 500,
              headers: { "content-type": "text/html" },
            },
          )
        }
      },
    })

    console.log(`[${logPrefix}] Opening browser for IDCS login...`)
    console.log(`[${logPrefix}] If browser doesn't open, visit:\n  ${authorizeUrl}\n`)
    openBrowser(authorizeUrl)
  })
}
