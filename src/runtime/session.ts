import { discoverProvider, refreshAccessToken, TOKEN_EXPIRY_BUFFER_MS, type ProviderDiscovery } from "oca-auth-core"

import type { BridgeConfig } from "../config"

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

  let discovery: ProviderDiscovery | undefined
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
          authState.accessToken = tokens.access_token
          authState.refreshToken = tokens.refresh_token ?? authState.refreshToken
          authState.accessTokenExpiresAt = now() + (tokens.expires_in ?? 3600) * 1000
          return tokens.access_token
        })
        .finally(() => {
          refreshPromise = undefined
        })
    }

    return refreshPromise
  }

  const getDiscovery = async () => {
    if (discovery) return discovery
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
      return Response.json(
        {
          error: {
            message: "Unable to discover an OCA upstream endpoint",
            type: "upstream_unavailable",
          },
        },
        { status: 502 },
      )
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
      /* forward body as-is if not valid JSON */
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
      })

      if (response.status === 404 && index < urls.length - 1) continue
      return response
    }

    return Response.json(
      {
        error: {
          message: "Unable to reach an OCA chat completions endpoint",
          type: "upstream_unavailable",
        },
      },
      { status: 502 },
    )
  }

  return {
    getAccessToken,
    getDiscovery,
    proxyChatCompletions,
  }
}
