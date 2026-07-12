/**
 * Native ↔ ts-morph wall-clock benchmark.
 *
 * Times four commands — diagnostics, expand, check-snippet, transform-search —
 * through BOTH engines against an in-repo project, N warm runs each, reporting
 * the median milliseconds per engine and the native speedup (morph / native;
 * > 1 means native is faster).
 *
 * The numbers are the deliverable — never estimate them; run this and paste the
 * medians. If native underdelivers (< 2×) on a command, the report says so.
 *
 * WARMING: each engine is constructed once and each command is run WARMUP times
 * untimed before the timed runs, so the tsgo project load / ts-morph project
 * build and the compiler's first-call caches are paid before measurement — the
 * medians reflect steady-state cost, not one-time load.
 *
 * RUNTIME: like the parity harness, native only runs under Node with an
 * unbundled typescript/unstable client. Run under the repo's Vitest/Vite host.
 */
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { performance } from "node:perf_hooks"
import { Effect, Exit } from "effect"
import {
  createAnalyzerRuntime,
  createNativeTypeAnalyzer,
  isNativeRuntimeSupported,
  nativeAnalysisTypescriptVersion,
  analysisTypescriptVersionFor,
  type QuartzError,
  type TypeAnalyzer,
} from "@skastr0/quartz-core"

const WARMUP = 2
const TIMED = 5
const SPEEDUP_TARGET = 2

export interface CommandBench {
  readonly command: string
  readonly morphMs: number
  readonly nativeMs: number
  readonly speedup: number
  readonly meetsTarget: boolean
  readonly morphSamples: readonly number[]
  readonly nativeSamples: readonly number[]
}

export interface BenchReport {
  readonly root: string
  readonly warmup: number
  readonly timed: number
  readonly speedupTarget: number
  readonly morphAnalysisTypescriptVersion: string
  readonly nativeAnalysisTypescriptVersion: string
  readonly results: readonly CommandBench[]
}

interface BenchCommand {
  readonly command: string
  readonly run: (a: TypeAnalyzer) => Effect.Effect<unknown, QuartzError>
}

const commands: readonly BenchCommand[] = [
  { command: "diagnostics", run: (a) => a.getDiagnostics() },
  { command: "expand", run: (a) => a.expandType("User") },
  { command: "check-snippet", run: (a) => a.checkSnippet("const x: string = 42;") },
  { command: "transform-search", run: (a) => a.transformSearch({ from: "User", to: "UserDTO", limit: 5 }) },
]

const runOrThrow = async (
  label: string,
  analyzer: TypeAnalyzer,
  run: (a: TypeAnalyzer) => Effect.Effect<unknown, QuartzError>,
): Promise<void> => {
  const exit = await Effect.runPromiseExit(run(analyzer))
  if (Exit.isFailure(exit)) {
    throw new Error(`bench command failed (${label}): ${JSON.stringify(exit.cause)}`)
  }
}

const median = (samples: readonly number[]): number => {
  const sorted = [...samples].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  if (sorted.length === 0) return Number.NaN
  return sorted.length % 2 === 0 ? ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2 : (sorted[mid] as number)
}

const round = (value: number): number => Math.round(value * 1000) / 1000

const timeCommand = async (
  label: string,
  analyzer: TypeAnalyzer,
  run: (a: TypeAnalyzer) => Effect.Effect<unknown, QuartzError>,
): Promise<number[]> => {
  for (let i = 0; i < WARMUP; i += 1) await runOrThrow(label, analyzer, run)
  const samples: number[] = []
  for (let i = 0; i < TIMED; i += 1) {
    const start = performance.now()
    await runOrThrow(label, analyzer, run)
    samples.push(performance.now() - start)
  }
  return samples
}

export const runBench = async (rootDirectory: string): Promise<BenchReport> => {
  const root = resolve(rootDirectory)
  if (!isNativeRuntimeSupported()) {
    throw new Error(
      "Native runtime is unavailable here (native requires Node with an unbundled typescript/unstable client). " +
        "Run this benchmark under the repo's Vitest/Vite host, not under Bun.",
    )
  }

  const morph = createAnalyzerRuntime(root, { QUARTZ_ENGINE: "morph" })
  const native = createNativeTypeAnalyzer(root)

  const results: CommandBench[] = []
  try {
    for (const benchCommand of commands) {
      const morphSamples = await timeCommand(`morph:${benchCommand.command}`, morph.analyzer, benchCommand.run)
      const nativeSamples = await timeCommand(`native:${benchCommand.command}`, native.analyzer, benchCommand.run)
      const morphMs = round(median(morphSamples))
      const nativeMs = round(median(nativeSamples))
      const speedup = nativeMs === 0 ? Number.POSITIVE_INFINITY : round(morphMs / nativeMs)
      results.push({
        command: benchCommand.command,
        morphMs,
        nativeMs,
        speedup,
        meetsTarget: speedup >= SPEEDUP_TARGET,
        morphSamples: morphSamples.map(round),
        nativeSamples: nativeSamples.map(round),
      })
    }
  } finally {
    await morph.dispose()
    await native.dispose()
  }

  return {
    root,
    warmup: WARMUP,
    timed: TIMED,
    speedupTarget: SPEEDUP_TARGET,
    morphAnalysisTypescriptVersion: analysisTypescriptVersionFor("morph"),
    nativeAnalysisTypescriptVersion: nativeAnalysisTypescriptVersion(),
    results,
  }
}

const isEntrypoint = (): boolean => {
  const invoked = process.argv[1]
  return invoked !== undefined && import.meta.url === pathToFileURL(invoked).href
}

if (isEntrypoint()) {
  const root = process.argv[2] ?? resolve("test/fixtures")
  runBench(root)
    .then((report) => {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
    })
    .catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
      process.exitCode = 2
    })
}
