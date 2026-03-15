import { mkdir, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { normalizeUrl } from "oca-auth-core"
import type { BridgeConfig } from "./config"

export type GooseProviderOptions = {
  name?: string
  displayName?: string
  description?: string
  baseUrl: string
  defaultModel?: string
  contextLimit?: number
}

export type GooseCustomProviderConfig = {
  name: string
  engine: "openai"
  display_name: string
  description: string
  api_key_env: string
  base_url: string
  models: Array<{
    name: string
    context_limit: number
  }>
  supports_streaming: false
  requires_auth: false
  dynamic_models: true
}

function withResponsesPath(baseUrl: string) {
  const normalized = normalizeUrl(baseUrl)
  return normalized.endsWith("/v1/responses")
    ? normalized
    : `${normalized}/v1/responses`
}

export function buildGooseProviderConfig(
  options: GooseProviderOptions,
): GooseCustomProviderConfig {
  return {
    name: options.name ?? "oca_bridge",
    engine: "openai",
    display_name: options.displayName ?? "OCA Bridge",
    description: options.description ?? "Local OCA auth bridge for Goose",
    api_key_env: "",
    base_url: withResponsesPath(options.baseUrl),
    models: [
      {
        name: options.defaultModel ?? "oca/gpt-5.4",
        context_limit: options.contextLimit ?? 400_000,
      },
    ],
    supports_streaming: false,
    requires_auth: false,
    dynamic_models: true,
  }
}

export function resolveGooseProviderInstallOptions(
  bridgeConfig: Pick<BridgeConfig, "defaultModel">,
  baseUrl: string,
): GooseProviderOptions {
  return {
    baseUrl,
    defaultModel: bridgeConfig.defaultModel,
  }
}

export function resolveGooseConfigDir(
  env: Record<string, string | undefined> = process.env,
) {
  const xdgConfigHome = env.XDG_CONFIG_HOME?.trim()
  if (xdgConfigHome) return join(xdgConfigHome, "goose")
  return join(env.HOME?.trim() || homedir(), ".config", "goose")
}

export async function installGooseProvider(
  gooseConfigDir: string,
  options: GooseProviderOptions,
) {
  const config = buildGooseProviderConfig(options)
  const customProvidersDir = join(gooseConfigDir, "custom_providers")
  await mkdir(customProvidersDir, { recursive: true })
  const filePath = join(customProvidersDir, `${config.name}.json`)
  await writeFile(filePath, `${JSON.stringify(config, null, 2)}\n`, "utf8")
  return filePath
}
