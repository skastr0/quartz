import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import { createNativeTypeAnalyzer, isNativeRuntimeSupported } from "@skastr0/quartz-core"
import { createFixtureAnalyzer } from "./helpers/analyzer"

const fixturesRoot = join(dirname(fileURLToPath(import.meta.url)), "fixtures")

describe.runIf(isNativeRuntimeSupported())("native references, graph, and refactor parity", () => {
  it("returns related symbols from the same fixture as morph", async () => {
    const native = createNativeTypeAnalyzer(fixturesRoot)
    const morph = createFixtureAnalyzer()
    try {
      const [nativeResult, morphResult] = await Promise.all([
        Effect.runPromise(native.analyzer.findRelated("ExtendedUser")),
        Effect.runPromise(morph.findRelated("ExtendedUser")),
      ])
      expect(nativeResult?.symbol).toBe(morphResult?.symbol)
      expect(nativeResult?.references).toEqual(expect.arrayContaining([
        expect.objectContaining({ symbol: "User", context: "extends" }),
        expect.objectContaining({ symbol: "Role", context: 'property "role"' }),
      ]))
      expect(nativeResult?.referencedBy.length).toBeGreaterThan(0)
      expect(morphResult?.referencedBy.length).toBeGreaterThan(0)
    } finally {
      await native.dispose()
    }
  })

  it("composes a graph envelope from native related results", async () => {
    const native = createNativeTypeAnalyzer(fixturesRoot)
    const morph = createFixtureAnalyzer()
    try {
      const [nativeResult, morphResult] = await Promise.all([
        Effect.runPromise(native.analyzer.generateGraph("ExtendedUser", { depth: 2, format: "mermaid" })),
        Effect.runPromise(morph.generateGraph("ExtendedUser", { depth: 2, format: "mermaid" })),
      ])
      expect(nativeResult).toMatchObject({ root: morphResult?.root, format: "mermaid", depth: 2 })
      expect(nativeResult?.graph).toContain("graph TD")
      expect(nativeResult?.edges).toEqual(expect.arrayContaining([
        expect.objectContaining({ from: "ExtendedUser", to: "User", label: "extends" }),
      ]))
    } finally {
      await native.dispose()
    }
  })

  it("previews identifier renames using native reference sites", async () => {
    const native = createNativeTypeAnalyzer(fixturesRoot)
    const morph = createFixtureAnalyzer()
    try {
      const [nativeResult, morphResult] = await Promise.all([
        Effect.runPromise(native.analyzer.previewRefactor({ action: "rename", symbol: "RefactorUser", to: "RenamedUser" })),
        Effect.runPromise(morph.previewRefactor({ action: "rename", symbol: "RefactorUser", to: "RenamedUser" })),
      ])
      expect(nativeResult).toMatchObject({ action: "rename", from: morphResult.from, to: morphResult.to })
      expect(nativeResult.totalLocations).toBe(morphResult.totalLocations)
      expect(nativeResult.locations).toEqual(expect.arrayContaining([
        expect.objectContaining({ file: "types/refactor.ts", line: 12 }),
        expect.objectContaining({ file: "types/refactor.ts", line: 26 }),
      ]))
    } finally {
      await native.dispose()
    }
  })
})
