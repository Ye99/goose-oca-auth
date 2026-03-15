import { expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { spawnSync } from "node:child_process"

import { resolveBridgeConfig } from "../src/config"
import {
  buildGooseProviderConfig,
  installGooseProvider,
  resolveGooseProviderInstallOptions,
  resolveGooseConfigDir,
} from "../src/goose-provider"

test("buildGooseProviderConfig emits a Goose custom provider config for the bridge", () => {
  expect(
    buildGooseProviderConfig({
      baseUrl: "http://127.0.0.1:8787",
    }),
  ).toEqual({
    name: "oca_bridge",
    engine: "openai",
    display_name: "OCA Bridge",
    description: "Local OCA auth bridge for Goose",
    api_key_env: "",
    base_url: "http://127.0.0.1:8787/v1/responses",
    models: [
      {
        name: "oca/gpt-5.4",
        context_limit: 400000,
      },
    ],
    supports_streaming: true,
    requires_auth: false,
    dynamic_models: true,
  })
})

test("resolveGooseConfigDir follows XDG config conventions", () => {
  expect(
    resolveGooseConfigDir({
      XDG_CONFIG_HOME: "/tmp/xdg-config",
      HOME: "/Users/example",
    }),
  ).toBe("/tmp/xdg-config/goose")
})

test("shared Goose install options keep the resolved default model for custom providers", () => {
  const bridgeConfig = resolveBridgeConfig({
    GOOSE_OCA_PROVIDER: "oracle",
  })

  expect(resolveGooseProviderInstallOptions(bridgeConfig, "http://127.0.0.1:8787")).toEqual({
    baseUrl: "http://127.0.0.1:8787",
    defaultModel: "oracle/gpt-5.4",
  })
})

test("installGooseProvider writes the provider JSON into Goose custom_providers", async () => {
  const root = await mkdtemp(join(tmpdir(), "goose-oca-provider-"))

  try {
    const configDir = join(root, "config", "goose")
    const file = await installGooseProvider(configDir, {
      baseUrl: "http://127.0.0.1:9999",
    })

    expect(file).toBe(join(configDir, "custom_providers", "oca_bridge.json"))
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual(
      buildGooseProviderConfig({ baseUrl: "http://127.0.0.1:9999" }),
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("installer script is directly executable", async () => {
  const root = await mkdtemp(join(tmpdir(), "goose-oca-script-"))

  try {
    const configDir = join(root, "config", "goose")
    const result = spawnSync(
      resolve(import.meta.dir, "..", "scripts", "install-goose-oca-auth.js"),
      [configDir, "http://127.0.0.1:8787"],
      {
        cwd: resolve(import.meta.dir, ".."),
        encoding: "utf8",
        env: {
          ...process.env,
          GOOSE_OCA_PROVIDER: "oracle",
        },
      },
    )

    expect(result.status).toBe(0)
    expect(result.stdout).toContain("Installed Goose custom provider")
    const installedProvider = JSON.parse(
      await readFile(join(configDir, "custom_providers", "oca_bridge.json"), "utf8"),
    )

    expect(installedProvider.models[0]?.name).toBe("oracle/gpt-5.4")
    expect(installedProvider.supports_streaming).toBe(true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
