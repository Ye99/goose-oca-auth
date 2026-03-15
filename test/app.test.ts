import { expect, test } from "bun:test"

import { createApp } from "../src/app"
import { resolveBridgeConfig } from "../src/config"
import { createBridgeSession } from "../src/runtime/session"

test("health endpoint reports bridge readiness", async () => {
  const app = createApp()
  const response = await app.handle(new Request("http://bridge.local/health"))

  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ ok: true, service: "goose-oca-auth" })
})

test("models endpoint exposes discovered models in an OpenAI-compatible list", async () => {
  const config = resolveBridgeConfig({
    OCA_BASE_URL: "https://oca.test.oraclecloud.com/litellm",
    OCA_API_KEY: "api-key-token",
  })
  const session = createBridgeSession(config, {
    fetchImpl: (async (input) => {
      if (String(input) === "https://oca.test.oraclecloud.com/litellm/v1/model/info") {
        return Response.json({
          data: [
            {
              id: "oca/gpt-5.3-codex",
              model_name: "GPT 5.3 Codex",
              litellm_params: { model: "oca/gpt-5.3-codex" },
            },
            {
              id: "oca/gpt-oss-120b",
              litellm_params: { model: "oca/gpt-oss-120b" },
            },
          ],
        })
      }

      return new Response("not found", { status: 404 })
    }) as typeof fetch,
  })
  const app = createApp(config, { session })
  const response = await app.handle(new Request("http://bridge.local/v1/models"))

  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({
    object: "list",
    data: [
      {
        id: "oca/gpt-5.3-codex",
        object: "model",
        created: 0,
        owned_by: "oca"
      },
      {
        id: "oca/gpt-oss-120b",
        object: "model",
        created: 0,
        owned_by: "oca"
      }
    ]
  })
})

test("responses endpoint preserves the public Responses contract at the app layer", async () => {
  const app = createApp(resolveBridgeConfig({}), {
    session: {
      getAccessToken: async () => "unused",
      getDiscovery: async () => undefined,
      proxyResponses: async (request) => {
        expect(request.method).toBe("POST")
        expect(await request.json()).toEqual({ model: "oca/gpt-5.3-codex", input: [] })

        return Response.json({ id: "resp-123", object: "response" })
      },
    },
  })
  const response = await app.handle(
    new Request("http://bridge.local/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "oca/gpt-5.3-codex", input: [] })
    })
  )

  expect(response.status).toBe(200)
  const json = await response.json() as Record<string, unknown>
  expect(json.id).toBe("resp-123")
  expect(json.object).toBe("response")
  expect(json).toEqual({ id: "resp-123", object: "response" })
})

test("responses endpoint rejects non-POST requests with a structured bad request", async () => {
  const app = createApp(resolveBridgeConfig({}), {
    session: {
      getAccessToken: async () => "unused",
      getDiscovery: async () => undefined,
      proxyResponses: async () => {
        throw new Error("proxy should not be called for non-POST requests")
      },
    },
  })
  const response = await app.handle(new Request("http://bridge.local/v1/responses"))

  expect(response.status).toBe(400)
  expect(await response.json()).toEqual({
    error: {
      message: "responses requires POST",
      type: "invalid_request",
    },
  })
})

test("responses endpoint rejects malformed JSON before auth discovery runs", async () => {
  const app = createApp(resolveBridgeConfig({}))
  const response = await app.handle(
    new Request("http://bridge.local/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    }),
  )

  expect(response.status).toBe(400)
  expect(await response.json()).toEqual({
    error: {
      message: "Invalid JSON body",
      type: "invalid_request",
    },
  })
})

test("models endpoint returns a structured error when auth is missing", async () => {
  const app = createApp(resolveBridgeConfig({}))
  const response = await app.handle(new Request("http://bridge.local/v1/models"))

  expect(response.status).toBe(502)
  expect(await response.json()).toEqual({
    error: {
      message: "No OCA access token or refresh token configured",
      type: "upstream_unavailable",
    },
  })
})

test("fallback models respect a custom outward provider id", async () => {
  const app = createApp(resolveBridgeConfig({ GOOSE_OCA_PROVIDER: "oracle" }), {
    session: {
      getAccessToken: async () => "unused",
      getDiscovery: async () => undefined,
      proxyResponses: async () => new Response("unused", { status: 200 }),
    },
  })
  const response = await app.handle(new Request("http://bridge.local/v1/models"))

  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({
    object: "list",
    data: [
      {
        id: "oracle/gpt-5.4",
        object: "model",
        created: 0,
        owned_by: "oracle",
      },
    ],
  })
})

test("responses returns a structured error when the session proxy throws", async () => {
  const app = createApp(resolveBridgeConfig({}), {
    session: {
      getAccessToken: async () => "unused",
      getDiscovery: async () => undefined,
      proxyResponses: async () => {
        throw new Error("upstream exploded")
      },
    },
  })
  const response = await app.handle(
    new Request("http://bridge.local/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "oca/gpt-5.3-codex", input: [] }),
    }),
  )

  expect(response.status).toBe(502)
  expect(await response.json()).toEqual({
    error: {
      message: "upstream exploded",
      type: "upstream_unavailable",
    },
  })
})
