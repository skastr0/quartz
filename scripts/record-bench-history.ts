#!/usr/bin/env bun
/**
 * Append a bench report into docs/bench/history/ keyed by Quartz commit,
 * TypeScript nightly, machine/runtime, and profile/mode. Never ratchets debt
 * silently — history is evidence for investigating regressions.
 *
 * Usage: bun scripts/record-bench-history.ts --from .quartz/bench/pr-latest.json
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs"
import { dirname, join, resolve } from "node:path"

const REPO_ROOT = resolve(import.meta.dir, "..")
const HISTORY_DIR = join(REPO_ROOT, "docs/bench/history")

const args = process.argv.slice(2)
const fromIndex = args.indexOf("--from")
const source = resolve(fromIndex >= 0 ? args[fromIndex + 1]! : ".quartz/bench/pr-latest.json")

if (!existsSync(source)) {
  process.stderr.write(`Missing bench report: ${source}\n`)
  process.exit(2)
}

const report = JSON.parse(readFileSync(source, "utf8")) as {
  readonly schemaVersion: string
  readonly generatedAt: string
  readonly profile: string
  readonly quartzCommit: string | null
  readonly analysisTypescriptVersion: string
  readonly process: { readonly runtime: string; readonly platform: string; readonly arch: string; readonly hostname: string }
  readonly results: readonly { readonly mode: string; readonly command: string; readonly stats: { readonly p50Ms: number; readonly p95Ms: number } }[]
}

const commit = (report.quartzCommit ?? "unknown").slice(0, 12)
const stamp = report.generatedAt.replaceAll(":", "").replaceAll(".", "")
const fileName = `${stamp}-${report.profile}-${commit}-${report.analysisTypescriptVersion}.json`
mkdirSync(HISTORY_DIR, { recursive: true })
const destination = join(HISTORY_DIR, fileName)
writeFileSync(destination, `${JSON.stringify(report, null, 2)}\n`)

const indexPath = join(HISTORY_DIR, "index.jsonl")
const summary = {
  file: fileName,
  generatedAt: report.generatedAt,
  profile: report.profile,
  quartzCommit: report.quartzCommit,
  analysisTypescriptVersion: report.analysisTypescriptVersion,
  runtime: report.process.runtime,
  host: `${report.process.hostname}/${report.process.platform}-${report.process.arch}`,
  highlights: report.results.map((result) => ({
    mode: result.mode,
    command: result.command,
    p50Ms: result.stats.p50Ms,
    p95Ms: result.stats.p95Ms,
  })),
}
writeFileSync(indexPath, `${existsSync(indexPath) ? readFileSync(indexPath, "utf8") : ""}${JSON.stringify(summary)}\n`)
process.stdout.write(`${JSON.stringify({ ok: true, destination: destination.slice(REPO_ROOT.length + 1), index: "docs/bench/history/index.jsonl" }, null, 2)}\n`)
