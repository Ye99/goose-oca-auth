import { expect, test } from "bun:test"

import { DEFAULT_IDCS_URL } from "oca-auth-core"

import { resolveBridgeConfig } from "../src/config"

test("resolveBridgeConfig uses stable bridge defaults and shared core oauth defaults", () => {
  const config = resolveBridgeConfig({})

  expect(config.port).toBe(8787)
  expect(config.defaultModel).toBe("oca/gpt-5.4")
  expect(config.oauth.idcsUrl).toBe(DEFAULT_IDCS_URL)
})

test("resolveBridgeConfig rewrites the default model to match a custom provider id", () => {
  const config = resolveBridgeConfig({
    GOOSE_OCA_PROVIDER: "oracle",
  })

  expect(config.providerId).toBe("oracle")
  expect(config.defaultModel).toBe("oracle/gpt-5.4")
})
