import { join } from "node:path"
import { Effect } from "effect"
import { Project } from "ts-morph"
import { describe, expect, it } from "vitest"
import { createFixtureAnalyzer, fixturesPath } from "./helpers/analyzer"
import { enumerateCallables, TransformSearchEngine } from "../packages/core/src/transform-search"

function createFixtureProject(): Project {
  const project = new Project({
    tsConfigFilePath: join(fixturesPath, "tsconfig.json"),
  })
  project.addSourceFilesAtPaths(join(fixturesPath, "types/**/*.ts"))
  return project
}

describe("refactor coverage", () => {
  it("enumerates callable families with stable stats and export states", () => {
    const project = createFixtureProject()
    const result = enumerateCallables(project.getSourceFiles(), fixturesPath)
    const byName = new Map(result.entries.map((entry) => [entry.qualifiedName, entry]))

    expect(result.entries.map((entry) => entry.id)).toEqual(result.entries.map((_, index) => index))
    expect(result.stats).toMatchObject({
      functions: expect.any(Number),
      variableCallables: expect.any(Number),
      classMethods: expect.any(Number),
      staticMethods: expect.any(Number),
      constructors: expect.any(Number),
      objectMethods: expect.any(Number),
      interfaceMethods: expect.any(Number),
      callableProperties: expect.any(Number),
      total: result.entries.length,
    })
    expect(result.stats.functions).toBeGreaterThan(0)
    expect(result.stats.variableCallables).toBeGreaterThan(0)
    expect(result.stats.classMethods).toBeGreaterThan(0)
    expect(result.stats.staticMethods).toBeGreaterThan(0)
    expect(result.stats.constructors).toBeGreaterThan(0)
    expect(result.stats.objectMethods).toBeGreaterThan(0)
    expect(result.stats.interfaceMethods).toBeGreaterThan(0)
    expect(result.stats.callableProperties).toBeGreaterThan(0)
    expect(byName.get("UserMapper.toDTO")).toMatchObject({ kind: "ClassMethod", exportState: "exported" })
    expect(byName.get("UserMapper.createDefault")).toMatchObject({ kind: "StaticMethod", exportState: "exported" })
    expect(byName.get("dataTransforms.toUpperCase")).toMatchObject({ kind: "ObjectMethod", exportState: "exported" })
    expect(byName.get("UserFactory.fromDTO")).toMatchObject({ kind: "InterfaceMethod", exportState: "exported" })
    expect(byName.get("UserFactory.serialize")).toMatchObject({ kind: "CallableProperty", exportState: "exported" })
    expect(byName.get("internalTransform")).toMatchObject({ kind: "Function", exportState: "internal" })
  })

  it("preserves transform-search verification branches and response stats", async () => {
    const project = createFixtureProject()
    const sourceFiles = project.getSourceFiles().filter((sourceFile) => !sourceFile.isInNodeModules())
    const engine = new TransformSearchEngine(project, fixturesPath, sourceFiles)
    const complete = await engine.search({ from: "User", to: "UserDTO", limit: 5 })
    const completeWithWiderLimit = await engine.search({ from: "User", to: "UserDTO", limit: 100 })
    const partial = await engine.search({ from: "User", limit: 5 })
    const partialWithWiderLimit = await engine.search({ from: "User", limit: 100 })

    expect(complete.stats.totalCandidates).toBeGreaterThan(0)
    expect(complete.stats.assignableMatches).toBeGreaterThan(0)
    expect(complete.stats.verifiedMatches).toBeGreaterThanOrEqual(complete.results.length)
    expect(complete.stats.verifiedMatches).toBe(completeWithWiderLimit.stats.verifiedMatches)
    expect(complete.stats.returned).toBe(complete.results.length)
    expect(complete.stats.timing.totalMs).toBeGreaterThanOrEqual(0)
    expect(complete.results.some((result) => result.verification.status === "verified")).toBe(true)
    expect(complete.results.every((result) => result.verification.reason !== "synthetic_check_failed")).toBe(true)
    expect(partial.results.length).toBeGreaterThan(0)
    expect(partial.stats.verifiedMatches).toBe(partialWithWiderLimit.stats.verifiedMatches)
    expect(partial.stats.verifiedMatches).toBeGreaterThan(partial.stats.returned)
    expect(partial.results.every((result) => result.verification.reason !== "synthetic_check_failed")).toBe(true)
    expect(partial.results.some((result) => result.verification.reason === "partial_query")).toBe(true)
  })

  it("explains non-assignability diagnostic branches", async () => {
    const analyzer = createFixtureAnalyzer()
    const missingMember = await Effect.runPromise(
      analyzer.explainError({
        code: 2339,
        message: "Property 'missing' does not exist on type 'User'.",
      }),
    )
    const missingRequired = await Effect.runPromise(
      analyzer.explainError({
        code: 2741,
        message: "Property 'id' is missing in type 'UserInput' but required in type 'User'.",
      }),
    )
    const suggestedProperty = await Effect.runPromise(
      analyzer.explainError({
        code: 2551,
        message: "Property 'nam' does not exist on type 'User'. Did you mean 'name'?",
      }),
    )
    const generic = await Effect.runPromise(
      analyzer.explainError({
        code: 9999,
        message: "Type 'User' produced a custom compiler diagnostic.",
      }),
    )

    expect(missingMember?.issues[0]).toMatchObject({ kind: "missing_property", property: "missing" })
    expect(missingMember?.suggestions).toContain("Check for typos in the property name")
    expect(missingRequired?.explanation).toContain("missing required property 'id'")
    expect(missingRequired?.types?.to?.name).toBe("User")
    expect(suggestedProperty?.suggestions).toContain("Replace 'nam' with 'name'")
    expect(suggestedProperty?.types?.target?.name).toBe("User")
    expect(generic?.issues[0]).toMatchObject({ kind: "other" })
    expect(generic?.suggestions).toContain("Review the types involved using type_expand")
  })

  it("resolves file-scoped private symbols and dotted members", async () => {
    const analyzer = createFixtureAnalyzer()
    const internalHelper = await Effect.runPromise(
      analyzer.getTypeInfo("@file:types/basic.ts:internalHelper"),
    )
    const userName = await Effect.runPromise(analyzer.getTypeInfo("@file:types/basic.ts:User.name"))

    expect(internalHelper).toMatchObject({ name: "internalHelper", kind: "variable" })
    expect(internalHelper?.type).toContain("number")
    expect(userName).toMatchObject({ name: "name", kind: "PropertySignature" })
    expect(userName?.type).toBe("string")
  })
})
