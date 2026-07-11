import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { Effect } from "effect"
import { createNativeTypeAnalyzer, isNativeRuntimeSupported } from "@skastr0/quartz-core"

const fixturesRoot = join(dirname(fileURLToPath(import.meta.url)), "fixtures")

describe.runIf(isNativeRuntimeSupported())("native composed commands", () => {
  it("explains assignability diagnostics with native compatibility evidence", async () => {
    const native = createNativeTypeAnalyzer(fixturesRoot)
    try {
      const result = await Effect.runPromise(native.analyzer.explainError({
        code: 2322,
        message: "Type 'UserInput' is not assignable to type 'User'. Property 'id' is missing in type 'UserInput' but required in type 'User'.",
      }))

      expect(result?.explanation).toContain("UserInput")
      expect(result?.issues).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: "missing_property", property: "id" }),
      ]))
      expect(result?.suggestions.length).toBeGreaterThan(0)
    } finally {
      await native.dispose()
    }
  })

  it("composes contract evidence from native compatibility, snippets, diagnostics, and transforms", async () => {
    const native = createNativeTypeAnalyzer(fixturesRoot)
    try {
      const result = await Effect.runPromise(native.analyzer.verifyContract({
        from: "User",
        to: "UserDTO",
        symbol: "toDTO",
        snippet: "const user: User = { id: '1', name: 'Ada', email: 'ada@example.com' }; const dto: UserDTO = toDTO(user);",
      }))

      expect(result).toMatchObject({
        schemaVersion: "verify-contract/v1",
        ok: true,
        contract: { from: "User", to: "UserDTO", symbol: "toDTO" },
        checks: {
          compatibility: { ran: true, passed: false, blocking: false },
          snippet: { ran: true, passed: true, blocking: true },
          diagnostics: { ran: true, passed: true, blocking: true },
          transform: { ran: true, passed: true, blocking: true },
        },
      })
      expect(result.evidence.transformSearch?.results[0]).toMatchObject({
        name: expect.stringContaining("toDTO"),
        verification: { status: "verified" },
      })
    } finally {
      await native.dispose()
    }
  }, 30_000)
})
