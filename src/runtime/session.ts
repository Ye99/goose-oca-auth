import { discoverProvider, refreshAccessToken, TOKEN_EXPIRY_BUFFER_MS, clampExpiresIn, type ProviderDiscovery, type ResolvedOcaModel } from "oca-auth-core"

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

function stripTrailingSlashes(value: string) {
  return value.replace(/\/+$/, "")
}

function buildChatCompletionUrls(baseURL: string) {
  const normalized = stripTrailingSlashes(baseURL)
  return [`${normalized}/chat/completions`, `${normalized}/v1/chat/completions`]
}

function buildResponsesUrl(baseURL: string) {
  return `${stripTrailingSlashes(baseURL)}/responses`
}

function stripOcaPrefix(body: Record<string, unknown>): Record<string, unknown> {
  if (typeof body.model === "string" && body.model.startsWith("oca/")) {
    return { ...body, model: body.model.slice(4) }
  }
  return body
}

/** Returns true if the model should use the Responses API instead of Chat Completions. */
function needsResponsesApi(modelId: string, models: ResolvedOcaModel[]): boolean {
  const entry = models.find((m) => m.id === modelId)
  if (entry) return entry.npmPackage === "@ai-sdk/openai"
  // Heuristic fallback if model not found in discovery
  const id = modelId.toLowerCase()
  return id.includes("gpt-5") || id.includes("codex")
}

/** Translate a Chat Completions request body to Responses API format. */
function chatToResponsesRequest(body: Record<string, unknown>): string {
  const out: Record<string, unknown> = { model: body.model }
  // The Responses API accepts messages arrays via `input`
  if (body.messages) out.input = body.messages
  if (body.max_tokens != null) out.max_output_tokens = body.max_tokens
  if (body.temperature != null) out.temperature = body.temperature
  if (body.top_p != null) out.top_p = body.top_p
  if (body.stop != null) out.stop = body.stop
  if (body.tools != null) out.tools = body.tools
  return JSON.stringify(out)
}

/** Parse upstream SSE response — the Responses API sends `data: {json}\n\n` even for non-streaming. */
function parseResponsesBody(raw: string): Record<string, unknown> | undefined {
  for (const line of raw.split("\n")) {
    const trimmed = line.trim()
    if (trimmed.startsWith("data: ")) {
      try {
        return JSON.parse(trimmed.slice(6)) as Record<string, unknown>
      } catch { /* skip */ }
    }
  }
  // Try parsing as plain JSON
  try {
    return JSON.parse(raw) as Record<string, unknown>
  } catch {
    return undefined
  }
}

/** Translate a Responses API response to Chat Completions format. */
function responsesToChatCompletion(data: Record<string, unknown>): string {
  const output = Array.isArray(data.output) ? data.output : []
  const firstMsg = output.find((o: Record<string, unknown>) => o.type === "message") as
    | Record<string, unknown>
    | undefined

  let content = ""
  if (firstMsg && Array.isArray(firstMsg.content)) {
    content = (firstMsg.content as Array<Record<string, unknown>>)
      .filter((c) => c.type === "output_text")
      .map((c) => c.text)
      .join("")
  }

  const usage = (data.usage ?? {}) as Record<string, unknown>

  return JSON.stringify({
    id: data.id ?? `chatcmpl-${Date.now()}`,
    object: "chat.completion",
    created: data.created_at ?? Math.floor(Date.now() / 1000),
    model: data.model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content },
        finish_reason: data.status === "completed" ? "stop" : "length",
      },
    ],
    usage: {
      prompt_tokens: usage.input_tokens ?? 0,
      completion_tokens: usage.output_tokens ?? 0,
      total_tokens: usage.total_tokens ?? 0,
    },
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

  const forwardToUpstream = async (
    urls: string[],
    headers: Headers,
    body: string,
  ): Promise<Response> => {
    for (const [index, url] of urls.entries()) {
      const response = await fetchImpl(url, {
        method: "POST",
        headers,
        body,
        redirect: "manual",
        signal: AbortSignal.timeout(config.requestTimeoutMs),
      })

      if (response.status === 404 && index < urls.length - 1) {
        console.warn(`[oca] ${url} returned 404, falling back to ${urls[index + 1]}`)
        continue
      }
      return response
    }

    return upstreamError("Unable to reach an OCA chat completions endpoint")
  }

  const proxyChatCompletions = async (request: Request) => {
    const providerDiscovery = await getDiscovery()
    if (!providerDiscovery) {
      return upstreamError("Unable to discover an OCA upstream endpoint")
    }

    const token = await getAccessToken()
    const rawBody = await request.text()

    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(rawBody) as Record<string, unknown>
    } catch {
      return badRequest("Invalid JSON body")
    }
    parsed = stripOcaPrefix(parsed)
    const modelId = typeof parsed.model === "string" ? parsed.model : ""

    const headers = new Headers()
    headers.set("content-type", "application/json")
    headers.set("authorization", toBearer(token))

    if (needsResponsesApi(modelId, providerDiscovery.models)) {
      // Route through the Responses API and translate back to Chat Completions format
      const responsesBody = chatToResponsesRequest(parsed)
      const responsesUrl = buildResponsesUrl(providerDiscovery.baseURL)

      const response = await fetchImpl(responsesUrl, {
        method: "POST",
        headers,
        body: responsesBody,
        redirect: "manual",
        signal: AbortSignal.timeout(config.requestTimeoutMs),
      })

      if (!response.ok) return response

      const raw = await response.text()
      const data = parseResponsesBody(raw)
      if (!data) {
        return upstreamError("Failed to parse Responses API response")
      }

      return new Response(responsesToChatCompletion(data), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }

    // Standard Chat Completions path for non-responses models
    return forwardToUpstream(
      buildChatCompletionUrls(providerDiscovery.baseURL),
      headers,
      JSON.stringify(parsed),
    )
  }

  return {
    getAccessToken,
    getDiscovery,
    proxyChatCompletions,
  }
}
