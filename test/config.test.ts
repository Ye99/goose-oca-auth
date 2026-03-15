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

test("resolveBridgeConfig allows port 0 for ephemeral binding", () => {
  const config = resolveBridgeConfig({ GOOSE_OCA_PORT: "0" })

  expect(config.port).toBe(0)
})

test("resolveBridgeConfig rejects invalid provider ids", () => {
  expect(() => resolveBridgeConfig({ GOOSE_OCA_PROVIDER: "foo/bar" })).toThrow(/GOOSE_OCA_PROVIDER/i)
})

test("resolveBridgeConfig trims and preserves valid provider ids", () => {
  const config = resolveBridgeConfig({ GOOSE_OCA_PROVIDER: "  oracle-prod_1  " })

  expect(config.providerId).toBe("oracle-prod_1")
  expect(config.defaultModel).toBe("oracle-prod_1/gpt-5.4")
})
