import { describe, expect, it } from "vitest"
import { Effect } from "effect"
import { createNativeTypeAnalyzer, isNativeRuntimeSupported } from "@skastr0/quartz-core"
import { fixturesPath } from "./helpers/analyzer"

const search = async (
  analyzer: ReturnType<typeof createNativeTypeAnalyzer>["analyzer"],
  options: Parameters<ReturnType<typeof createNativeTypeAnalyzer>["analyzer"]["transformSearch"]>[0],
) => JSON.parse(await Effect.runPromise(analyzer.transformSearch(options))) as {
  results: Array<{
    name: string
    verification: { status: string; method: string | null; reason: string; syntheticCode?: string }
  }>
  stats: { verification: Record<string, number> }
}

describe.runIf(isNativeRuntimeSupported())("native transform search", () => {
  it("finds cross-file transforms with native assignability", async () => {
    const native = createNativeTypeAnalyzer(fixturesPath)
    try {
      const result = await search(native.analyzer, { from: "User", to: "UserDTO", limit: 20 })
      expect(result.results.map((item) => item.name)).toContain("toDTO")
      expect(result.results.every((item) => ["verified", "unverified", "unverifiable"].includes(item.verification.status))).toBe(true)
    } finally {
      await native.dispose()
    }
  }, 30_000)

  it("uses native array assignability without morph fallback heuristics", async () => {
    const native = createNativeTypeAnalyzer(fixturesPath)
    try {
      const result = await search(native.analyzer, { from: "User[]", to: "string[]", limit: 20 })
      expect(result.results.map((item) => item.name)).toContain("extractIds")
    } finally {
      await native.dispose()
    }
  }, 30_000)

  it("verifies structural queries on the native VFS", async () => {
    const native = createNativeTypeAnalyzer(fixturesPath)
    try {
      const result = await search(native.analyzer, {
        from: "{ id: string; name: string; email: string }",
        to: "UserDTO",
        includeSyntheticCode: true,
        verifiedOnly: true,
        limit: 20,
      })
      const match = result.results.find((item) => item.name === "toDTO")
      expect(match?.verification).toMatchObject({ status: "verified", method: "synthetic" })
      expect(match?.verification.syntheticCode).toContain("__QuartzFrom__")
    } finally {
      await native.dispose()
    }
  }, 30_000)
})
