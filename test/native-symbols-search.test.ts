import { describe, expect, it } from "vitest"
import { Effect } from "effect"
import { createNativeTypeAnalyzer, isNativeRuntimeSupported } from "@skastr0/quartz-core"
import { createFixtureAnalyzer, fixturesPath } from "./helpers/analyzer"

describe.runIf(isNativeRuntimeSupported())("native symbols, file inspection, search, and compatibility", () => {
  it("matches morph envelopes across the P1c command tier", async () => {
    const morph = createFixtureAnalyzer()
    const native = createNativeTypeAnalyzer(fixturesPath)
    try {
      for (const options of [
        { pattern: "^User", limit: 50 },
        { kind: "function", file: "functions", limit: 8 },
        { pattern: "DefaultExportedClass", limit: 5 },
      ]) {
        const morphResult = await Effect.runPromise(morph.listSymbols(options))
        const nativeResult = await Effect.runPromise(native.analyzer.listSymbols(options))
        expect(nativeResult, `listSymbols(${JSON.stringify(options)})`).toEqual(morphResult)
      }

      for (const options of [
        {},
        { includePrivate: true },
        { symbol: "User|Role" },
      ]) {
        const morphResult = await Effect.runPromise(morph.getFileDeclarations("types/basic.ts", options))
        const nativeResult = await Effect.runPromise(native.analyzer.getFileDeclarations("types/basic.ts", options))
        expect(normalizeCompilerFormatting(nativeResult), `getFileDeclarations(${JSON.stringify(options)})`).toEqual(
          normalizeCompilerFormatting(morphResult),
        )
      }

      for (const options of [
        { pattern: "^User", limit: 10 },
        { hasProperty: "email", limit: 10 },
        { extends: "User", limit: 10 },
      ]) {
        const morphResult = await Effect.runPromise(morph.searchTypes(options))
        const nativeResult = await Effect.runPromise(native.analyzer.searchTypes(options))
        expect(normalizeSearchSemantics(nativeResult), `searchTypes(${JSON.stringify(options)})`).toEqual(
          normalizeSearchSemantics(morphResult),
        )
      }

      for (const [from, to] of [
        ["ExtendedUser", "User"],
        ["UserInput", "User"],
        ["Source6", "Target6"],
        ["MissingSymbol", "User"],
      ] as const) {
        const morphResult = await Effect.runPromise(morph.checkCompatibility(from, to))
        const nativeResult = await Effect.runPromise(native.analyzer.checkCompatibility(from, to))
        expect(normalizeCompilerFormatting(nativeResult), `checkCompatibility(${from}, ${to})`).toEqual(
          normalizeCompilerFormatting(morphResult),
        )
      }
    } finally {
      await native.dispose()
    }
  }, 30_000)
})

const normalizeCompilerFormatting = (value: unknown): unknown => {
  if (typeof value === "string" && value.includes(" | ")) return value.split(" | ").sort().join(" | ")
  if (Array.isArray(value)) return value.map(normalizeCompilerFormatting)
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, normalizeCompilerFormatting(nested)]))
  }
  return value
}

const normalizeSearchSemantics = (results: readonly import("@skastr0/quartz-core").TypeInfo[]) =>
  results.map((result) => ({
    name: result.name,
    kind: result.kind,
    location: result.location,
    package: result.package,
    properties: result.properties?.map((property) => ({ name: property.name, optional: property.optional })).sort((a, b) => a.name.localeCompare(b.name)),
  }))
