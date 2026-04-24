import { describe, expect, it } from "vitest"
import { Effect } from "effect"
import { createFixtureAnalyzer, fixturesPath } from "./helpers/analyzer"

describe("type analyzer core", () => {
  it("discovers TypeScript packages", async () => {
    const analyzer = createFixtureAnalyzer()
    const packages = await Effect.runPromise(analyzer.getPackages())

    expect(packages).toHaveLength(1)
    expect(packages[0]).toMatchObject({
      name: "(root)",
      path: fixturesPath,
    })
  })

  it("lists exported symbols with filters", async () => {
    const analyzer = createFixtureAnalyzer()
    const result = await Effect.runPromise(analyzer.listSymbols({ pattern: "^User", limit: 50 }))

    const names = result.symbols.map((symbol) => symbol.name)
    expect(names).toContain("User")
    expect(names).toContain("UserInput")
    expect(names).not.toContain("InternalConfig")
    expect(result.truncated).toBe(false)
  })

  it("returns type info and expanded properties for interfaces", async () => {
    const analyzer = createFixtureAnalyzer()
    const info = await Effect.runPromise(analyzer.getTypeInfo("User"))
    const expanded = await Effect.runPromise(analyzer.expandType("User"))

    expect(info).not.toBeNull()
    expect(info?.kind).toBe("interface")
    expect(info?.properties).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "id", type: "string", optional: false }),
        expect.objectContaining({ name: "name", type: "string", optional: false }),
      ]),
    )
    expect(expanded?.properties.map((property) => property.name)).toContain("email")
  })

  it("returns null for non-exported symbols", async () => {
    const analyzer = createFixtureAnalyzer()
    const info = await Effect.runPromise(analyzer.getTypeInfo("InternalConfig"))

    expect(info).toBeNull()
  })

  it("searches types by exported symbol name", async () => {
    const analyzer = createFixtureAnalyzer()
    const results = await Effect.runPromise(analyzer.searchTypes({ query: "Role" }))

    expect(results.map((result) => result.name)).toContain("Role")
  })

  it("returns the type at a source position", async () => {
    const analyzer = createFixtureAnalyzer()
    const result = await Effect.runPromise(analyzer.getTypeAtPosition("types/basic.ts", 9, 3))

    expect(result).not.toBeNull()
    expect(result?.type).toBe("string")
  })
})

