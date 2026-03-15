#!/usr/bin/env bun

import { resolveBridgeConfig } from "../src/config"
import {
  resolveGooseConfigDir,
  installGooseProvider,
  resolveGooseProviderInstallOptions,
} from "../src/goose-provider"

const gooseConfigDir = process.argv[2] || resolveGooseConfigDir(process.env)
const baseUrl = process.argv[3] || process.env.GOOSE_OCA_BRIDGE_URL || "http://127.0.0.1:8787"
const bridgeConfig = resolveBridgeConfig(process.env)

const filePath = await installGooseProvider(
  gooseConfigDir,
  resolveGooseProviderInstallOptions(bridgeConfig, baseUrl),
)

console.log(`Installed Goose custom provider at ${filePath}`)
console.log("Provider is configured for Goose streaming Responses mode.")
console.log(`Example: goose run --provider oca_bridge --model ${bridgeConfig.defaultModel} --no-profile --no-session --text "Reply with exactly: ok"`)
