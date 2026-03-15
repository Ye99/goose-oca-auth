import { discoverProvider, refreshAccessToken, TOKEN_EXPIRY_BUFFER_MS, clampExpiresIn, type ProviderDiscovery } from "oca-auth-core"

import type { BridgeConfig } from "../config"
import { badRequest, upstreamError } from "../routes/chat-completions"

export type BridgeSession = {
  getAccessToken(): Promise<string>
  getDiscovery(): Promise<ProviderDiscovery | undefined>
  proxyResponses(request: Request): Promise<Response>
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

function stripTrailingSlashes(value: string) {
  return value.replace(/\/+$/, "")
}

function buildResponsesUrl(baseURL: string) {
  return `${stripTrailingSlashes(baseURL)}/responses`
}

function stripProviderPrefix(body: Record<string, unknown>, providerId: string): Record<string, unknown> {
  const prefix = `${providerId}/`
  if (typeof body.model === "string" && body.model.startsWith(prefix)) {
    return { ...body, model: body.model.slice(prefix.length) }
  }
  return body
}

function restoreProviderPrefix(body: Record<string, unknown>, providerId: string): Record<string, unknown> {
  if (providerId === "oca") return body

  const prefix = `${providerId}/`
  if (typeof body.model === "string" && !body.model.startsWith(prefix)) {
    return { ...body, model: `${prefix}${body.model}` }
  }

  return body
}

function normalizeSsePayload(body: Record<string, unknown>, providerId: string): Record<string, unknown> {
  const normalized = restoreProviderPrefix(body, providerId)
  const response = normalized.response
  if (!response || typeof response !== "object" || Array.isArray(response)) return normalized

  const normalizedResponse = restoreProviderPrefix(response as Record<string, unknown>, providerId)
  if (normalizedResponse === response) return normalized

  return { ...normalized, response: normalizedResponse }
}

function normalizeSseLine(line: string, providerId: string): string {
  if (!line.startsWith("data:")) return line

  const value = line.slice(5)
  const trimmed = value.trimStart()
  if (!trimmed.startsWith("{")) return line

  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return line
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return line

  const normalized = normalizeSsePayload(parsed as Record<string, unknown>, providerId)
  if (normalized === parsed) return line

  return `${line.slice(0, 5)} ${JSON.stringify(normalized)}`
}

function normalizeSseChunk(chunk: string, providerId: string): string {
  return chunk
    .split("\n")
    .map((line) => normalizeSseLine(line, providerId))
    .join("\n")
}

function normalizeResponsesEventStream(response: Response, providerId: string): Response {
  if (!response.body) return response

  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  let buffer = ""

  const body = response.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        buffer += decoder.decode(chunk, { stream: true })

        const lastNewlineIndex = buffer.lastIndexOf("\n")
        if (lastNewlineIndex === -1) return

        const complete = buffer.slice(0, lastNewlineIndex + 1)
        buffer = buffer.slice(lastNewlineIndex + 1)
        controller.enqueue(encoder.encode(normalizeSseChunk(complete, providerId)))
      },
      flush(controller) {
        buffer += decoder.decode()
        if (!buffer) return
        controller.enqueue(encoder.encode(normalizeSseChunk(buffer, providerId)))
      },
    }),
  )

  const headers = new Headers(response.headers)
  headers.delete("content-length")
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

async function normalizeResponsesSuccess(response: Response, providerId: string): Promise<Response> {
  if (!response.ok || providerId === "oca") return response

  const contentType = response.headers.get("content-type")
  const normalizedContentType = contentType?.toLowerCase()
  if (normalizedContentType?.includes("text/event-stream")) {
    return normalizeResponsesEventStream(response, providerId)
  }

  if (!normalizedContentType?.includes("application/json")) return response

  let parsed: unknown
  try {
    parsed = await response.clone().json()
  } catch {
    return response
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return response

  const normalized = restoreProviderPrefix(parsed as Record<string, unknown>, providerId)
  if (normalized === parsed) return response

  const headers = new Headers(response.headers)
  headers.delete("content-length")
  return new Response(JSON.stringify(normalized), {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
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

  const proxyResponses = async (request: Request) => {
    const rawBody = await request.text()

    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(rawBody) as Record<string, unknown>
    } catch {
      return badRequest("Invalid JSON body")
    }
    parsed = stripProviderPrefix(parsed, config.providerId)

    const providerDiscovery = await getDiscovery()
    if (!providerDiscovery) {
      return upstreamError("Unable to discover an OCA upstream endpoint")
    }

    const token = await getAccessToken()

    const headers = new Headers()
    headers.set("content-type", "application/json")
    headers.set("authorization", toBearer(token))

    const response = await fetchImpl(buildResponsesUrl(providerDiscovery.baseURL), {
      method: "POST",
      headers,
      body: JSON.stringify(parsed),
      redirect: "manual",
      signal: AbortSignal.timeout(config.requestTimeoutMs),
    })

    return normalizeResponsesSuccess(response, config.providerId)
  }

  return {
    getAccessToken,
    getDiscovery,
    proxyResponses,
  }
}
