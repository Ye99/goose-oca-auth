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
