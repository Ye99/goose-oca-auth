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
  const seenBridgeBodies: Array<Record<string, unknown>> = []
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
        const body = (await request.json()) as Record<string, unknown>
        seenUpstreamBodies.push(body)

        if (body.stream !== true) {
          return Response.json(
            {
              error: {
                message: "expected Goose to request streaming responses",
              },
            },
            { status: 400 },
          )
        }

        const completedResponse = {
          id: "resp-test",
          object: "response",
          created_at: 0,
          status: "completed",
          error: null,
          incomplete_details: null,
          model: "gpt-5.3-codex",
          output: [
            {
              id: "msg-test",
              type: "message",
              status: "completed",
              role: "assistant",
              content: [{ type: "output_text", text: "ok", annotations: [] }],
            },
          ],
        }

        const sseBody = [
          "event: response.created\n",
          'data: {"type":"response.created","sequence_number":0,"response":{"id":"resp-test","object":"response","created_at":0,"status":"in_progress","model":"gpt-5.3-codex","output":[]}}\n\n',
          "event: response.output_item.added\n",
          'data: {"type":"response.output_item.added","sequence_number":1,"output_index":0,"item":{"id":"msg-test","type":"message","status":"in_progress","role":"assistant","content":[]}}\n\n',
          "event: response.content_part.added\n",
          'data: {"type":"response.content_part.added","sequence_number":2,"item_id":"msg-test","output_index":0,"content_index":0,"part":{"type":"output_text","text":"","annotations":[]}}\n\n',
          "event: response.output_text.delta\n",
          'data: {"type":"response.output_text.delta","sequence_number":3,"item_id":"msg-test","output_index":0,"content_index":0,"delta":"ok"}\n\n',
          "event: response.output_text.done\n",
          'data: {"type":"response.output_text.done","sequence_number":4,"item_id":"msg-test","output_index":0,"content_index":0,"text":"ok"}\n\n',
          "event: response.content_part.done\n",
          'data: {"type":"response.content_part.done","sequence_number":5,"item_id":"msg-test","output_index":0,"content_index":0,"part":{"type":"output_text","text":"ok","annotations":[]}}\n\n',
          "event: response.output_item.done\n",
          'data: {"type":"response.output_item.done","sequence_number":6,"output_index":0,"item":{"id":"msg-test","type":"message","status":"completed","role":"assistant","content":[{"type":"output_text","text":"ok","annotations":[]}]}}\n\n',
          "event: response.completed\n",
          `data: ${JSON.stringify({ type: "response.completed", sequence_number: 7, response: completedResponse })}\n\n`,
        ].join("")

        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(sseBody))
              controller.close()
            },
          }),
          {
            status: 200,
            headers: {
              "content-type": "text/event-stream; charset=utf-8",
              "cache-control": "no-store",
            },
          },
        )
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
    fetch: async (request) => {
      seenBridgePaths.push(new URL(request.url).pathname)
      if (request.method === "POST" && new URL(request.url).pathname === "/v1/responses") {
        seenBridgeBodies.push((await request.clone().json()) as Record<string, unknown>)
      }
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
    expect(seenBridgeBodies.length).toBeGreaterThan(0)
    for (const body of seenBridgeBodies) {
      expect(body).toMatchObject({
        model: "oca/gpt-5.3-codex",
        store: false,
        stream: true,
      })
    }
    expect(seenUpstreamPaths).toContain("/responses")
    expect(seenUpstreamPaths).not.toContain("/chat/completions")
    expect(seenUpstreamPaths).not.toContain("/v1/chat/completions")
    expect(seenUpstreamBodies.length).toBeGreaterThan(0)
    for (const body of seenUpstreamBodies) {
      expect(body).toMatchObject({
        model: "gpt-5.3-codex",
        store: false,
        stream: true,
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
