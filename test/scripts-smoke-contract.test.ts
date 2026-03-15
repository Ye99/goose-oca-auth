import { expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { resolve } from "node:path"

const rootDir = resolve(import.meta.dir, "..")

test("installer example uses the current default model", async () => {
  const script = await readFile(resolve(rootDir, "scripts", "install-goose-oca-auth.js"), "utf8")

  expect(script).toContain("resolveBridgeConfig(process.env)")
  expect(script).toContain("bridgeConfig.defaultModel")
  expect(script).not.toContain("oca/gpt-5.3-codex")
})

test("real e2e script probes the native Responses endpoint", async () => {
  const script = await readFile(resolve(rootDir, "scripts", "real-e2e.ts"), "utf8")

  expect(script).toContain('"gpt-5.4"')
  expect(script).toContain("/responses")
  expect(script).toContain("max_output_tokens")
  expect(script).not.toContain("chat/completions")
  expect(script).not.toContain("gpt-5.3-codex")
})

test("scripts use cross-platform browser opener helper", async () => {
  const helper = await readFile(resolve(rootDir, "scripts", "shared", "oauth.ts"), "utf8")
  expect(helper).toContain("function openBrowser(url: string)")
  expect(helper).toContain('const platform = process.platform')
  expect(helper).toContain('platform === "darwin" ? "open"')
  expect(helper).toContain('platform === "win32" ? "cmd"')
  expect(helper).toContain(': "xdg-open"')

  for (const file of ["start-bridge.ts", "real-e2e.ts"]) {
    const script = await readFile(resolve(rootDir, "scripts", file), "utf8")
    expect(script).toContain('import { obtainTokens } from "./shared/oauth"')
    expect(script).not.toContain("function openBrowser(url: string)")
  }
})
