import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import {
  createAnalyzerRuntime,
  isNativeRuntimeSupported,
} from "@skastr0/quartz-core"

const here = dirname(fileURLToPath(import.meta.url))
const fixturesRoot = join(here, "fixtures")

describe.runIf(isNativeRuntimeSupported())("native diagnostics and position commands", () => {
  it("matches morph diagnostics on the shared fixture", async () => {
    const morph = createAnalyzerRuntime(fixturesRoot, { QUARTZ_ENGINE: "morph" })
    const native = createAnalyzerRuntime(fixturesRoot, { QUARTZ_ENGINE: "native" })
    try {
      const [morphDiagnostics, nativeDiagnostics] = await Promise.all([
        Effect.runPromise(morph.analyzer.getDiagnostics()),
        Effect.runPromise(native.analyzer.getDiagnostics()),
      ])
      expect(nativeDiagnostics).toEqual(morphDiagnostics)
    } finally {
      await Promise.all([morph.dispose(), native.dispose()])
    }
  })

  it("matches morph type-at-position data on the shared fixture", async () => {
    const morph = createAnalyzerRuntime(fixturesRoot, { QUARTZ_ENGINE: "morph" })
    const native = createAnalyzerRuntime(fixturesRoot, { QUARTZ_ENGINE: "native" })
    try {
      const [morphResult, nativeResult] = await Promise.all([
        Effect.runPromise(morph.analyzer.getTypeAtPosition("types/basic.ts", 9, 3)),
        Effect.runPromise(native.analyzer.getTypeAtPosition("types/basic.ts", 9, 3)),
      ])
      expect(nativeResult).toEqual(morphResult)
    } finally {
      await Promise.all([morph.dispose(), native.dispose()])
    }
  })
})
