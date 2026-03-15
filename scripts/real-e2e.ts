#!/usr/bin/env bun
/// <reference types="bun-types" />
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

import { normalizeUrl, resolveOauthConfig } from "oca-auth-core"

import { createApp, createBridgeServerOptions } from "../src/app"
import { resolveBridgeConfig } from "../src/config"
import { installGooseProvider, resolveGooseConfigDir } from "../src/goose-provider"
import { obtainTokens } from "./shared/oauth"

function stripProviderPrefix(modelId: string) {
  const slashIndex = modelId.indexOf("/")
  return slashIndex >= 0 ? modelId.slice(slashIndex + 1) : modelId
}

// ── Main ──────────────────────────────────────────────────────────────

async function main() {
  console.log("=== Real E2E: OAuth → Bridge → Goose CLI ===\n")

  // Step 1: Obtain real OAuth tokens
  console.log("[e2e] Step 1: Obtaining OAuth tokens via PKCE flow...")
  const oauth = resolveOauthConfig(undefined, process.env)
  console.log(`[e2e] IDCS URL: ${normalizeUrl(oauth.idcsUrl)}`)
  console.log(`[e2e] Client ID: ${oauth.clientId}`)
  const tokens = await obtainTokens({ logPrefix: "e2e" })
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
  const bridge = Bun.serve(createBridgeServerOptions(app, { hostname: "127.0.0.1", port: 0 }))
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
