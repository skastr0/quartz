import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { Effect, Either, Layer } from "effect"
import {
  AnalyzerConfig,
  FileInspection,
  Diagnostics,
  PackageDiscovery,
  ProjectWorkspace,
  RefactorPreview,
  SnippetEvaluation,
  SourceProjectCache,
  SymbolLookup,
  TypeAnalyzerService,
  TypeExplainer,
  TypeGraph,
  TypeRelations,
  TransformSearch,
  discoverPackages,
} from "@skastr0/quartz-core"
import { createAnalyzerForRoot, createFixtureAnalyzer, fixturesPath } from "./helpers/analyzer"

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
    const analyzer = createAnalyzerForRoot("test/fixtures")
    const result = await Effect.runPromise(analyzer.listSymbols({ pattern: "^User", limit: 50 }))

    expect(result.symbols.map((symbol) => symbol.name)).toContain("User")
  })

  it("accepts package path suffix selectors", async () => {
    const analyzer = createAnalyzerForRoot(".")
    const info = await Effect.runPromise(analyzer.getTypeInfo("User", "fixtures"))

    expect(info).toMatchObject({ name: "User", package: "test/fixtures" })
  })

  it("allows substituting symbol lookup through a test layer", async () => {
    const configLayer = AnalyzerConfig.layer(fixturesPath)
    const discoveryLayer = PackageDiscovery.Default.pipe(Layer.provide(configLayer))
    const workspaceLayer = ProjectWorkspace.Default.pipe(Layer.provide(Layer.mergeAll(configLayer, discoveryLayer)))
    const cacheLayer = SourceProjectCache.Default.pipe(Layer.provide(workspaceLayer))
    const fileInspectionLayer = FileInspection.Default.pipe(Layer.provide(workspaceLayer))
    const symbolLookupLayer = Layer.succeed(SymbolLookup, {
      _tag: "@skastr0/quartz/SymbolLookup",
      findSymbol: () => Effect.succeed(null),
    } as SymbolLookup)
    const diagnosticsLayer = Diagnostics.Default.pipe(Layer.provide(Layer.mergeAll(workspaceLayer, cacheLayer)))
    const typeRelationsLayer = TypeRelations.Default.pipe(
      Layer.provide(Layer.mergeAll(workspaceLayer, cacheLayer, symbolLookupLayer)),
    )
    const typeExplainerLayer = TypeExplainer.Default.pipe(
      Layer.provide(
        Layer.mergeAll(
          workspaceLayer,
          cacheLayer,
          diagnosticsLayer,
          typeRelationsLayer,
          symbolLookupLayer,
          SnippetEvaluation.Default,
        ),
      ),
    )
    const refactorPreviewLayer = RefactorPreview.Default.pipe(
      Layer.provide(Layer.mergeAll(workspaceLayer, cacheLayer, symbolLookupLayer)),
    )
    const typeGraphLayer = TypeGraph.Default.pipe(
      Layer.provide(Layer.mergeAll(workspaceLayer, cacheLayer, symbolLookupLayer, typeRelationsLayer)),
    )
    const transformSearchLayer = TransformSearch.Default.pipe(Layer.provide(Layer.mergeAll(workspaceLayer, cacheLayer)))
    const analyzerLayer = TypeAnalyzerService.Default.pipe(
      Layer.provide(
        Layer.mergeAll(
          configLayer,
          workspaceLayer,
          cacheLayer,
          fileInspectionLayer,
          symbolLookupLayer,
          SnippetEvaluation.Default,
          diagnosticsLayer,
          typeRelationsLayer,
          typeExplainerLayer,
          refactorPreviewLayer,
          typeGraphLayer,
          transformSearchLayer,
        ),
      ),
    )

    const result = await Effect.runPromise(
      TypeAnalyzerService.pipe(
        Effect.flatMap((analyzer) => analyzer.getTypeInfo("User")),
        Effect.provide(analyzerLayer),
      ),
    )

    expect(result).toBeNull()
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

  it("honors structural search filters", async () => {
    const analyzer = createFixtureAnalyzer()
    const byProperty = await Effect.runPromise(analyzer.searchTypes({ query: "User", hasProperty: "address" }))
    const byBase = await Effect.runPromise(analyzer.searchTypes({ query: "User", extends: "User" }))

    expect(byProperty.map((result) => result.name)).toContain("UserWithAddress")
    expect(byProperty.map((result) => result.name)).not.toContain("User")
    expect(byBase.map((result) => result.name)).toEqual(expect.arrayContaining(["ExtendedUser", "UserWithAddress"]))
  })

  it("searches duplicate exported names by file-qualified symbol identity", async () => {
    const root = mkdtempSync(join(tmpdir(), "quartz-duplicate-search-"))
    mkdirSync(join(root, "src"))
    writeFileSync(join(root, "tsconfig.json"), JSON.stringify({ include: ["src/**/*.ts"] }), "utf8")
    writeFileSync(join(root, "src/a.ts"), "export interface DuplicateSnippetType { alpha: string }\n", "utf8")
    writeFileSync(join(root, "src/b.ts"), "export interface DuplicateSnippetType { beta: number }\n", "utf8")

    const analyzer = createAnalyzerForRoot(root)
    const results = await Effect.runPromise(analyzer.searchTypes({ query: "DuplicateSnippetType", limit: 2 }))

    expect(results.map((result) => result.name)).toEqual(["DuplicateSnippetType", "DuplicateSnippetType"])
    expect(results.map((result) => result.location.file).sort()).toEqual(["src/a.ts", "src/b.ts"])
  })

  it("invalidates discovered packages after workspace refresh", async () => {
    const root = mkdtempSync(join(tmpdir(), "quartz-package-refresh-"))
    mkdirSync(join(root, "src"))
    writeFileSync(join(root, "tsconfig.json"), JSON.stringify({ include: ["src/**/*.ts"] }), "utf8")
    writeFileSync(join(root, "src/root.ts"), "export interface RootOnly { id: string }\n", "utf8")

    const analyzer = createAnalyzerForRoot(root)
    const before = await Effect.runPromise(analyzer.getPackages())

    mkdirSync(join(root, "packages/extra/src"), { recursive: true })
    writeFileSync(join(root, "packages/extra/tsconfig.json"), JSON.stringify({ include: ["src/**/*.ts"] }), "utf8")
    writeFileSync(join(root, "packages/extra/src/extra.ts"), "export interface ExtraOnly { id: string }\n", "utf8")
    await Effect.runPromise(analyzer.refresh())
    const after = await Effect.runPromise(analyzer.getPackages())

    expect(before.map((pkg) => pkg.name)).toEqual(["(root)"])
    expect(after.map((pkg) => pkg.name)).toEqual(expect.arrayContaining(["(root)", "packages/extra"]))
  })

  it("surfaces filesystem discovery failures", async () => {
    const root = mkdtempSync(join(tmpdir(), "quartz-discovery-error-"))
    chmodSync(root, 0)
    try {
      const result = await Effect.runPromise(discoverPackages(root).pipe(Effect.either))
      expect(Either.isLeft(result)).toBe(true)
      if (Either.isLeft(result)) {
        expect(result.left).toMatchObject({ _tag: "QuartzError" })
      }
    } finally {
      chmodSync(root, 0o700)
    }
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
  }, 20_000)

  it("checks compatibility and snippets", async () => {
    const analyzer = createFixtureAnalyzer()
    const compatible = await Effect.runPromise(analyzer.checkCompatibility("ExtendedUser", "User"))
    const incompatible = await Effect.runPromise(analyzer.checkCompatibility("UserInput", "User"))
    const invalidSnippet = await Effect.runPromise(analyzer.checkSnippet("const x: string = 42;"))

    expect(compatible.compatible).toBe(true)
    expect(incompatible.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "missing_property", property: "id", expectedType: "string" }),
      ]),
    )
    expect(invalidSnippet.valid).toBe(false)
    expect(invalidSnippet.errors?.length).toBeGreaterThan(0)
  })

  it("composes contract verification evidence", async () => {
    const analyzer = createFixtureAnalyzer()
    const verified = await Effect.runPromise(
      analyzer.verifyContract({
        from: "User",
        to: "UserDTO",
        symbol: "toDTO",
        snippet: "const user: User = { id: '1', name: 'Ada', email: 'ada@example.com' }; const dto: UserDTO = toDTO(user);",
      }),
    )
    const failed = await Effect.runPromise(
      analyzer.verifyContract({
        from: "User",
        to: "UserDTO",
        symbol: "fromDTO",
        snippet: "const dto: UserDTO = toDTO({ id: 1 });",
      }),
    )

    expect(verified).toMatchObject({
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
    expect(verified.evidence.transformSearch?.results[0]).toMatchObject({
      name: expect.stringContaining("toDTO"),
      verification: { status: "verified" },
    })
    expect(verified.gaps).toContain("Direct assignability is not established for from -> to.")

    expect(failed.ok).toBe(false)
    expect(failed.checks.snippet.passed).toBe(false)
    expect(failed.checks.transform.passed).toBe(false)
    expect(failed.gaps).toEqual(
      expect.arrayContaining([
        "The supplied snippet does not compile.",
        "No compiler-verified transform candidate matched the requested symbol.",
      ]),
    )
    expect(failed.next_steps.length).toBeGreaterThan(0)
  })

  it("verifies contract modes without requiring every evidence source", async () => {
    const analyzer = createFixtureAnalyzer()
    const transformOnly = await Effect.runPromise(
      analyzer.verifyContract({
        from: "User",
        to: "UserDTO",
      }),
    )
    const snippetOnly = await Effect.runPromise(
      analyzer.verifyContract({
        snippet: "const user: User = { id: '1', name: 'Ada', email: 'ada@example.com' };",
      }),
    )
    const directlyAssignable = await Effect.runPromise(
      analyzer.verifyContract({
        from: "ExtendedUser",
        to: "User",
        snippet: "const extended: ExtendedUser = { id: '1', name: 'Ada', email: 'ada@example.com', role: 'admin', createdAt: new Date() }; const user: User = extended;",
        includeTransformEvidence: false,
      }),
    )
    const symbolMismatch = await Effect.runPromise(
      analyzer.verifyContract({
        from: "User",
        to: "UserDTO",
        symbol: "fromDTO",
        snippet: "const user: User = { id: '1', name: 'Ada', email: 'ada@example.com' }; const dto: UserDTO = toDTO(user);",
      }),
    )

    expect(transformOnly.ok).toBe(true)
    expect(transformOnly.checks.transform.passed).toBe(true)
    expect(transformOnly.checks.snippet.ran).toBe(false)
    expect(transformOnly.gaps).toContain("No snippet was supplied, so Quartz did not verify a concrete call site.")

    expect(snippetOnly.ok).toBe(true)
    expect(snippetOnly.checks.snippet.passed).toBe(true)
    expect(snippetOnly.checks.compatibility.ran).toBe(false)
    expect(snippetOnly.checks.transform.ran).toBe(false)

    expect(directlyAssignable.ok).toBe(true)
    expect(directlyAssignable.checks.compatibility).toMatchObject({
      ran: true,
      passed: true,
      blocking: false,
    })
    expect(directlyAssignable.checks.snippet.passed).toBe(true)
    expect(directlyAssignable.checks.transform.ran).toBe(false)
    expect(directlyAssignable.gaps).toContain("Transform evidence was skipped by includeTransformEvidence: false.")

    expect(symbolMismatch.ok).toBe(false)
    expect(symbolMismatch.checks.snippet.passed).toBe(true)
    expect(symbolMismatch.checks.transform.passed).toBe(false)
    expect(symbolMismatch.gaps).toContain("No compiler-verified transform candidate matched the requested symbol.")
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
    const verifiedTransforms = await Effect.runPromise(
      analyzer.transformSearch({ from: "User", to: "UserDTO", verifiedOnly: true, limit: 5 }),
    )
    const partialTransforms = await Effect.runPromise(analyzer.transformSearch({ from: "User", limit: 5 }))
    const parsedTransforms = JSON.parse(transforms)
    const parsedVerifiedTransforms = JSON.parse(verifiedTransforms)
    const parsedPartialTransforms = JSON.parse(partialTransforms)

    expect(explanation?.explanation).toContain("compatible")
    expect(transforms).toContain("toDTO")
    expect(parsedTransforms.results[0]).toMatchObject({
      verification: {
        status: expect.stringMatching(/verified|unverified|unverifiable/),
        method: expect.anything(),
        reason: expect.any(String),
      },
    })
    expect(parsedVerifiedTransforms.results.every((result: any) => result.verification.status === "verified")).toBe(true)
    expect(parsedPartialTransforms.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          verification: {
            status: "unverified",
            method: "assignability_only",
            reason: "partial_query",
          },
        }),
      ]),
    )
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
