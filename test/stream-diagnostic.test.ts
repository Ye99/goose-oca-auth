import { expect, test } from "bun:test"

import {
  buildDiagnosticCases,
  runDiagnosticCase,
  summarizeDiagnosticResults,
  type DiagnosticCase,
  type DiagnosticResult,
} from "../src/diagnostics/stream-repro"

function buildSseResponse(text: string) {
  const body = [
    "event: response.output_text.delta\n",
    `data: ${JSON.stringify({ type: "response.output_text.delta", delta: text })}\n\n`,
    "event: response.completed\n",
    `data: ${JSON.stringify({ type: "response.completed", response: { id: "resp-test" } })}\n\n`,
  ].join("")

  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream; charset=utf-8" },
  })
}

test("buildDiagnosticCases includes fenced and control cases for a target markdown file", () => {
  const cases = buildDiagnosticCases("# Report\n\n| a | b |\n|---|---|\n| 1 | 2 |")

  expect(cases.map((item) => item.id)).toEqual([
    "small-fenced-markdown",
    "large-markdown-unfenced",
    "large-markdown-fenced",
    "file-tiny-output",
    "file-fenced-markdown",
  ])

  expect(cases[3]?.prompt).toContain("single word OK")
  expect(cases[4]?.prompt).toContain("fenced md code block")
  expect(cases[4]?.expectedOutcome).toBe("stream_failure")
})

test("summarizeDiagnosticResults reports a confirmed repro when only fenced large-output cases fail", () => {
  const results: DiagnosticResult[] = [
    { id: "small-fenced-markdown", expectedOutcome: "success", outcome: "success", responseBytes: 7000 },
    { id: "large-markdown-unfenced", expectedOutcome: "success", outcome: "success", responseBytes: 450000 },
    { id: "large-markdown-fenced", expectedOutcome: "stream_failure", outcome: "stream_failure", responseBytes: 2637 },
    { id: "file-tiny-output", expectedOutcome: "success", outcome: "success", responseBytes: 4000 },
    { id: "file-fenced-markdown", expectedOutcome: "stream_failure", outcome: "stream_failure", responseBytes: 2637 },
  ]

  const summary = summarizeDiagnosticResults(results)

  expect(summary.reproConfirmed).toBe(true)
  expect(summary.successCount).toBe(3)
  expect(summary.failureCount).toBe(2)
  expect(summary.notes).toContain("long fenced output")
})

test("summarizeDiagnosticResults still confirms the repro when fenced cases fail as transport errors", () => {
  const results: DiagnosticResult[] = [
    { id: "small-fenced-markdown", expectedOutcome: "success", outcome: "success", responseBytes: 7000 },
    { id: "large-markdown-unfenced", expectedOutcome: "success", outcome: "success", responseBytes: 450000 },
    { id: "large-markdown-fenced", expectedOutcome: "stream_failure", outcome: "transport_error", responseBytes: 2600 },
    { id: "file-tiny-output", expectedOutcome: "success", outcome: "success", responseBytes: 4000 },
    { id: "file-fenced-markdown", expectedOutcome: "stream_failure", outcome: "transport_error", responseBytes: 2600 },
  ]

  const summary = summarizeDiagnosticResults(results)

  expect(summary.reproConfirmed).toBe(true)
})

test("runDiagnosticCase requires both response.completed and expected output markers", async () => {
  const diagnosticCase: DiagnosticCase = {
    id: "control",
    prompt: "unused",
    expectedOutcome: "success",
    expectedOutputMarkers: ["OK"],
  }

  const result = await runDiagnosticCase("http://bridge.local", "oca/gpt-5.4", diagnosticCase, {
    fetchImpl: async () => buildSseResponse("WRONG") as Response,
  })

  expect(result.outcome).toBe("transport_error")
  expect(result.errorMessage).toContain("Missing expected output markers")
})

test("runDiagnosticCase times out instead of hanging forever", async () => {
  const diagnosticCase: DiagnosticCase = {
    id: "timeout",
    prompt: "unused",
    expectedOutcome: "success",
    expectedOutputMarkers: ["OK"],
  }

  let aborted = false

  const result = await runDiagnosticCase("http://bridge.local", "oca/gpt-5.4", diagnosticCase, {
    timeoutMs: 10,
    fetchImpl: (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          aborted = true
          reject(new Error("aborted"))
        })
      }),
  })

  expect(result.outcome).toBe("transport_error")
  expect(result.errorMessage).toContain("Timed out")
  expect(aborted).toBe(true)
})
