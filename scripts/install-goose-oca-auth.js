#!/usr/bin/env bun

import { resolveGooseConfigDir, installGooseProvider } from "../src/goose-provider"

const gooseConfigDir = process.argv[2] || resolveGooseConfigDir(process.env)
const baseUrl = process.argv[3] || process.env.GOOSE_OCA_BRIDGE_URL || "http://127.0.0.1:8787"

const filePath = await installGooseProvider(gooseConfigDir, {
  baseUrl,
})

console.log(`Installed Goose custom provider at ${filePath}`)
console.log(`Example: goose run --provider oca_bridge --model oca/gpt-5.3-codex --no-profile --no-session --text "Reply with exactly: ok"`)
