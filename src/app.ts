import { resolveBridgeConfig, type BridgeConfig } from "./config"
import { buildModelsResponse } from "./routes/models"
import { badRequest, upstreamError } from "./routes/chat-completions"
import { createBridgeSession, type BridgeSession } from "./runtime/session"

export type BridgeApp = {
  config: BridgeConfig
  session: BridgeSession
  handle(request: Request): Promise<Response>
}

type CreateAppDeps = {
  session?: BridgeSession
}

type BridgeServerOverrides = {
  hostname?: string
  port?: number
}

async function withUpstreamErrorHandling(fn: () => Promise<Response>): Promise<Response> {
  try {
    return await fn()
  } catch (error) {
    return upstreamError(error instanceof Error ? error.message : String(error))
  }
}

export function createApp(config = resolveBridgeConfig(), deps: CreateAppDeps = {}): BridgeApp {
  const session = deps.session ?? createBridgeSession(config)

  return {
    config,
    session,
    async handle(request: Request) {
      const { pathname } = new URL(request.url)

      if (pathname === "/health") {
        return Response.json({ ok: true, service: "goose-oca-auth" })
      }

      if (pathname === "/v1/models") {
        return withUpstreamErrorHandling(async () => {
          const discovery = await session.getDiscovery()
          return Response.json(buildModelsResponse(config, discovery))
        })
      }

      if (pathname === "/v1/responses") {
        if (request.method !== "POST") {
          return badRequest("responses requires POST")
        }
        return withUpstreamErrorHandling(() => session.proxyResponses(request))
      }

      return new Response("Not found", { status: 404 })
    },
  }
}

export function createBridgeServerOptions(
  app: BridgeApp,
  overrides: BridgeServerOverrides = {},
) {
  return {
    hostname: overrides.hostname ?? app.config.host,
    port: overrides.port ?? app.config.port,
    idleTimeout: Math.max(1, Math.ceil(app.config.requestTimeoutMs / 1000)),
    fetch(request: Request) {
      return app.handle(request)
    },
  }
}
