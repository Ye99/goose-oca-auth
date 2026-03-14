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

test("chat completions endpoint routes gpt-5 models through the Responses API", async () => {
  const seenUrls: string[] = []
  const config = resolveBridgeConfig({
    OCA_BASE_URL: "https://oca.test.oraclecloud.com/litellm",
    OCA_API_KEY: "api-key-token",
  })
  const session = createBridgeSession(config, {
    fetchImpl: (async (input, init) => {
      const url = String(input)
      seenUrls.push(url)

      if (url === "https://oca.test.oraclecloud.com/litellm/v1/model/info") {
        return Response.json({
          data: [
            {
              id: "oca/gpt-5.3-codex",
              litellm_params: { model: "oca/gpt-5.3-codex" },
            },
          ],
        })
      }

      if (url === "https://oca.test.oraclecloud.com/litellm/responses") {
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer api-key-token")
        const body = JSON.parse(await new Response(init?.body).text())
        expect(body.model).toBe("gpt-5.3-codex")
        expect(body.input).toEqual([])
        return new Response(
          `data: ${JSON.stringify({
            id: "resp-123",
            object: "response",
            created_at: 0,
            status: "completed",
            model: "gpt-5.3-codex",
            output: [
              {
                type: "message",
                content: [{ type: "output_text", text: "Hello!" }],
                role: "assistant",
              },
            ],
            usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
          })}\n\n`,
          { headers: { "content-type": "text/event-stream" } },
        )
      }

      return new Response("not found", { status: 404 })
    }) as typeof fetch,
  })
  const app = createApp(config, { session })
  const response = await app.handle(
    new Request("http://bridge.local/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "oca/gpt-5.3-codex", messages: [] })
    })
  )

  expect(response.status).toBe(200)
  const json = await response.json() as Record<string, unknown>
  expect(json.object).toBe("chat.completion")
  expect((json as any).choices[0].message.content).toBe("Hello!")
  expect((json as any).usage.prompt_tokens).toBe(5)
  expect(seenUrls).toContain("https://oca.test.oraclecloud.com/litellm/responses")
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
      proxyChatCompletions: async () => new Response("unused", { status: 200 }),
    },
  })
  const response = await app.handle(new Request("http://bridge.local/v1/models"))

  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({
    object: "list",
    data: [
      {
        id: "oracle/gpt-5.3-codex",
        object: "model",
        created: 0,
        owned_by: "oracle",
      },
    ],
  })
})

test("chat completions returns a structured error when auth is missing", async () => {
  const app = createApp(resolveBridgeConfig({}))
  const response = await app.handle(
    new Request("http://bridge.local/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "oca/gpt-5.3-codex", messages: [] }),
    }),
  )

  expect(response.status).toBe(502)
  expect(await response.json()).toEqual({
    error: {
      message: "No OCA access token or refresh token configured",
      type: "upstream_unavailable",
    },
  })
})
