#!/usr/bin/env bun

import { readFile } from "node:fs/promises"

import {
  buildDiagnosticCases,
  runDiagnosticCase,
  summarizeDiagnosticResults,
  type DiagnosticResult,
} from "../src/diagnostics/stream-repro"

const filePath = process.argv[2] ?? "claude_suggestions.md"
const baseUrl = process.env.BRIDGE_BASE_URL ?? "http://127.0.0.1:8787"
const model = process.env.BRIDGE_MODEL ?? "oca/gpt-5.4"

async function main() {
  const fileMarkdown = await readFile(filePath, "utf8")
  const cases = buildDiagnosticCases(fileMarkdown)

  console.log(`[diag] bridge=${baseUrl}`)
  console.log(`[diag] model=${model}`)
  console.log(`[diag] file=${filePath}`)

  const results: DiagnosticResult[] = []
  for (const diagnosticCase of cases) {
    console.log(`\n[diag] case=${diagnosticCase.id} expected=${diagnosticCase.expectedOutcome}`)
    const result = await runDiagnosticCase(baseUrl, model, diagnosticCase)
    results.push(result)
    console.log(
      `[diag] outcome=${result.outcome} bytes=${result.responseBytes}${result.status ? ` status=${result.status}` : ""}${result.errorMessage ? ` error=${result.errorMessage}` : ""}`,
    )
  }

  const summary = summarizeDiagnosticResults(results)
  console.log(`\n[diag] success=${summary.successCount} failure=${summary.failureCount}`)
  console.log(`[diag] ${summary.notes}`)
  process.exit(summary.reproConfirmed ? 0 : 1)
}

main().catch((error) => {
  console.error(`[diag] fatal=${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
