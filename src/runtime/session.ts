import { discoverProvider, refreshAccessToken, TOKEN_EXPIRY_BUFFER_MS, clampExpiresIn, type ProviderDiscovery } from "oca-auth-core"

import type { BridgeConfig } from "../config"
import { badRequest, upstreamError } from "../routes/chat-completions"

export type BridgeSession = {
  getAccessToken(): Promise<string>
  getDiscovery(): Promise<ProviderDiscovery | undefined>
  proxyChatCompletions(request: Request): Promise<Response>
}

type BridgeSessionDeps = {
  fetchImpl?: typeof fetch
  now?: () => number
  refreshAccessTokenImpl?: typeof refreshAccessToken
}

type MutableAuthState = {
  accessToken?: string
  accessTokenExpiresAt?: number
  refreshToken?: string
}

function toBearer(value: string) {
  return value.startsWith("Bearer ") ? value : `Bearer ${value}`
}

function buildChatCompletionUrls(baseURL: string) {
  const normalized = baseURL.replace(/\/+$/, "")
  return [`${normalized}/chat/completions`, `${normalized}/v1/chat/completions`]
}

export function createBridgeSession(
  config: BridgeConfig,
  deps: BridgeSessionDeps = {},
): BridgeSession {
  const fetchImpl = deps.fetchImpl ?? fetch
  const now = deps.now ?? Date.now
  const refreshAccessTokenImpl = deps.refreshAccessTokenImpl ?? refreshAccessToken

  const authState: MutableAuthState = {
    accessToken: config.accessToken,
    accessTokenExpiresAt: config.accessTokenExpiresAt,
    refreshToken: config.refreshToken,
  }

  const DISCOVERY_TTL_MS = 5 * 60 * 1000
  const DISCOVERY_NEGATIVE_TTL_MS = 30 * 1000

  let discovery: ProviderDiscovery | undefined
  let discoveryExpiresAt = 0
  let discoveryPromise: Promise<ProviderDiscovery | undefined> | undefined
  let refreshPromise: Promise<string> | undefined

  const getAccessToken = async () => {
    if (config.apiKey) return config.apiKey

    if (authState.accessToken) {
      const expiresAt = authState.accessTokenExpiresAt
      if (expiresAt === undefined || expiresAt > now() + TOKEN_EXPIRY_BUFFER_MS || !authState.refreshToken) {
        return authState.accessToken
      }
    }

    if (!authState.refreshToken) {
      throw new Error("No OCA access token or refresh token configured")
    }

    if (!refreshPromise) {
      refreshPromise = refreshAccessTokenImpl(
        config.oauth.idcsUrl,
        config.oauth.clientId,
        authState.refreshToken,
      )
        .then((tokens) => {
          const newToken = tokens.access_token
          const newRefresh = tokens.refresh_token ?? authState.refreshToken
          const newExpiry = now() + clampExpiresIn(tokens.expires_in) * 1000
          // Assign atomically only after all values are known-good
          authState.accessToken = newToken
          authState.refreshToken = newRefresh
          authState.accessTokenExpiresAt = newExpiry
          return newToken
        })
        .catch((err) => {
          // Clear stale access token so next call doesn't use an expired one
          authState.accessToken = undefined
          authState.accessTokenExpiresAt = undefined
          throw err
        })
        .finally(() => {
          refreshPromise = undefined
        })
    }

    return refreshPromise
  }

  const getDiscovery = async () => {
    if (discovery && now() < discoveryExpiresAt) return discovery
    if (!discoveryPromise) {
      discoveryPromise = getAccessToken()
        .then((token) =>
          discoverProvider({
            token,
            baseUrls: config.upstreamBaseUrl ? [config.upstreamBaseUrl] : undefined,
            fetchImpl,
            timeoutMs: config.requestTimeoutMs,
          }),
        )
        .then((result) => {
          discovery = result
          discoveryExpiresAt = now() + (result ? DISCOVERY_TTL_MS : DISCOVERY_NEGATIVE_TTL_MS)
          return result
        })
        .finally(() => {
          discoveryPromise = undefined
        })
    }

    return discoveryPromise
  }

  const proxyChatCompletions = async (request: Request) => {
    const providerDiscovery = await getDiscovery()
    if (!providerDiscovery) {
      return upstreamError("Unable to discover an OCA upstream endpoint")
    }

    const token = await getAccessToken()
    const rawBody = await request.text()

    const prefix = `${config.providerId}/`
    let upstreamBody = rawBody
    try {
      const parsed = JSON.parse(rawBody)
      if (typeof parsed.model === "string" && parsed.model.startsWith(prefix)) {
        parsed.model = parsed.model.slice(prefix.length)
        upstreamBody = JSON.stringify(parsed)
      }
    } catch {
      return badRequest("Invalid JSON body")
    }

    const headers = new Headers()
    const contentType = request.headers.get("content-type")
    if (contentType) headers.set("content-type", contentType)
    const accept = request.headers.get("accept")
    if (accept) headers.set("accept", accept)
    headers.set("authorization", toBearer(token))

    const urls = buildChatCompletionUrls(providerDiscovery.baseURL)
    for (const [index, url] of urls.entries()) {
      const response = await fetchImpl(url, {
        method: "POST",
        headers,
        body: upstreamBody,
        redirect: "manual",
        signal: AbortSignal.timeout(config.requestTimeoutMs),
      })

      if (response.status === 404 && index < urls.length - 1) continue
      return response
    }

    return upstreamError("Unable to reach an OCA chat completions endpoint")
  }

  return {
    getAccessToken,
    getDiscovery,
    proxyChatCompletions,
  }
}
