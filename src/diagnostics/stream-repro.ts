export type DiagnosticExpectedOutcome = "success" | "stream_failure"

export type DiagnosticCase = {
  id: string
  prompt: string
  expectedOutcome: DiagnosticExpectedOutcome
  expectedOutputMarkers?: string[]
}

export type DiagnosticOutcome = "success" | "stream_failure" | "http_error" | "transport_error"

export type DiagnosticResult = {
  id: string
  expectedOutcome: DiagnosticExpectedOutcome
  outcome: DiagnosticOutcome
  responseBytes: number
  status?: number
  errorMessage?: string
}

export type DiagnosticSummary = {
  reproConfirmed: boolean
  successCount: number
  failureCount: number
  notes: string
}

type RunDiagnosticCaseDeps = {
  fetchImpl?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
  timeoutMs?: number
}

function buildLargeMarkdownSample() {
  return "# synthetic\n\n" + "| a | b | c |\n|---|---|---|\n| 1 | 2 | 3 |\n".repeat(120)
}

function byteLength(value: string) {
  return new TextEncoder().encode(value).length
}

function extractStreamText(body: string) {
  let sawCompleted = false
  let combined = ""
  let sawDelta = false

  for (const line of body.split("\n")) {
    if (!line.startsWith("data:")) continue
    const raw = line.slice(5).trim()
    if (!raw.startsWith("{")) continue

    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      continue
    }

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue
    const record = parsed as Record<string, unknown>
    const type = typeof record.type === "string" ? record.type : undefined

    if (type === "response.completed") {
      sawCompleted = true
      continue
    }

    if (type === "response.output_text.delta" && typeof record.delta === "string") {
      combined += record.delta
      sawDelta = true
      continue
    }

    if (!sawDelta && type === "response.output_text.done" && typeof record.text === "string") {
      combined = record.text
    }
  }

  return { sawCompleted, combined }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string) {
  return withTimeoutCleanup(promise, timeoutMs, label)
}

async function withTimeoutCleanup<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
  onTimeout?: () => void,
) {
  let timeoutId: ReturnType<typeof setTimeout> | undefined
  const timeoutPromise = new Promise<T>((_, reject) => {
    timeoutId = setTimeout(() => {
      onTimeout?.()
      reject(new Error(`Timed out while ${label} after ${timeoutMs}ms`))
    }, timeoutMs)
  })

  try {
    return await Promise.race([promise, timeoutPromise])
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId)
  }
}

async function readResponseText(response: Response, timeoutMs: number, label: string) {
  if (!response.body) return withTimeout(response.text(), timeoutMs, label)

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let body = ""

  while (true) {
    const chunk = await withTimeoutCleanup(reader.read(), timeoutMs, label, () => {
      void reader.cancel("timeout")
    })

    if (chunk.done) break
    body += decoder.decode(chunk.value, { stream: true })
  }

  body += decoder.decode()
  return body
}

export function buildDiagnosticCases(fileMarkdown: string): DiagnosticCase[] {
  const largeMarkdown = buildLargeMarkdownSample()

  return [
    {
      id: "small-fenced-markdown",
      expectedOutcome: "success",
      prompt: "Return exactly this markdown in a fenced md code block and nothing else:\n\n# hello\n\n- one\n- two",
      expectedOutputMarkers: ["```md", "# hello", "- one", "- two"],
    },
    {
      id: "large-markdown-unfenced",
      expectedOutcome: "success",
      prompt: `Return exactly this content and nothing else:\n\n${largeMarkdown}`,
      expectedOutputMarkers: ["# synthetic", "| a | b | c |"],
    },
    {
      id: "large-markdown-fenced",
      expectedOutcome: "stream_failure",
      prompt: `Return exactly this markdown in a fenced md code block and nothing else:\n\n${largeMarkdown}`,
    },
    {
      id: "file-tiny-output",
      expectedOutcome: "success",
      prompt: `Read this markdown and answer with exactly the single word OK. Do not quote it.\n\n${fileMarkdown}`,
      expectedOutputMarkers: ["OK"],
    },
    {
      id: "file-fenced-markdown",
      expectedOutcome: "stream_failure",
      prompt: `Return exactly this markdown in a fenced md code block and nothing else:\n\n${fileMarkdown}`,
    },
  ]
}

export function summarizeDiagnosticResults(results: DiagnosticResult[]): DiagnosticSummary {
  const successCount = results.filter((result) => result.outcome === "success").length
  const failureCount = results.length - successCount

  const controlsPassed = ["small-fenced-markdown", "large-markdown-unfenced", "file-tiny-output"].every((id) =>
    results.some((result) => result.id === id && result.outcome === "success"),
  )

  const fencedFailures = ["large-markdown-fenced", "file-fenced-markdown"].every((id) =>
    results.some(
      (result) =>
        result.id === id && (result.outcome === "stream_failure" || result.outcome === "transport_error"),
    ),
  )

  const reproConfirmed = controlsPassed && fencedFailures
  const notes = reproConfirmed
    ? "Repro confirmed: long fenced output fails while control cases succeed."
    : "Repro not cleanly confirmed: inspect individual case outcomes."

  return { reproConfirmed, successCount, failureCount, notes }
}

export async function runDiagnosticCase(
  baseUrl: string,
  model: string,
  diagnosticCase: DiagnosticCase,
  deps: RunDiagnosticCaseDeps = {},
): Promise<DiagnosticResult> {
  const fetchImpl = deps.fetchImpl ?? fetch
  const timeoutMs = deps.timeoutMs ?? 30_000
  const controller = new AbortController()

  try {
    const response = await withTimeoutCleanup(
      fetchImpl(`${baseUrl.replace(/\/+$/, "")}/v1/responses`, {
        method: "POST",
        signal: controller.signal,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model,
          stream: true,
          input: [{ role: "user", content: [{ type: "input_text", text: diagnosticCase.prompt }] }],
        }),
      }),
      timeoutMs,
      `waiting for ${diagnosticCase.id} response`,
      () => controller.abort(new Error(`Timed out while waiting for ${diagnosticCase.id} response after ${timeoutMs}ms`)),
    )

    if (!response.ok) {
      const text = await readResponseText(response, timeoutMs, `reading ${diagnosticCase.id} HTTP error body`)
      return {
        id: diagnosticCase.id,
        expectedOutcome: diagnosticCase.expectedOutcome,
        outcome: "http_error",
        responseBytes: byteLength(text),
        status: response.status,
        errorMessage: text,
      }
    }

    try {
      const text = await readResponseText(response, timeoutMs, `reading ${diagnosticCase.id} stream body`)
      const { sawCompleted, combined } = extractStreamText(text)
      const markers = diagnosticCase.expectedOutputMarkers ?? []
      const missingMarkers = markers.filter((marker) => !combined.includes(marker))
      const isSuccess = sawCompleted && missingMarkers.length === 0

      return {
        id: diagnosticCase.id,
        expectedOutcome: diagnosticCase.expectedOutcome,
        outcome: isSuccess ? "success" : "transport_error",
        responseBytes: byteLength(text),
        status: response.status,
        errorMessage: isSuccess
          ? undefined
          : !sawCompleted
            ? "Missing response.completed event"
            : `Missing expected output markers: ${missingMarkers.join(", ")}`,
      }
    } catch (error) {
      return {
        id: diagnosticCase.id,
        expectedOutcome: diagnosticCase.expectedOutcome,
        outcome: "stream_failure",
        responseBytes: 0,
        status: response.status,
        errorMessage: error instanceof Error ? error.message : String(error),
      }
    }
  } catch (error) {
    const abortedReason = controller.signal.aborted
      ? controller.signal.reason instanceof Error
        ? controller.signal.reason.message
        : String(controller.signal.reason)
      : undefined

    return {
      id: diagnosticCase.id,
      expectedOutcome: diagnosticCase.expectedOutcome,
      outcome: "transport_error",
      responseBytes: 0,
      errorMessage: abortedReason ?? (error instanceof Error ? error.message : String(error)),
    }
  }
}
