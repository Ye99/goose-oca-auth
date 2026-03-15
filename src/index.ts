import { createApp, createBridgeServerOptions } from "./app"

export * from "./app"
export * from "./config"
export * from "./goose-provider"

if (import.meta.main) {
  const app = createApp()

  Bun.serve(createBridgeServerOptions(app))
}
