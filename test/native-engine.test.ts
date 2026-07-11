import { execSync } from "node:child_process"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { Effect, Either } from "effect"
import {
  analysisTypescriptVersionFor,
  createAnalyzerRuntime,
  createNativeEngine,
  createNativeTypeAnalyzer,
  isNativeRuntimeSupported,
  nativeAnalysisTypescriptVersion,
  resolveRequestedEngine,
  selectEngine,
} from "@skastr0/quartz-core"

const here = dirname(fileURLToPath(import.meta.url))
const fixturesRoot = join(here, "fixtures")
const fixtureTsconfig = join(fixturesRoot, "tsconfig.json")

/** Count direct child processes of the test worker — the native server spawns as one. */
const childProcessCount = (): number => {
  try {
    return execSync(`pgrep -P ${process.pid}`, { encoding: "utf8" }).trim().split("\n").filter(Boolean).length
  } catch {
    return 0
  }
}

const waitForChildCount = async (atMost: number, timeoutMs = 5000): Promise<number> => {
  const deadline = Date.now() + timeoutMs
  let count = childProcessCount()
  while (count > atMost && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50))
    count = childProcessCount()
  }
  return count
}

// The native sync API spawns tsgo and reads Node-only child-process fds, so it
// only runs under Node. Vitest runs under Node; guard anyway so the suite stays
// honest on any other runtime rather than failing spuriously.
describe.runIf(isNativeRuntimeSupported())("native engine (smoke)", () => {
  it("loads a fixture project, runs diagnostics, and disposes without leaking a child process", async () => {
    const baseline = childProcessCount()
    const engine = createNativeEngine(fixturesRoot)
    try {
      const program = engine.getProgram(fixtureTsconfig)

      const semantic = program.getSemanticDiagnostics()
      const syntactic = program.getSyntacticDiagnostics()
      // Diagnostics ran (returned real arrays); the valid fixtures produce none.
      expect(Array.isArray(semantic)).toBe(true)
      expect(Array.isArray(syntactic)).toBe(true)
      expect(syntactic).toHaveLength(0)

      const sourceFiles = program.getSourceFileNames().filter((file) => !file.includes("node_modules"))
      expect(sourceFiles.some((file) => file.endsWith("basic.ts"))).toBe(true)

      // A server child was spawned to serve the analysis.
      expect(childProcessCount()).toBeGreaterThan(baseline)
    } finally {
      engine.dispose()
    }

    // dispose() closed the server; the child is reaped back to baseline.
    const after = await waitForChildCount(baseline)
    expect(after).toBeLessThanOrEqual(baseline)
  })

  it("reports the pinned nightly as its analysis TypeScript version", () => {
    const version = nativeAnalysisTypescriptVersion()
    expect(version.startsWith("7.")).toBe(true)
    expect(analysisTypescriptVersionFor("native")).toBe(version)
  })
})

describe("native analyzer command surface", () => {
  it("delegates package discovery for real (engine-agnostic)", async () => {
    const handle = createNativeTypeAnalyzer(fixturesRoot)
    try {
      const packages = await Effect.runPromise(handle.analyzer.getPackages())
      expect(packages.length).toBeGreaterThanOrEqual(1)
      expect(packages.some((pkg) => pkg.tsconfigPath === fixtureTsconfig)).toBe(true)
    } finally {
      await handle.dispose()
    }
  })

  it("returns an engine-not-supported error for unimplemented type-analysis commands", async () => {
    const handle = createNativeTypeAnalyzer(fixturesRoot)
    try {
      const outcome = await Effect.runPromise(Effect.either(handle.analyzer.listSymbols()))
      expect(Either.isLeft(outcome)).toBe(true)
      if (Either.isLeft(outcome)) {
        expect(outcome.left.message).toContain("does not yet support")
        expect((outcome.left.cause as { kind?: string } | undefined)?.kind).toBe("engine-not-supported")
      }
    } finally {
      await handle.dispose()
    }
  })
})

describe("engine selection", () => {
  it("defaults to morph and reads QUARTZ_ENGINE=native (trimmed, case-insensitive)", () => {
    expect(resolveRequestedEngine({})).toBe("morph")
    expect(resolveRequestedEngine({ QUARTZ_ENGINE: "native" })).toBe("native")
    expect(resolveRequestedEngine({ QUARTZ_ENGINE: "  NATIVE  " })).toBe("native")
    expect(resolveRequestedEngine({ QUARTZ_ENGINE: "morph" })).toBe("morph")
    expect(resolveRequestedEngine({ QUARTZ_ENGINE: "totally-bogus" })).toBe("morph")
  })

  it("falls back to morph when native is requested on an unsupported runtime", () => {
    const fallback = selectEngine({ requestedEngine: "native", nativeRuntimeSupported: false })
    expect(fallback).toMatchObject({ engine: "morph", requestedEngine: "native", fellBack: true })
    expect(fallback.fallbackReason).toBeDefined()

    const supported = selectEngine({ requestedEngine: "native", nativeRuntimeSupported: true })
    expect(supported).toMatchObject({ engine: "native", requestedEngine: "native", fellBack: false })

    const morph = selectEngine({ requestedEngine: "morph", nativeRuntimeSupported: true })
    expect(morph).toMatchObject({ engine: "morph", requestedEngine: "morph", fellBack: false })
  })

  it("constructs the morph engine by default and reports the ts-morph analysis version", async () => {
    const runtime = createAnalyzerRuntime(fixturesRoot, {})
    try {
      expect(runtime.meta.engine).toBe("morph")
      expect(runtime.meta.fellBack).toBe(false)
      expect(runtime.meta.analysisTypescriptVersion).toBe(analysisTypescriptVersionFor("morph"))
    } finally {
      await runtime.dispose()
    }
  })

  it.runIf(isNativeRuntimeSupported())(
    "constructs the native engine when requested on a supported runtime",
    async () => {
      const runtime = createAnalyzerRuntime(fixturesRoot, { QUARTZ_ENGINE: "native" })
      try {
        expect(runtime.meta.engine).toBe("native")
        expect(runtime.meta.requestedEngine).toBe("native")
        expect(runtime.meta.fellBack).toBe(false)
        expect(runtime.meta.analysisTypescriptVersion.startsWith("7.")).toBe(true)
      } finally {
        await runtime.dispose()
      }
    },
  )
})

describe.runIf(isNativeRuntimeSupported())("native vs morph parity (check-snippet + eval-type)", () => {
  const runBoth = async <A>(
    run: (analyzer: import("@skastr0/quartz-core").TypeAnalyzer) => Effect.Effect<A, import("@skastr0/quartz-core").QuartzError>,
  ): Promise<{ morph: A; native: A }> => {
    const morph = createAnalyzerRuntime(fixturesRoot, { QUARTZ_ENGINE: "morph" })
    const native = createNativeTypeAnalyzer(fixturesRoot)
    try {
      const [morphResult, nativeResult] = await Promise.all([
        Effect.runPromise(run(morph.analyzer)),
        Effect.runPromise(run(native.analyzer)),
      ])
      return { morph: morphResult, native: nativeResult }
    } finally {
      await morph.dispose()
      await native.dispose()
    }
  }

  it("checkSnippet returns morph-shaped envelopes for valid snippets", async () => {
    const result = await runBoth((analyzer) => analyzer.checkSnippet("const x: string = 'hello';"))

    expect(result.morph.valid).toBe(true)
    expect(result.native.valid).toBe(true)
  })

  it("checkSnippet returns morph-shaped envelopes for invalid snippets", async () => {
    const result = await runBoth((analyzer) => analyzer.checkSnippet("const x: string = 42;"))

    expect(result.morph.valid).toBe(false)
    expect(result.native.valid).toBe(false)
    expect(result.morph.errors?.length).toBeGreaterThan(0)
    expect(result.native.errors?.length).toBeGreaterThan(0)
    expect(result.native.errors?.[0]).toMatchObject({
      message: expect.any(String),
      line: expect.any(Number),
      column: expect.any(Number),
      severity: "error",
    })
  })

  it("checkSnippet resolves package symbols in user code", async () => {
    const result = await runBoth((analyzer) =>
      analyzer.checkSnippet("const u: User = { id: '1', name: 'Ada', email: 'ada@example.com' };"),
    )

    expect(result.morph.valid).toBe(true)
    expect(result.native.valid).toBe(true)
  })

  it("evalType returns morph-shaped results for package symbols", async () => {
    const result = await runBoth((analyzer) => analyzer.evalType('Pick<User, "id" | "name">'))

    expect("error" in result.morph).toBe(false)
    expect("error" in result.native).toBe(false)
    const morphResult = result.morph as { result: string; expanded: string }
    const nativeResult = result.native as { result: string; expanded: string }
    expect(morphResult.result).toContain("id")
    expect(nativeResult.result).toContain("id")
    expect(nativeResult.expanded).toContain("id")
    expect(nativeResult.expanded).toContain("string")
  })

  it("evalType reports errors for expressions referencing non-exported symbols", async () => {
    const result = await runBoth((analyzer) => analyzer.evalType("InternalConfig"))

    // Native is stricter than morph here: it surfaces the semantic diagnostic as
    // an error rather than returning the unresolved type text. Morph may return
    // a result for the same input; that difference is classified by the parity
    // harness as a native improvement.
    expect("error" in result.native).toBe(true)
  })
})
