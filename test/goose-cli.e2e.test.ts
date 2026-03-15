import { expect, test } from "bun:test"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { spawn } from "node:child_process"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createApp } from "../src/app"
import { resolveBridgeConfig } from "../src/config"
import { installGooseProvider } from "../src/goose-provider"

function runGoose(args: string[], cwd: string, env: Record<string, string>) {
  return new Promise<{ stdout: string; stderr: string; exitCode: number | null }>((resolve, reject) => {
    const child = spawn("goose", args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    })

    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString()
    })
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString()
    })
    child.on("error", reject)
    child.on("close", (exitCode) => {
      resolve({ stdout, stderr, exitCode })
    })
  })
}

test("Goose can use the installed OCA bridge custom provider end-to-end", async () => {
  const root = await mkdtemp(join(tmpdir(), "goose-oca-e2e-"))
  const seenAuth: string[] = []
  const seenBridgePaths: string[] = []
  const seenUpstreamPaths: string[] = []
  const seenUpstreamBodies: Array<Record<string, unknown>> = []

  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url)
      seenAuth.push(request.headers.get("authorization") ?? "")
      seenUpstreamPaths.push(url.pathname)

      if (url.pathname === "/v1/model/info") {
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

      if (url.pathname === "/responses") {
        seenUpstreamBodies.push(await request.json())
        return Response.json({
          id: "resp-test",
          object: "response",
          created_at: 0,
          status: "completed",
          error: null,
          incomplete_details: null,
          model: "oca/gpt-5.3-codex",
          output: [
            {
              id: "msg-test",
              type: "message",
              status: "completed",
              role: "assistant",
              content: [{ type: "output_text", text: "ok", annotations: [] }],
            },
          ],
          parallel_tool_calls: true,
          store: false,
          tools: [],
          tool_choice: "auto",
          temperature: 1,
          top_p: 1,
          text: { format: { type: "text" } },
          truncation: "disabled",
          usage: {
            input_tokens: 1,
            input_tokens_details: { cached_tokens: 0 },
            total_tokens: 2,
            output_tokens: 1,
            output_tokens_details: { reasoning_tokens: 0 },
          },
        })
      }

      return new Response("not found", { status: 404 })
    },
  })

  const app = createApp(
    resolveBridgeConfig({
      OCA_BASE_URL: `http://127.0.0.1:${upstream.port}`,
      OCA_API_KEY: "bridge-test-token",
    }),
  )
  const bridge = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) => {
      seenBridgePaths.push(new URL(request.url).pathname)
      return app.handle(request)
    },
  })

  try {
    const home = join(root, "home")
    const configHome = join(root, "config")
    const dataHome = join(root, "data")
    const stateHome = join(root, "state")
    const projectDir = join(root, "project")
    await mkdir(projectDir, { recursive: true })

    const gooseConfigDir = join(configHome, "goose")
    await installGooseProvider(gooseConfigDir, {
      baseUrl: `http://127.0.0.1:${bridge.port}`,
    })

    const result = await runGoose(
      [
        "run",
        "--text",
        "Reply with exactly: ok",
        "--provider",
        "oca_bridge",
        "--model",
        "oca/gpt-5.3-codex",
        "--no-session",
        "--no-profile",
        "--quiet",
      ],
      projectDir,
      {
        HOME: home,
        XDG_CONFIG_HOME: configHome,
        XDG_DATA_HOME: dataHome,
        XDG_STATE_HOME: stateHome,
      },
    )

    expect(result.exitCode).toBe(0)
    expect(result.stdout.toLowerCase()).toContain("ok")
    expect(seenAuth).toContain("Bearer bridge-test-token")
    expect(seenBridgePaths.length).toBeGreaterThan(0)
    expect(seenBridgePaths.every((path) => path === "/v1/responses")).toBe(true)
    expect(seenUpstreamPaths).toContain("/responses")
    expect(seenUpstreamPaths).not.toContain("/chat/completions")
    expect(seenUpstreamPaths).not.toContain("/v1/chat/completions")
    expect(seenUpstreamBodies.length).toBeGreaterThan(0)
    for (const body of seenUpstreamBodies) {
      expect(body).toMatchObject({
        model: "gpt-5.3-codex",
        store: false,
        stream: false,
      })
    }

    const seenUpstreamBodyStrings = seenUpstreamBodies.map((body) => JSON.stringify(body))

    expect(seenUpstreamBodyStrings.some((body) => body.includes("Reply with exactly: ok"))).toBe(true)
  } finally {
    bridge.stop(true)
    upstream.stop(true)
    await rm(root, { recursive: true, force: true })
  }
}, 120000)
