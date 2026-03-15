#!/usr/bin/env bun
/// <reference types="bun-types" />
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

import { writeFile } from "node:fs/promises"
import { join } from "node:path"

import { createApp, createBridgeServerOptions } from "../src/app"
import { resolveBridgeConfig } from "../src/config"
import {
  buildGooseWrapperScript,
  installGooseProvider,
  normalizeGooseContextLimit,
  resolveGooseConfigDir,
  resolveGooseProviderInstallOptions,
  type GooseModelEntry,
} from "../src/goose-provider"
import { obtainTokens } from "./shared/oauth"

// ── Main ──────────────────────────────────────────────────────────────

async function main() {
  console.log("=== OCA Bridge for Goose ===\n")

  // Step 1: OAuth login
  console.log("[bridge] Authenticating with Oracle IDCS...")
  const tokens = await obtainTokens({ logPrefix: "bridge" })
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
  const bridge = Bun.serve(createBridgeServerOptions(app))

  const baseUrl = `http://127.0.0.1:${bridge.port}`
  const gooseConfigDir = resolveGooseConfigDir()
  const providerOptions = resolveGooseProviderInstallOptions(bridgeConfig, baseUrl)

  // Step 3: Install provider with default model, then update with discovered models
  await installGooseProvider(gooseConfigDir, providerOptions)

  console.log(`[bridge] Listening on ${baseUrl}`)
  console.log("[bridge] Goose provider installed. Run: goose session")

  // Step 4: Discover models and update provider config with context windows
  try {
    const discovery = await app.session.getDiscovery()
    if (discovery?.models.length) {
      const models: GooseModelEntry[] = discovery.models.map((m) => ({
        name: m.id.startsWith(`${bridgeConfig.providerId}/`) ? m.id : `${bridgeConfig.providerId}/${m.id}`,
        context_limit: normalizeGooseContextLimit(m.contextWindow, 400_000) ?? 400_000,
      }))
      await installGooseProvider(gooseConfigDir, { ...providerOptions, models })
      console.log(`[bridge] Updated provider config with ${models.length} discovered model(s).`)
      // Work around Goose ignoring context_limit from custom provider JSON —
      // Goose only reads GOOSE_CONTEXT_LIMIT from the process environment (std::env::var),
      // not from config.yaml. Write a small shell wrapper so the user can just run `goose-oca`.
      const defaultModelId = bridgeConfig.defaultModel.replace(`${bridgeConfig.providerId}/`, "")
      const defaultEntry = discovery.models.find((m) => m.id === defaultModelId)
      const contextLimit = defaultEntry?.contextWindow
      const wrapperScript = buildGooseWrapperScript(defaultEntry?.contextWindow)
      if (wrapperScript && typeof contextLimit === "number" && Number.isFinite(contextLimit)) {
        const wrapperPath = join(gooseConfigDir, "goose-oca")
        await writeFile(wrapperPath, wrapperScript, { mode: 0o755 })
        console.log(`[bridge] Wrote ${wrapperPath} (sets GOOSE_CONTEXT_LIMIT=${Math.trunc(contextLimit)})`)
        console.log(`[bridge] Launch goose with: ${wrapperPath} session`)
      }
    }
  } catch (err) {
    console.warn(`[bridge] Model discovery failed, using defaults: ${err instanceof Error ? err.message : String(err)}`)
  }

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
