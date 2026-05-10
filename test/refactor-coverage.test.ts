import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { Project } from "ts-morph"
import { describe, expect, it } from "vitest"
import { createFixtureAnalyzer, fixturesPath } from "./helpers/analyzer"
import { createTypeAnalyzerRuntime } from "@skastr0/quartz-core"
import {
  buildCallableIndex,
  enumerateCallables,
  extractTokensFromTypeNode,
  selectCandidates,
  TransformSearchEngine,
  type CallableEntry,
} from "../packages/core/src/transform-search"

function createFixtureProject(): Project {
  const project = new Project({
    tsConfigFilePath: join(fixturesPath, "tsconfig.json"),
  })
  project.addSourceFilesAtPaths(join(fixturesPath, "types/**/*.ts"))
  return project
}

describe("refactor coverage", () => {
  const callable = (
    id: number,
    overrides: Partial<CallableEntry> = {},
  ): CallableEntry => ({
    id,
    kind: "Function",
    qualifiedName: `fn${id}`,
    exportState: "exported",
    filePath: "src/index.ts",
    pos: id,
    end: id + 1,
    minArity: 1,
    maxArity: 1,
    hasRest: false,
    isAsyncSyntax: false,
    hasTypeAnnotations: true,
    syntacticOverloadCount: 0,
    paramTokens: [],
    returnTokens: [],
    paramPropKeys: [],
    returnPropKeys: [],
    jsDocTags: [],
    isDeprecated: false,
    ...overrides,
  })

  it("enumerates callable families with stable stats and export states", () => {
    const project = createFixtureProject()
    const result = enumerateCallables(project.getSourceFiles(), fixturesPath)
    const byName = new Map(result.entries.map((entry) => [entry.qualifiedName, entry]))

    expect(result.entries.map((entry) => entry.id)).toEqual(result.entries.map((_, index) => index))
    expect(Object.values(result.stats).every((value) => typeof value === "number")).toBe(true)
    expect(result.stats.total).toBe(result.entries.length)
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

  it("applies every cheap candidate constraint before enforcing the budget", () => {
    const entries = [
      callable(0, { paramTokens: ["A"], returnTokens: ["B"], paramPropKeys: ["keep"] }),
      callable(1, { paramTokens: ["A"], returnTokens: ["B"], paramPropKeys: ["drop"] }),
      callable(2, { paramTokens: ["A"], returnTokens: ["C"], paramPropKeys: ["keep"] }),
    ]
    const index = buildCallableIndex(entries)

    const candidates = selectCandidates(index, {
      fromTokens: ["A"],
      toTokens: ["B"],
      fromPropKeys: ["keep"],
      budget: 2,
      exportedOnly: true,
    })

    expect(candidates).toEqual([0])
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
    const explained = complete.results.find((result) => result.explanation.summary.includes("accepts User"))
    expect(explained?.explanation).toMatchObject({
      summary: expect.stringContaining("accepts User"),
      details: {
        fromMatch: expect.objectContaining({
          paramName: expect.any(String),
          compatibility: expect.stringMatching(/exact|assignable/),
        }),
        toMatch: expect.objectContaining({
          compatibility: expect.stringMatching(/exact|assignable/),
        }),
        verification: expect.objectContaining({
          method: "synthetic",
        }),
      },
      confidence: expect.stringMatching(/high|medium|low/),
    })
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
    const defaultClass = await Effect.runPromise(analyzer.getTypeInfo("@file:basic.ts:DefaultExportedClass"))
    const aliasedUser = await Effect.runPromise(analyzer.getTypeInfo("@file:refactor.ts:RefactorableUser"))
    const localUser = await Effect.runPromise(analyzer.getTypeInfo("localUserFactory.localUser"))

    expect(internalHelper).toMatchObject({ name: "internalHelper", kind: "variable" })
    expect(internalHelper?.type).toContain("number")
    expect(userName).toMatchObject({ name: "name", kind: "PropertySignature" })
    expect(userName?.type).toBe("string")
    expect(defaultClass).toMatchObject({ name: "default", kind: "class" })
    expect(aliasedUser).toMatchObject({ name: "RefactorUser", kind: "interface" })
    expect(localUser).toMatchObject({ name: "localUser", kind: "variable" })
    expect(localUser?.type).toContain("User")
  })

  it("checks snippets with injected imports, duplicate aliases, and line offsets", async () => {
    const analyzer = createFixtureAnalyzer()
    const missingImportedProperty = await Effect.runPromise(
      analyzer.checkSnippet("const user: User = { name: 'Ada', email: 'ada@example.com' };"),
    )
    const duplicateAliases = await Effect.runPromise(
      analyzer.checkSnippet(
        "const fromBasic: DuplicateSnippetType_0 = { source: 'basic' };\nconst fromRefactor: DuplicateSnippetType_1 = { source: 'refactor' };",
      ),
    )

    expect(missingImportedProperty.valid).toBe(false)
    expect(missingImportedProperty.errors?.[0]).toMatchObject({
      line: 1,
      severity: "error",
    })
    expect(missingImportedProperty.errors?.[0]?.message).toContain("Property 'id' is missing")
    expect(duplicateAliases).toEqual({ valid: true })
  })

  it("inspects files with export metadata, signatures, private declarations, and ordering", async () => {
    const analyzer = createFixtureAnalyzer()
    const basic = await Effect.runPromise(
      analyzer.getFileDeclarations("types/basic.ts", { includePrivate: true }),
    )
    const refactorAlias = await Effect.runPromise(
      analyzer.getFileDeclarations("types/refactor.ts", { symbol: "^RefactorUser$" }),
    )
    const transforms = await Effect.runPromise(
      analyzer.getFileDeclarations("types/transforms.ts", { symbol: "^toDTO$" }),
    )

    expect(basic?.declarations[0]).toMatchObject({
      name: "DefaultExportedClass",
      kind: "class",
      isDefaultExport: true,
    })
    expect(basic?.declarations.find((declaration) => declaration.name === "InternalConfig")).toMatchObject({
      exported: false,
    })
    expect(refactorAlias?.declarations[0]).toMatchObject({
      name: "RefactorUser",
      exportedAs: "RefactorableUser",
    })
    expect(transforms?.declarations[0]?.signature).toContain("(from: User) => UserDTO")
  })

  it("preserves very large file declaration type text in the core analyzer", async () => {
    const root = mkdtempSync(join(tmpdir(), "tlt-large-file-"))
    mkdirSync(join(root, "src"))
    writeFileSync(join(root, "tsconfig.json"), JSON.stringify({ include: ["src/**/*.ts"] }), "utf8")
    const properties = Array.from({ length: 160 }, (_, index) => `p${index}: string`).join("; ")
    writeFileSync(join(root, "src", "large.ts"), `export type LargeShape = { ${properties} }\n`, "utf8")

    const analyzer = createTypeAnalyzerRuntime(root).analyzer
    const file = await Effect.runPromise(analyzer.getFileDeclarations("src/large.ts"))

    const typeText = file?.declarations[0]?.type
    expect(typeText).toContain("p159: string")
    expect(typeText?.length).toBeGreaterThan(1_500)
  })

  it("preserves analyzer package-scoped diagnostics and refresh helpers", async () => {
    const analyzer = createTypeAnalyzerRuntime(".").analyzer
    const diagnostics = await Effect.runPromise(analyzer.getDiagnostics({ packageName: "fixtures", explain: true }))
    const refresh = await Effect.runPromise(analyzer.refresh("fixtures"))

    expect(diagnostics).toMatchObject({ totalErrors: 0, explained: 0, truncated: false })
    expect(refresh).toContain('Refreshed TypeScript project for "fixtures"')
  })

  it("reports ambiguous exported symbols", async () => {
    const analyzer = createFixtureAnalyzer()

    await expect(Effect.runPromise(analyzer.getTypeInfo("DuplicateSnippetType"))).rejects.toThrow(
      /Ambiguous symbol "DuplicateSnippetType"/,
    )
  })

  it("pins related-symbol outgoing references and reference contexts", async () => {
    const analyzer = createFixtureAnalyzer()
    const related = await Effect.runPromise(analyzer.findRelated("ExtendedUser"))
    const refactorRelated = await Effect.runPromise(analyzer.findRelated("RefactorUser"))
    const profileRelated = await Effect.runPromise(analyzer.findRelated("RefactorUserProfile"))

    expect(related?.references).toEqual(expect.arrayContaining([
      expect.objectContaining({ symbol: "User", context: "extends" }),
    ]))
    expect(profileRelated?.references).toEqual(expect.arrayContaining([
      expect.objectContaining({ symbol: "RefactorUser", context: 'property "user"' }),
    ]))
    expect(refactorRelated?.referencedBy).toEqual(expect.arrayContaining([
      expect.objectContaining({ context: expect.stringMatching(/type reference|usage|extends/) }),
    ]))
    const keys = refactorRelated?.referencedBy.map((ref) => `${ref.symbol}:${ref.context}:${ref.line}`) ?? []
    expect(new Set(keys).size).toBe(keys.length)
  })

  it("extracts tokens from supported type-node syntax", () => {
    const project = createFixtureProject()
    const sourceFile = project.createSourceFile(
      join(fixturesPath, "__token_syntax_test__.ts"),
      `
        type TokenSyntax<T extends User> =
          | keyof User
          | readonly User[]
          | Promise<UserDTO>
          | { user: User; make(input: UserInput): UserDTO }
          | [User, UserDTO]
          | (User & ExtendedUser)
          | (User extends ExtendedUser ? UserDTO : never)
          | typeof DefaultExportedClass
          | User["id"]
          | \`user_\${string}\`
      `,
      { overwrite: true },
    )
    const typeNode = sourceFile.getTypeAliasOrThrow("TokenSyntax").getTypeNodeOrThrow()

    const extracted = extractTokensFromTypeNode(typeNode)

    expect(extracted.tokens).toEqual(expect.arrayContaining([
      "User",
      "UserDTO",
      "UserInput",
      "ExtendedUser",
      "Promise",
      "keyof",
      "readonly",
      "Array",
      "Tuple",
      "typeof",
      "DefaultExportedClass",
      "never",
    ]))
    expect(extracted.propKeys).toEqual(expect.arrayContaining(["user", "make"]))
    project.removeSourceFile(sourceFile)
  })
})
