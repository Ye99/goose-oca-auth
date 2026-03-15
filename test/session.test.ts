import { expect, test } from "bun:test"

import { resolveBridgeConfig } from "../src/config"
import { createBridgeSession } from "../src/runtime/session"

test("session refreshes an expired token before discovery and caches the result", async () => {
  let refreshCalls = 0
  let discoveryCalls = 0

  const config = resolveBridgeConfig({
    OCA_BASE_URL: "https://oca.test.oraclecloud.com/litellm",
    OCA_ACCESS_TOKEN: "expired-token",
    OCA_ACCESS_TOKEN_EXPIRES_AT: "0",
    OCA_REFRESH_TOKEN: "refresh-token",
    OCA_IDCS_URL: "https://idcs.example.com",
    OCA_CLIENT_ID: "client-123",
  })

  const session = createBridgeSession(config, {
    now: () => 1_000,
    refreshAccessTokenImpl: async () => {
      refreshCalls += 1
      return {
        access_token: "fresh-token",
        refresh_token: "fresh-refresh-token",
        token_type: "Bearer",
        expires_in: 3600,
      }
    },
    fetchImpl: (async (input, init) => {
      const url = String(input)

      if (url === "https://oca.test.oraclecloud.com/litellm/v1/model/info") {
        discoveryCalls += 1
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer fresh-token")
        return Response.json({
          data: [
            {
              id: "oca/gpt-5.3-codex",
              model_name: "GPT 5.3 Codex",
              litellm_params: { model: "oca/gpt-5.3-codex" },
            },
          ],
        })
      }

      return new Response("not found", { status: 404 })
    }) as typeof fetch,
  })

  const first = await session.getDiscovery()
  const second = await session.getDiscovery()

  expect(first?.baseURL).toBe("https://oca.test.oraclecloud.com/litellm")
  expect(second?.models[0]?.id).toBe("gpt-5.3-codex")
  expect(await session.getAccessToken()).toBe("fresh-token")
  expect(refreshCalls).toBe(1)
  expect(discoveryCalls).toBe(1)
})

test("session caches failed discovery results until the negative TTL expires", async () => {
  let discoveryCalls = 0
  let nowValue = 1_000

  const config = resolveBridgeConfig({
    OCA_BASE_URL: "https://oca.test.oraclecloud.com/litellm",
    OCA_API_KEY: "api-key-token",
  })

  const session = createBridgeSession(config, {
    now: () => nowValue,
    fetchImpl: (async (input) => {
      const url = String(input)

      if (url.startsWith("https://oca.test.oraclecloud.com/litellm/")) {
        discoveryCalls += 1
        return new Response("not found", { status: 404 })
      }

      return new Response("not found", { status: 404 })
    }) as typeof fetch,
  })

  expect(await session.getDiscovery()).toBeUndefined()
  const callsAfterFirstAttempt = discoveryCalls

  expect(await session.getDiscovery()).toBeUndefined()
  expect(discoveryCalls).toBe(callsAfterFirstAttempt)

  nowValue += 30_001

  expect(await session.getDiscovery()).toBeUndefined()
  expect(discoveryCalls).toBeGreaterThan(callsAfterFirstAttempt)
})

test("session uses a short timeout for discovery even when responses use a long timeout", async () => {
  const config = resolveBridgeConfig({
    OCA_BASE_URL: "https://oca.test.oraclecloud.com/litellm",
    OCA_API_KEY: "api-key-token",
    GOOSE_OCA_REQUEST_TIMEOUT_MS: "3600000",
  })

  const seenTimeouts: number[] = []
  const originalTimeout = AbortSignal.timeout
  AbortSignal.timeout = ((delay: number) => {
    seenTimeouts.push(delay)
    return originalTimeout(delay)
  }) as typeof AbortSignal.timeout

  try {
    const session = createBridgeSession(config, {
      fetchImpl: (async (input) => {
        const url = String(input)

        if (url === "https://oca.test.oraclecloud.com/litellm/v1/model/info") {
          return Response.json({
            data: [
              {
                id: "oca/gpt-5.4",
                model_name: "GPT 5.4",
                litellm_params: { model: "oca/gpt-5.4" },
              },
            ],
          })
        }

        return new Response("not found", { status: 404 })
      }) as typeof fetch,
    })

    await session.getDiscovery()
  } finally {
    AbortSignal.timeout = originalTimeout
  }

  expect(seenTimeouts[0]).toBe(30_000)
  expect(config.requestTimeoutMs).toBe(3_600_000)
})

test("session uses API key mode without refresh", async () => {
  let refreshCalls = 0

  const config = resolveBridgeConfig({
    OCA_BASE_URL: "https://oca.test.oraclecloud.com/litellm",
    OCA_API_KEY: "api-key-token",
  })

  const session = createBridgeSession(config, {
    refreshAccessTokenImpl: async () => {
      refreshCalls += 1
      return {
        access_token: "unused",
        token_type: "Bearer",
      }
    },
    fetchImpl: (async (input, init) => {
      const url = String(input)
      if (url === "https://oca.test.oraclecloud.com/litellm/v1/model/info") {
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer api-key-token")
        return Response.json({ data: [] })
      }

      return new Response("not found", { status: 404 })
    }) as typeof fetch,
  })

  await session.getDiscovery()

  expect(await session.getAccessToken()).toBe("api-key-token")
  expect(refreshCalls).toBe(0)
})

test("session returns a structured invalid-request 400 for malformed Responses JSON", async () => {
  let fetchCalls = 0

  const config = resolveBridgeConfig({
    OCA_BASE_URL: "https://oca.test.oraclecloud.com/litellm",
    OCA_API_KEY: "api-key-token",
  })

  const session = createBridgeSession(config, {
    fetchImpl: (async (_input: RequestInfo | URL, _init?: RequestInit) => {
      fetchCalls += 1
      return new Response("unexpected", { status: 500 })
    }) as unknown as typeof fetch,
  })

  const response = await session.proxyResponses(
    new Request("http://bridge.local/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    }),
  )

  expect(fetchCalls).toBe(0)
  expect(response.status).toBe(400)
  expect(response.headers.get("content-type")).toContain("application/json")
  expect(await response.json()).toEqual({
    error: {
      message: "Invalid JSON body",
      type: "invalid_request",
    },
  })
})

test("session forwards Responses requests upstream without bridge translation", async () => {
  const config = resolveBridgeConfig({
    OCA_BASE_URL: "https://oca.test.oraclecloud.com/litellm",
    OCA_API_KEY: "api-key-token",
  })

  const session = createBridgeSession(config, {
    fetchImpl: (async (input, init) => {
      const url = String(input)

      if (url === "https://oca.test.oraclecloud.com/litellm/v1/model/info") {
        return Response.json({
          data: [
            {
              id: "oca/gpt-5.3-codex",
              model_name: "GPT 5.3 Codex",
              litellm_params: { model: "oca/gpt-5.3-codex" },
            },
          ],
        })
      }

      if (url === "https://oca.test.oraclecloud.com/litellm/responses") {
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer api-key-token")
        expect(JSON.parse(String(init?.body))).toEqual({
          model: "gpt-5.3-codex",
          input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }],
          tools: [
            {
              type: "function",
              name: "lookup_weather",
              description: "Look up weather",
              parameters: { type: "object", properties: {} },
            },
          ],
        })

        return Response.json({
          id: "resp-123",
          object: "response",
          model: "gpt-5.3-codex",
          output: [],
        })
      }

      return new Response("not found", { status: 404 })
    }) as typeof fetch,
  })

  const response = await session.proxyResponses(
    new Request("http://bridge.local/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "oca/gpt-5.3-codex",
        input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }],
        tools: [
          {
            type: "function",
            name: "lookup_weather",
            description: "Look up weather",
            parameters: { type: "object", properties: {} },
          },
        ],
      }),
    }),
  )

  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({
    id: "resp-123",
    object: "response",
    model: "gpt-5.3-codex",
    output: [],
  })
})

test("session forwards stream=true in Responses requests upstream", async () => {
  const config = resolveBridgeConfig({
    OCA_BASE_URL: "https://oca.test.oraclecloud.com/litellm",
    OCA_API_KEY: "api-key-token",
  })

  const session = createBridgeSession(config, {
    fetchImpl: (async (input, init) => {
      const url = String(input)

      if (url === "https://oca.test.oraclecloud.com/litellm/v1/model/info") {
        return Response.json({
          data: [
            {
              id: "oca/gpt-5.3-codex",
              model_name: "GPT 5.3 Codex",
              litellm_params: { model: "oca/gpt-5.3-codex" },
            },
          ],
        })
      }

      if (url === "https://oca.test.oraclecloud.com/litellm/responses") {
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer api-key-token")
        expect(JSON.parse(String(init?.body))).toEqual({
          model: "gpt-5.3-codex",
          stream: true,
          input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }],
        })

        return Response.json({
          id: "resp-stream-json",
          object: "response",
          model: "gpt-5.3-codex",
          output: [],
        })
      }

      return new Response("not found", { status: 404 })
    }) as typeof fetch,
  })

  const response = await session.proxyResponses(
    new Request("http://bridge.local/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "oca/gpt-5.3-codex",
        stream: true,
        input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }],
      }),
    }),
  )

  expect(response.status).toBe(200)
  expect(response.headers.get("content-type")).toContain("application/json")
  expect(await response.json()).toEqual({
    id: "resp-stream-json",
    object: "response",
    model: "gpt-5.3-codex",
    output: [],
  })
})

test("session passes upstream SSE Responses success through unchanged", async () => {
  const config = resolveBridgeConfig({
    OCA_BASE_URL: "https://oca.test.oraclecloud.com/litellm",
    OCA_API_KEY: "api-key-token",
  })

  const sseBody = [
    'event: response.output_text.delta\n',
    'data: {"delta":"hel"}\n\n',
    'event: response.completed\n',
    'data: {"id":"resp-stream"}\n\n',
  ].join("")

  const session = createBridgeSession(config, {
    fetchImpl: (async (input, init) => {
      const url = String(input)

      if (url === "https://oca.test.oraclecloud.com/litellm/v1/model/info") {
        return Response.json({
          data: [
            {
              id: "oca/gpt-5.3-codex",
              model_name: "GPT 5.3 Codex",
              litellm_params: { model: "oca/gpt-5.3-codex" },
            },
          ],
        })
      }

      if (url === "https://oca.test.oraclecloud.com/litellm/responses") {
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer api-key-token")
        expect(JSON.parse(String(init?.body))).toEqual({
          model: "gpt-5.3-codex",
          stream: true,
          input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }],
        })

        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(sseBody))
              controller.close()
            },
          }),
          {
            status: 200,
            headers: {
              "content-type": "text/event-stream; charset=utf-8",
              "cache-control": "no-store",
            },
          },
        )
      }

      return new Response("not found", { status: 404 })
    }) as typeof fetch,
  })

  const response = await session.proxyResponses(
    new Request("http://bridge.local/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "oca/gpt-5.3-codex",
        stream: true,
        input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }],
      }),
    }),
  )

  expect(response.status).toBe(200)
  expect(response.headers.get("content-type")).toBe("text/event-stream; charset=utf-8")
  expect(response.headers.get("cache-control")).toBe("no-store")
  expect(await response.text()).toBe(sseBody)
})

test("session restores a custom outward provider prefix in SSE Responses success payloads", async () => {
  const config = resolveBridgeConfig({
    GOOSE_OCA_PROVIDER: "oracle",
    OCA_BASE_URL: "https://oca.test.oraclecloud.com/litellm",
    OCA_API_KEY: "api-key-token",
  })

  const upstreamSseBody = [
    'event: response.created\n',
    'data: {"type":"response.created","response":{"id":"resp-stream","object":"response","model":"gpt-5.4"}}\n\n',
    'event: response.completed\n',
    'data: {"type":"response.completed","response":{"id":"resp-stream","object":"response","model":"gpt-5.4"}}\n\n',
  ].join("")

  const outwardSseBody = [
    'event: response.created\n',
    'data: {"type":"response.created","response":{"id":"resp-stream","object":"response","model":"oracle/gpt-5.4"}}\n\n',
    'event: response.completed\n',
    'data: {"type":"response.completed","response":{"id":"resp-stream","object":"response","model":"oracle/gpt-5.4"}}\n\n',
  ].join("")

  const session = createBridgeSession(config, {
    fetchImpl: (async (input, init) => {
      const url = String(input)

      if (url === "https://oca.test.oraclecloud.com/litellm/v1/model/info") {
        return Response.json({
          data: [
            {
              id: "oca/gpt-5.4",
              model_name: "GPT 5.4",
              litellm_params: { model: "oca/gpt-5.4" },
            },
          ],
        })
      }

      if (url === "https://oca.test.oraclecloud.com/litellm/responses") {
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer api-key-token")
        expect(JSON.parse(String(init?.body))).toEqual({
          model: "gpt-5.4",
          stream: true,
          input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }],
        })

        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(upstreamSseBody))
              controller.close()
            },
          }),
          {
            status: 200,
            headers: {
              "content-type": "text/event-stream; charset=utf-8",
              "cache-control": "no-store",
            },
          },
        )
      }

      return new Response("not found", { status: 404 })
    }) as typeof fetch,
  })

  const response = await session.proxyResponses(
    new Request("http://bridge.local/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "oracle/gpt-5.4",
        stream: true,
        input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }],
      }),
    }),
  )

  expect(response.status).toBe(200)
  expect(response.headers.get("content-type")).toBe("text/event-stream; charset=utf-8")
  expect(response.headers.get("cache-control")).toBe("no-store")
  expect(await response.text()).toBe(outwardSseBody)
})

test("session normalizes JSON success responses without relying on Response.clone", async () => {
  const config = resolveBridgeConfig({
    GOOSE_OCA_PROVIDER: "oracle",
    OCA_BASE_URL: "https://oca.test.oraclecloud.com/litellm",
    OCA_API_KEY: "api-key-token",
  })

  const session = createBridgeSession(config, {
    fetchImpl: (async (input, init) => {
      const url = String(input)

      if (url === "https://oca.test.oraclecloud.com/litellm/v1/model/info") {
        return Response.json({
          data: [
            {
              id: "oca/gpt-5.4",
              model_name: "GPT 5.4",
              litellm_params: { model: "oca/gpt-5.4" },
            },
          ],
        })
      }

      if (url === "https://oca.test.oraclecloud.com/litellm/responses") {
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer api-key-token")

        const responseLike = {
          ok: true,
          status: 200,
          statusText: "OK",
          headers: new Headers({ "content-type": "application/json" }),
          clone() {
            throw new Error("clone should not be used")
          },
          async text() {
            return JSON.stringify({
              id: "resp-clone-free",
              object: "response",
              model: "gpt-5.4",
              output: [],
            })
          },
        }

        return responseLike as unknown as Response
      }

      return new Response("not found", { status: 404 })
    }) as typeof fetch,
  })

  const response = await session.proxyResponses(
    new Request("http://bridge.local/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "oracle/gpt-5.4",
        input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }],
      }),
    }),
  )

  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({
    id: "resp-clone-free",
    object: "response",
    model: "oracle/gpt-5.4",
    output: [],
  })
})

test("session passes upstream non-2xx Responses bodies through unchanged", async () => {
  const config = resolveBridgeConfig({
    OCA_BASE_URL: "https://oca.test.oraclecloud.com/litellm",
    OCA_API_KEY: "api-key-token",
  })

  const upstreamBody = JSON.stringify({
    error: {
      message: "rate limit",
      type: "rate_limit_exceeded",
    },
  })

  const session = createBridgeSession(config, {
    fetchImpl: (async (input) => {
      const url = String(input)

      if (url === "https://oca.test.oraclecloud.com/litellm/v1/model/info") {
        return Response.json({
          data: [
            {
              id: "oca/gpt-5.4",
              model_name: "GPT 5.4",
              litellm_params: { model: "oca/gpt-5.4" },
            },
          ],
        })
      }

      if (url === "https://oca.test.oraclecloud.com/litellm/responses") {
        return new Response(upstreamBody, {
          status: 429,
          headers: {
            "content-type": "application/json",
            "retry-after": "30",
          },
        })
      }

      return new Response("not found", { status: 404 })
    }) as typeof fetch,
  })

  const response = await session.proxyResponses(
    new Request("http://bridge.local/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "oca/gpt-5.4",
        input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }],
      }),
    }),
  )

  expect(response.status).toBe(429)
  expect(response.headers.get("content-type")).toContain("application/json")
  expect(response.headers.get("retry-after")).toBe("30")
  expect(await response.text()).toBe(upstreamBody)
})

test("session strips a custom outward provider prefix before forwarding Responses requests", async () => {
  const config = resolveBridgeConfig({
    GOOSE_OCA_PROVIDER: "oracle",
    OCA_BASE_URL: "https://oca.test.oraclecloud.com/litellm",
    OCA_API_KEY: "api-key-token",
  })

  const session = createBridgeSession(config, {
    fetchImpl: (async (input, init) => {
      const url = String(input)

      if (url === "https://oca.test.oraclecloud.com/litellm/v1/model/info") {
        return Response.json({
          data: [
            {
              id: "oca/gpt-5.4",
              model_name: "GPT 5.4",
              litellm_params: { model: "oca/gpt-5.4" },
            },
          ],
        })
      }

      if (url === "https://oca.test.oraclecloud.com/litellm/responses") {
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer api-key-token")
        expect(JSON.parse(String(init?.body))).toEqual({
          model: "gpt-5.4",
          input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }],
        })

        return Response.json({
          id: "resp-456",
          object: "response",
          model: "gpt-5.4",
          output: [],
        })
      }

      return new Response("not found", { status: 404 })
    }) as typeof fetch,
  })

  const response = await session.proxyResponses(
    new Request("http://bridge.local/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "oracle/gpt-5.4",
        input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }],
      }),
    }),
  )

  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({
    id: "resp-456",
    object: "response",
    model: "oracle/gpt-5.4",
    output: [],
  })
})

test("proxyResponses accepts case-insensitive bearer tokens with surrounding whitespace", async () => {
  const config = resolveBridgeConfig({
    OCA_BASE_URL: "https://oca.test.oraclecloud.com/litellm",
    OCA_API_KEY: "  bearer api-key-token  ",
  })
  const seenAuth: string[] = []
  const session = createBridgeSession(config, {
    fetchImpl: (async (input, init) => {
      const url = String(input)

      if (url === "https://oca.test.oraclecloud.com/litellm/v1/model/info") {
        return Response.json({
          data: [
            {
              id: "oca/gpt-5.4",
              model_name: "GPT 5.4",
              litellm_params: { model: "oca/gpt-5.4" },
            },
          ],
        })
      }

      if (url === "https://oca.test.oraclecloud.com/litellm/responses") {
        seenAuth.push(new Headers(init?.headers).get("authorization") ?? "")
        return Response.json({ id: "resp-1", object: "response", model: "gpt-5.4", output: [] })
      }

      return new Response("not found", { status: 404 })
    }) as typeof fetch,
  })

  const response = await session.proxyResponses(
    new Request("http://bridge.local/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "oca/gpt-5.4",
        input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }],
      }),
    }),
  )

  expect(response.status).toBe(200)
  expect(seenAuth).toEqual(["bearer api-key-token"])
})
