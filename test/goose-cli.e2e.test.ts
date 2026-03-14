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

  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url)
      seenAuth.push(request.headers.get("authorization") ?? "")

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
        return new Response(
          `data: ${JSON.stringify({
            id: "resp-test",
            object: "response",
            created_at: 0,
            status: "completed",
            model: "gpt-5.3-codex",
            output: [
              {
                type: "message",
                content: [{ type: "output_text", text: "ok" }],
                role: "assistant",
              },
            ],
            usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
          })}\n\n`,
          { headers: { "content-type": "text/event-stream" } },
        )
      }

      if (url.pathname === "/chat/completions") {
        return new Response("not found", { status: 404 })
      }

      if (url.pathname === "/v1/chat/completions") {
        return Response.json({
          id: "chatcmpl-test",
          object: "chat.completion",
          created: 0,
          model: "oca/gpt-5.3-codex",
          choices: [
            {
              index: 0,
              finish_reason: "stop",
              message: {
                role: "assistant",
                content: "ok",
              },
            },
          ],
          usage: {
            prompt_tokens: 1,
            completion_tokens: 1,
            total_tokens: 2,
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
    fetch: (request) => app.handle(request),
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
  } finally {
    bridge.stop(true)
    upstream.stop(true)
    await rm(root, { recursive: true, force: true })
  }
}, 120000)
