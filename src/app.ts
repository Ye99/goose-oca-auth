import { resolveBridgeConfig, type BridgeConfig } from "./config"
import { buildModelsResponse } from "./routes/models"
import { badRequest, upstreamError } from "./routes/chat-completions"
import { createBridgeSession, type BridgeSession } from "./runtime/session"

export type BridgeApp = {
  config: BridgeConfig
  handle(request: Request): Promise<Response>
}

type CreateAppDeps = {
  session?: BridgeSession
}

export function createApp(config = resolveBridgeConfig(), deps: CreateAppDeps = {}): BridgeApp {
  const session = deps.session ?? createBridgeSession(config)

  return {
    config,
    async handle(request: Request) {
      const { pathname } = new URL(request.url)

      if (pathname === "/health") {
        return Response.json({ ok: true, service: "goose-oca-auth" })
      }

      if (pathname === "/v1/models") {
        try {
          const discovery = await session.getDiscovery()
          return Response.json(buildModelsResponse(config, discovery))
        } catch (error) {
          return upstreamError(error instanceof Error ? error.message : String(error))
        }
      }

      if (pathname === "/v1/chat/completions") {
        if (request.method !== "POST") {
          return badRequest("chat completions requires POST")
        }

        try {
          return await session.proxyChatCompletions(request)
        } catch (error) {
          return upstreamError(error instanceof Error ? error.message : String(error))
        }
      }

      return new Response("Not found", { status: 404 })
    },
  }
}
