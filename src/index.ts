import { createApp } from "./app"

export * from "./app"
export * from "./config"

if (import.meta.main) {
  const app = createApp()

  Bun.serve({
    hostname: app.config.host,
    port: app.config.port,
    fetch(request) {
      return app.handle(request)
    },
  })
}
