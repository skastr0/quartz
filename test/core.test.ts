import { describe, expect, it } from "vitest"
import { Effect } from "effect"
import { createTypeAnalyzer } from "@skastr0/quartz-core"
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

  it("normalizes relative roots before comparing source paths", async () => {
    const analyzer = createTypeAnalyzer("test/fixtures")
    const result = await Effect.runPromise(analyzer.listSymbols({ pattern: "^User", limit: 50 }))

    expect(result.symbols.map((symbol) => symbol.name)).toContain("User")
  })

  it("accepts package path suffix selectors", async () => {
    const analyzer = createTypeAnalyzer(".")
    const info = await Effect.runPromise(analyzer.getTypeInfo("User", "fixtures"))

    expect(info).toMatchObject({ name: "User", package: "test/fixtures" })
  })

  it("preserves the public 100 symbol default", async () => {
    const analyzer = createFixtureAnalyzer()
    const result = await Effect.runPromise(analyzer.listSymbols())

    expect(result.symbols).toHaveLength(100)
    expect(result.truncated).toBe(true)
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

  it("omits noisy library prototype properties from search results", async () => {
    const analyzer = createFixtureAnalyzer()
    const results = await Effect.runPromise(analyzer.searchTypes({ query: "AdminOrUser", limit: 1 }))

    expect(results[0]).toMatchObject({ name: "AdminOrUser" })
    expect(results[0]?.properties).toBeUndefined()
  })

  it("finds related symbols", async () => {
    const analyzer = createFixtureAnalyzer()
    const related = await Effect.runPromise(analyzer.findRelated("User"))

    expect(related?.symbol).toBe("User")
    expect(related?.referencedBy.length).toBeGreaterThan(0)
  })

  it("evaluates and explains type expressions", async () => {
    const analyzer = createFixtureAnalyzer()
    const evaluated = await Effect.runPromise(analyzer.evalType('Pick<User, "id" | "name">'))
    const explained = await Effect.runPromise(analyzer.explainType('Pick<User, "id" | "name">'))

    expect(JSON.stringify(evaluated)).toContain("id")
    expect(explained.final).toContain("id")
    expect(explained.steps.length).toBeGreaterThan(0)
  })

  it("checks compatibility and snippets", async () => {
    const analyzer = createFixtureAnalyzer()
    const compatible = await Effect.runPromise(analyzer.checkCompatibility("ExtendedUser", "User"))
    const invalidSnippet = await Effect.runPromise(analyzer.checkSnippet("const x: string = 42;"))

    expect(compatible.compatible).toBe(true)
    expect(invalidSnippet.valid).toBe(false)
    expect(invalidSnippet.errors?.length).toBeGreaterThan(0)
  })

  it("inspects files, graphs relationships, and previews refactors", async () => {
    const analyzer = createFixtureAnalyzer()
    const file = await Effect.runPromise(analyzer.getFileDeclarations("types/basic.ts"))
    const graph = await Effect.runPromise(analyzer.generateGraph("ExtendedUser"))
    const refactor = await Effect.runPromise(
      analyzer.previewRefactor({ action: "rename", symbol: "RefactorUser", to: "RenamedUser" }),
    )

    expect(file?.declarations.map((declaration) => declaration.name)).toContain("User")
    expect(graph?.graph).toContain("graph TD")
    expect(refactor.totalLocations).toBeGreaterThan(0)
  })

  it("explains diagnostics and searches transforms", async () => {
    const analyzer = createFixtureAnalyzer()
    const explanation = await Effect.runPromise(
      analyzer.explainError({
        code: 2322,
        message: "Type 'UserInput' is not assignable to type 'User'. Property 'id' is missing in type 'UserInput' but required in type 'User'.",
      }),
    )
    const transforms = await Effect.runPromise(analyzer.transformSearch({ from: "User", to: "UserDTO", limit: 5 }))

    expect(explanation?.explanation).toContain("compatible")
    expect(transforms).toContain("toDTO")
  })

  it("explains simplified unquoted assignability diagnostics", async () => {
    const analyzer = createFixtureAnalyzer()
    const explanation = await Effect.runPromise(
      analyzer.explainError({
        code: 2322,
        message: "Type UserInput is not assignable to type User. Property 'id' is missing in type 'UserInput' but required in type 'User'.",
      }),
    )

    expect(explanation?.explanation).toContain("UserInput")
    expect(explanation?.explanation).toContain("User")
    expect(explanation?.suggestions.length).toBeGreaterThan(0)
  })

  it("returns the type at a source position", async () => {
    const analyzer = createFixtureAnalyzer()
    const result = await Effect.runPromise(analyzer.getTypeAtPosition("types/basic.ts", 9, 3))

    expect(result).not.toBeNull()
    expect(result?.type).toBe("string")
    expect(result?.nodeKind).toBe("Identifier")
  })
})
