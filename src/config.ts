import { resolveOauthConfig } from "oca-auth-core"

export type BridgeConfig = {
  host: string
  port: number
  providerId: string
  defaultModel: string
  upstreamBaseUrl?: string
  apiKey?: string
  accessToken?: string
  accessTokenExpiresAt?: number
  refreshToken?: string
  requestTimeoutMs: number
  oauth: ReturnType<typeof resolveOauthConfig>
}

function parseExpiresAt(value?: string): number | undefined {
  const next = value?.trim()
  if (!next) return

  const numberValue = Number(next)
  if (Number.isFinite(numberValue)) return numberValue

  const dateValue = Date.parse(next)
  return Number.isNaN(dateValue) ? undefined : dateValue
}

function normalizeDefaultModel(providerId: string, value?: string) {
  const next = value?.trim()
  if (!next) return `${providerId}/gpt-5.4`
  const slashIndex = next.indexOf("/")
  if (slashIndex >= 0) return `${providerId}/${next.slice(slashIndex + 1)}`
  return `${providerId}/${next}`
}

export function resolveBridgeConfig(
  env: Record<string, string | undefined> = process.env,
): BridgeConfig {
  const host = env.GOOSE_OCA_HOST?.trim() || "127.0.0.1"
  if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") {
    console.warn(
      `[oca] WARNING: GOOSE_OCA_HOST="${host}" is not a loopback address. ` +
        `The proxy has no authentication — binding to a non-loopback address exposes it to the network.`,
    )
  }
  const rawPort = Number(env.GOOSE_OCA_PORT)
  const port = Number.isFinite(rawPort) && rawPort > 0 ? rawPort : 8787
  const providerId = env.GOOSE_OCA_PROVIDER?.trim() || "oca"
  const defaultModel = normalizeDefaultModel(providerId, env.GOOSE_OCA_DEFAULT_MODEL)
  const upstreamBaseUrl = env.OCA_BASE_URL?.trim() || undefined
  const apiKey = env.OCA_API_KEY?.trim() || undefined
  const accessToken = env.OCA_ACCESS_TOKEN?.trim() || undefined
  const refreshToken = env.OCA_REFRESH_TOKEN?.trim() || undefined
  const rawTimeout = Number(env.GOOSE_OCA_REQUEST_TIMEOUT_MS)
  const requestTimeoutMs = Number.isFinite(rawTimeout) && rawTimeout > 0 ? rawTimeout : 3_600_000

  return {
    host,
    port,
    providerId,
    defaultModel,
    upstreamBaseUrl,
    apiKey,
    accessToken,
    accessTokenExpiresAt: parseExpiresAt(env.OCA_ACCESS_TOKEN_EXPIRES_AT),
    refreshToken,
    requestTimeoutMs,
    oauth: resolveOauthConfig(undefined, env),
  }
}
