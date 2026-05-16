import { resolve } from "node:path"
import type { Project, SourceFile } from "ts-morph"
import { Context, Effect, Layer, Ref } from "effect"
import {
  parsePackageRef,
  parseSymbolRef,
  parseTypeExpressionRef,
} from "./boundary-refs"
import type {
  DiagnosticOptions,
  ListSymbolsOptions,
  SearchTypesOptions,
  SymbolInfo,
  TypeAnalyzer,
  TypeEvaluationResult,
} from "./analyzer"
import { getDeclarationName } from "./declarations"
import { discoverPackages, type PackageInfo } from "./discovery"
import { QuartzError } from "./errors"
import { inspectSourceFile, type FileInspectionOptions } from "./file-inspection"
import { collectPackageDiagnostics } from "./project-diagnostics"
import {
  createProjectWorkspaceState,
  getCachedProject,
  getWorkspacePackages,
  getWorkspaceSourceFiles,
  kindToString,
  markWorkspaceDirty,
  refreshAllProjects,
  refreshPackageProject,
  resolveWorkspacePackage,
  setWorkspacePackages,
  type ProjectWorkspaceState,
  workspaceRelativePath,
} from "./project-workspace"
import type { RefactorPreviewOptions } from "./analyzer"
import type {
  CompatibilityResult,
  ErrorExplanationResult,
  FileInspectionResult,
  SnippetCheckResult,
  ParsedVerifyContractInput,
  VerifyContractCheck,
  VerifyContractOptions,
  VerifyContractResult,
} from "./project-types"
import { previewRenameRefactor } from "./refactor-preview"
import { SnippetEvaluator } from "./snippet-evaluation"
import {
  expandTypeForSymbol,
  getTypeAtPositionInFile,
  getTypeInfoForSymbol,
  resolveSourceFile,
  type SymbolAnalysisContext,
} from "./symbol-file-snippet-analysis"
import { SymbolLookup as SymbolLookupImplementation } from "./symbol-lookup"
import { generateTypeGraph } from "./type-graph"
import { TypeExplainer as TypeExplainerImplementation } from "./type-explanations"
import { checkResolvedTypeCompatibility, TypeRelationExplorer } from "./type-relations"
import { formatResults, TransformSearchEngine, type TransformSearchOptions } from "./transform-search"

const toQuartzError = (message: string) => (cause: unknown) =>
  new QuartzError({
    message: cause instanceof Error ? cause.message : message,
    cause,
  })

export class AnalyzerConfig extends Context.Tag("@skastr0/quartz/AnalyzerConfig")<
  AnalyzerConfig,
  {
    readonly rootDirectory: string
  }
>() {
  static readonly layer = (rootDirectory: string) =>
    Layer.succeed(this, {
      rootDirectory: resolve(rootDirectory),
    })
}

export class PackageDiscovery extends Effect.Service<PackageDiscovery>()("@skastr0/quartz/PackageDiscovery", {
  accessors: true,
  effect: Effect.gen(function* () {
    const config = yield* AnalyzerConfig
    return {
      discover: () => discoverPackages(config.rootDirectory),
    }
  }),
}) {}

export class ProjectWorkspace extends Effect.Service<ProjectWorkspace>()("@skastr0/quartz/ProjectWorkspace", {
  accessors: true,
  effect: Effect.gen(function* () {
    const config = yield* AnalyzerConfig
    const discovery = yield* PackageDiscovery
    const state = yield* Ref.make(createProjectWorkspaceState(config.rootDirectory))
    const ensurePackages = (workspace: ProjectWorkspaceState): Effect.Effect<readonly PackageInfo[], QuartzError> =>
      workspace.packages === null
        ? discovery.discover().pipe(Effect.map((packages) => setWorkspacePackages(workspace, packages)))
        : Effect.succeed(getWorkspacePackages(workspace))
    const withState = <A>(f: (workspace: ProjectWorkspaceState) => A, message: string): Effect.Effect<A, QuartzError> =>
      Ref.get(state).pipe(
        Effect.flatMap((workspace) =>
          Effect.try({
            try: () => f(workspace),
            catch: toQuartzError(message),
          }),
        ),
      )

    return {
      state,
      rootDirectory: config.rootDirectory,
      getPackages: () =>
        Ref.get(state).pipe(
          Effect.flatMap(ensurePackages),
        ),
      resolvePackage: (packageName?: string) =>
        Ref.get(state).pipe(
          Effect.flatMap((workspace) =>
            ensurePackages(workspace).pipe(
              Effect.flatMap(() =>
                Effect.try({
                  try: () => resolveWorkspacePackage(workspace, packageName),
                  catch: toQuartzError("Could not resolve package"),
                }),
              ),
            ),
          ),
        ),
      relativePath: (absolutePath: string) =>
        withState((workspace) => workspaceRelativePath(workspace, absolutePath), "Could not resolve relative path"),
    }
  }),
}) {}

export class SourceProjectCache extends Effect.Service<SourceProjectCache>()("@skastr0/quartz/SourceProjectCache", {
  accessors: true,
  effect: Effect.gen(function* () {
    const workspace = yield* ProjectWorkspace
    const projectAccess = yield* Effect.makeSemaphore(1)
    const withWorkspace = <A>(
      f: (state: ProjectWorkspaceState) => A,
      message: string,
    ): Effect.Effect<A, QuartzError> =>
      Ref.get(workspace.state).pipe(
        Effect.flatMap((state) =>
          Effect.try({
            try: () => f(state),
            catch: toQuartzError(message),
          }),
        ),
      )
    return {
      getProject: (pkg: PackageInfo): Effect.Effect<Project, QuartzError> =>
        withWorkspace((state) => getCachedProject(state, pkg), "Could not load TypeScript project"),
      getSourceFiles: (project: Project, pkg: PackageInfo): Effect.Effect<readonly SourceFile[], QuartzError> =>
        Effect.sync(() => getWorkspaceSourceFiles(project, pkg)),
      markDirty: () => withWorkspace(markWorkspaceDirty, "Could not mark workspace dirty"),
      refreshAll: () => withWorkspace(refreshAllProjects, "Could not refresh workspace cache"),
      refreshPackage: (packageName: string) =>
        workspace.resolvePackage(packageName).pipe(
          Effect.flatMap((pkg) =>
            withWorkspace((state) => refreshPackageProject(state, pkg), "Could not refresh package cache"),
          ),
        ),
      withProjectAccess: <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
        projectAccess.withPermits(1)(effect),
    }
  }),
}) {}

export class SymbolLookup extends Effect.Service<SymbolLookup>()("@skastr0/quartz/SymbolLookup", {
  accessors: true,
  effect: Effect.gen(function* () {
    const workspace = yield* ProjectWorkspace
    const state = yield* Ref.get(workspace.state)
    const lookup = new SymbolLookupImplementation(state)
    return {
      findSymbol: Effect.fnUntraced(function* (symbolName: string, project: Project, pkg: PackageInfo) {
        return yield* Effect.try({
          try: () => lookup.findSymbol(symbolName, project, pkg),
          catch: toQuartzError("Could not find symbol"),
        })
      }),
    }
  }),
}) {}

export class FileInspection extends Effect.Service<FileInspection>()("@skastr0/quartz/FileInspection", {
  accessors: true,
  effect: Effect.gen(function* () {
    const workspace = yield* ProjectWorkspace
    return {
      inspectSourceFile: (
        sourceFile: SourceFile,
        pkg: PackageInfo,
        options: FileInspectionOptions,
      ): Effect.Effect<FileInspectionResult, QuartzError> =>
        Effect.gen(function* () {
          const state = yield* Ref.get(workspace.state)
          return yield* Effect.try({
            try: () =>
              inspectSourceFile(sourceFile, pkg, options, {
                kindToString,
                relativePath: (absolutePath) => workspaceRelativePath(state, absolutePath),
              }),
            catch: toQuartzError("Could not inspect source file"),
          })
        }),
    }
  }),
}) {}

export class SnippetEvaluation extends Effect.Service<SnippetEvaluation>()("@skastr0/quartz/SnippetEvaluation", {
  accessors: true,
  sync: () => {
    const evaluator = new SnippetEvaluator()
    return {
      evalType: (
        expression: string,
        project: Project,
        pkg: PackageInfo,
        sourceFiles: readonly SourceFile[],
      ): Effect.Effect<TypeEvaluationResult, QuartzError> =>
        Effect.try({
          try: () => evaluator.evalType(expression, project, pkg, sourceFiles),
          catch: toQuartzError("Could not evaluate type"),
        }),
      checkSnippet: (
        code: string,
        project: Project,
        pkg: PackageInfo,
        sourceFiles: readonly SourceFile[],
      ): Effect.Effect<SnippetCheckResult, QuartzError> =>
        Effect.try({
          try: () => evaluator.checkSnippet(code, project, pkg, sourceFiles),
          catch: toQuartzError("Could not check snippet"),
        }),
    }
  },
}) {}

export class Diagnostics extends Effect.Service<Diagnostics>()("@skastr0/quartz/Diagnostics", {
  accessors: true,
  effect: Effect.gen(function* () {
    const workspace = yield* ProjectWorkspace
    const cache = yield* SourceProjectCache
    const getPackageDiagnostics = (packageName?: string) =>
      Effect.gen(function* () {
        const pkg = yield* workspace.resolvePackage(packageName)
        const project = yield* cache.getProject(pkg)
        const state = yield* Ref.get(workspace.state)
        return collectPackageDiagnostics(project, pkg, {
          relativePath: (absolutePath) => workspaceRelativePath(state, absolutePath),
        })
      })

    return { getPackageDiagnostics }
  }),
}) {}

export class TypeRelations extends Effect.Service<TypeRelations>()("@skastr0/quartz/TypeRelations", {
  accessors: true,
  effect: Effect.gen(function* () {
    const workspace = yield* ProjectWorkspace
    const cache = yield* SourceProjectCache
    const symbolLookup = yield* SymbolLookup
    const state = yield* Ref.get(workspace.state)
    const explorer = new TypeRelationExplorer({
      relativePath: (absolutePath) => workspaceRelativePath(state, absolutePath),
    })
    const resolveTarget = (packageName?: string) =>
      Effect.gen(function* () {
        const pkg = yield* workspace.resolvePackage(packageName)
        const project = yield* cache.getProject(pkg)
        return { pkg, project }
      })

    return {
      findRelated: Effect.fnUntraced(function* (symbolName: string, packageName?: string) {
        const { pkg, project } = yield* resolveTarget(packageName)
        const found = yield* symbolLookup.findSymbol(symbolName, project, pkg)
        if (found === null) return null
        return yield* Effect.try({
          try: () => explorer.findRelated(symbolName, project, found),
          catch: toQuartzError("Could not find related symbols"),
        })
      }),
      checkCompatibility: Effect.fnUntraced(function* (
        fromSymbol: string,
        toSymbol: string,
        packageName?: string,
      ) {
        const { pkg, project } = yield* resolveTarget(packageName)
        const fromFound = yield* symbolLookup.findSymbol(fromSymbol, project, pkg)
        const toFound = yield* symbolLookup.findSymbol(toSymbol, project, pkg)
        return yield* Effect.try({
          try: () => checkResolvedTypeCompatibility(fromSymbol, toSymbol, fromFound, toFound),
          catch: toQuartzError("Could not check type compatibility"),
        })
      }),
    }
  }),
}) {}

export class TypeExplainer extends Effect.Service<TypeExplainer>()("@skastr0/quartz/TypeExplainer", {
  accessors: true,
  effect: Effect.gen(function* () {
    const workspace = yield* ProjectWorkspace
    const cache = yield* SourceProjectCache
    const diagnostics = yield* Diagnostics
    const typeRelations = yield* TypeRelations
    const symbolLookup = yield* SymbolLookup
    const snippetEvaluation = yield* SnippetEvaluation
    const resolveTarget = (packageName?: string) =>
      Effect.gen(function* () {
        const pkg = yield* workspace.resolvePackage(packageName)
        const project = yield* cache.getProject(pkg)
        const sourceFiles = yield* cache.getSourceFiles(project, pkg)
        return { pkg, project, sourceFiles }
      })
    const explainer = new TypeExplainerImplementation({
      getPackageDiagnostics: diagnostics.getPackageDiagnostics,
      checkCompatibility: typeRelations.checkCompatibility,
      findSymbol: symbolLookup.findSymbol,
      evalType: (expression, packageName) =>
        Effect.gen(function* () {
          const { pkg, project, sourceFiles } = yield* resolveTarget(packageName)
          return yield* snippetEvaluation.evalType(expression, project, pkg, sourceFiles)
        }),
    })

    return {
      explainError: Effect.fnUntraced(function* (options: {
        readonly code?: number
        readonly message?: string
        readonly file?: string
        readonly line?: number
        readonly packageName?: string
      }) {
        const { pkg, project } = yield* resolveTarget(options.packageName)
        return yield* explainer.explainError(options, project, pkg).pipe(Effect.mapError(toQuartzError("Could not explain error")))
      }),
      explainType: Effect.fnUntraced(function* (expression: string, packageName?: string) {
        return yield* explainer.explainType(expression, packageName).pipe(Effect.mapError(toQuartzError("Could not explain type")))
      }),
    }
  }),
}) {}

export class RefactorPreview extends Effect.Service<RefactorPreview>()("@skastr0/quartz/RefactorPreview", {
  accessors: true,
  effect: Effect.gen(function* () {
    const workspace = yield* ProjectWorkspace
    const cache = yield* SourceProjectCache
    const symbolLookup = yield* SymbolLookup
    return {
      previewRefactor: Effect.fnUntraced(function* (options: RefactorPreviewOptions) {
        const pkg = yield* workspace.resolvePackage(options.packageName)
        const project = yield* cache.getProject(pkg)
        const found = yield* symbolLookup.findSymbol(options.symbol, project, pkg)
        if (found === null) {
          return yield* Effect.fail(new QuartzError({ message: `Symbol "${options.symbol}" not found` }))
        }
        const state = yield* Ref.get(workspace.state)
        return yield* Effect.try({
          try: () =>
            previewRenameRefactor(options, project, pkg, found, {
              relativePath: (absolutePath) => workspaceRelativePath(state, absolutePath),
            }),
          catch: toQuartzError("Could not preview refactor"),
        })
      }),
    }
  }),
}) {}

export class TypeGraph extends Effect.Service<TypeGraph>()("@skastr0/quartz/TypeGraph", {
  accessors: true,
  effect: Effect.gen(function* () {
    const workspace = yield* ProjectWorkspace
    const cache = yield* SourceProjectCache
    const symbolLookup = yield* SymbolLookup
    const typeRelations = yield* TypeRelations
    return {
      generateGraph: Effect.fnUntraced(function* (
        symbolName: string,
        options: { readonly depth?: number; readonly format?: "mermaid" | "dot"; readonly packageName?: string } = {},
      ) {
        const pkg = yield* workspace.resolvePackage(options.packageName)
        const project = yield* cache.getProject(pkg)
        return yield* generateTypeGraph(symbolName, options, project, pkg, {
          findSymbol: symbolLookup.findSymbol,
          findRelated: typeRelations.findRelated,
        }).pipe(Effect.mapError(toQuartzError("Could not generate type graph")))
      }),
    }
  }),
}) {}

export class TransformSearch extends Effect.Service<TransformSearch>()("@skastr0/quartz/TransformSearch", {
  accessors: true,
  effect: Effect.gen(function* () {
    const workspace = yield* ProjectWorkspace
    const cache = yield* SourceProjectCache
    const engines = yield* Ref.make(new Map<string, { readonly project: Project; readonly engine: TransformSearchEngine }>())
    const searchRaw = Effect.fnUntraced(function* (
      options: TransformSearchOptions & { readonly packageName?: string },
    ) {
      const pkg = yield* workspace.resolvePackage(options.packageName)
      const project = yield* cache.getProject(pkg)
      const sourceFiles = yield* cache.getSourceFiles(project, pkg)
      const engine = yield* Ref.modify(engines, (current) => {
        const cached = current.get(pkg.tsconfigPath)
        if (cached !== undefined && cached.project === project) return [cached.engine, current] as const
        const next = new Map(current)
        const created = new TransformSearchEngine(project, pkg.path, [...sourceFiles])
        next.set(pkg.tsconfigPath, { project, engine: created })
        return [created, next] as const
      })
      return yield* Effect.tryPromise({
        try: () => engine.search(options),
        catch: toQuartzError("Could not search transforms"),
      })
    })
    return {
      searchRaw,
      search: (options: TransformSearchOptions & { readonly packageName?: string }) =>
        searchRaw(options).pipe(Effect.map(formatResults)),
      clear: () => Ref.update(engines, (current) => {
        if (current.size === 0) return current
        return new Map()
      }),
    }
  }),
}) {}

export class TypeAnalyzerService extends Effect.Service<TypeAnalyzerService>()("@skastr0/quartz/TypeAnalyzer", {
  accessors: true,
  effect: Effect.gen(function* () {
    const config = yield* AnalyzerConfig
    const workspace = yield* ProjectWorkspace
    const cache = yield* SourceProjectCache
    const symbolLookup = yield* SymbolLookup
    const fileInspection = yield* FileInspection
    const snippetEvaluation = yield* SnippetEvaluation
    const diagnostics = yield* Diagnostics
    const typeRelations = yield* TypeRelations
    const typeExplainer = yield* TypeExplainer
    const refactorPreview = yield* RefactorPreview
    const typeGraph = yield* TypeGraph
    const transformSearch = yield* TransformSearch
    const state = yield* Ref.get(workspace.state)
    const context: SymbolAnalysisContext = {
      rootDirectory: config.rootDirectory,
      kindToString,
      relativePath: (absolutePath) => workspaceRelativePath(state, absolutePath),
    }
    const resolveTarget = (
      packageName?: string,
    ): Effect.Effect<{ pkg: PackageInfo; project: Project; sourceFiles: readonly SourceFile[] }, QuartzError> =>
      Effect.gen(function* () {
        const pkg = yield* workspace.resolvePackage(packageName)
        const project = yield* cache.getProject(pkg)
        const sourceFiles = yield* cache.getSourceFiles(project, pkg)
        return { pkg, project, sourceFiles }
      })
    const getTypeInfoBody = Effect.fnUntraced(function* (symbolName: string, packageName?: string) {
      const { pkg, project } = yield* resolveTarget(packageName)
      const found = yield* symbolLookup.findSymbol(symbolName, project, pkg)
      if (found === null) return null
      return yield* Effect.try({
        try: () => getTypeInfoForSymbol(found, pkg, context),
        catch: toQuartzError("Could not get type info"),
      })
    })
    const getTypeInfo = (symbolName: string, packageName?: string) =>
      cache.withProjectAccess(getTypeInfoBody(symbolName, packageName))
    const listSymbolsBody = Effect.fnUntraced(function* (options: ListSymbolsOptions = {}) {
      const { pattern, kind, packageName, file, limit = 100, indexOnly = false } = options
      const { pkg, project, sourceFiles } = yield* resolveTarget(packageName)
      const symbols: SymbolInfo[] = []
      const regex = pattern ? new RegExp(pattern, "i") : null
      const fileRegex = file ? new RegExp(file, "i") : null

      for (const sourceFile of sourceFiles) {
        const filePath = workspaceRelativePath(state, sourceFile.getFilePath())
        const isIndexFile =
          filePath.endsWith("/index") ||
          filePath.endsWith("/index.tsx") ||
          filePath === "index" ||
          filePath === "index.tsx"

        if (indexOnly && !isIndexFile) continue
        if (fileRegex && !fileRegex.test(filePath)) continue

        for (const [exportName, declarations] of sourceFile.getExportedDeclarations()) {
          for (const declaration of declarations) {
            const name = exportName === "default" ? (getDeclarationName(declaration) ?? "default") : exportName
            const symbolKind = kindToString(declaration.getKind())

            if (kind && kind !== "all" && symbolKind !== kind) continue
            if (regex && !regex.test(name)) continue

            symbols.push({
              name,
              kind: symbolKind,
              file: filePath,
              line: declaration.getStartLineNumber(),
              package: pkg.name,
              isIndexExport: isIndexFile,
            })
          }
        }
      }

      symbols.sort((left, right) => {
        if (left.isIndexExport && !right.isIndexExport) return -1
        if (!left.isIndexExport && right.isIndexExport) return 1
        return left.name.localeCompare(right.name)
      })

      const total = symbols.length
      const truncated = total > limit
      return {
        symbols: truncated ? symbols.slice(0, limit) : symbols,
        total,
        truncated,
        package: pkg.name,
      }
    })
    const listSymbols = (options?: ListSymbolsOptions) => cache.withProjectAccess(listSymbolsBody(options))
    const skippedContractCheck = (summary: string): VerifyContractCheck => ({
      ran: false,
      passed: null,
      blocking: false,
      summary,
    })
    const parseVerifyContractInput = (options: VerifyContractOptions): ParsedVerifyContractInput => {
      const packageName = options.packageName?.trim()
      return {
        ...(options.from === undefined ? {} : { from: parseTypeExpressionRef("from", options.from) }),
        ...(options.to === undefined ? {} : { to: parseTypeExpressionRef("to", options.to) }),
        ...(options.symbol === undefined ? {} : { symbol: parseSymbolRef("symbol", options.symbol) }),
        ...(packageName === undefined || packageName.length === 0 ? {} : { packageName: parsePackageRef(packageName) }),
        ...(options.snippet === undefined ? {} : { snippet: options.snippet }),
        ...(options.includeDiagnostics === undefined ? {} : { includeDiagnostics: options.includeDiagnostics }),
        ...(options.includeTransformEvidence === undefined
          ? {}
          : { includeTransformEvidence: options.includeTransformEvidence }),
        ...(options.transformLimit === undefined ? {} : { transformLimit: options.transformLimit }),
      }
    }
    const matchesRequestedSymbol = (resultName: string, symbol: string): boolean =>
      resultName === symbol || resultName.endsWith(`.${symbol}`)
    const verifyContractBody = Effect.fnUntraced(function* (options: VerifyContractOptions) {
      const input = yield* Effect.try({
        try: () => parseVerifyContractInput(options),
        catch: toQuartzError("Could not parse verify-contract refs"),
      })
      const { pkg, project, sourceFiles } = yield* resolveTarget(input.packageName)
      const checks: Record<"compatibility" | "snippet" | "diagnostics" | "transform", VerifyContractCheck> = {
        compatibility: skippedContractCheck("Skipped because both from and to were not provided."),
        snippet: skippedContractCheck("Skipped because no snippet was provided."),
        diagnostics: skippedContractCheck("Skipped because includeDiagnostics was false."),
        transform: skippedContractCheck("Skipped because both from and to were not provided."),
      }
      const evidence: VerifyContractResult["evidence"] = {}
      const gaps: string[] = []
      const nextSteps = new Set<string>()
      const explanations: ErrorExplanationResult[] = []
      const hasFromTo = input.from !== undefined && input.to !== undefined

      if (hasFromTo) {
        const from = input.from as string
        const to = input.to as string
        const fromFound = yield* symbolLookup.findSymbol(from, project, pkg)
        const toFound = yield* symbolLookup.findSymbol(to, project, pkg)
        const compatibility = yield* Effect.try({
          try: () => checkResolvedTypeCompatibility(from, to, fromFound, toFound),
          catch: toQuartzError("Could not check contract compatibility"),
        })
        evidence.compatibility = compatibility
        checks.compatibility = {
          ran: true,
          passed: compatibility.compatible,
          blocking: false,
          summary: compatibility.compatible
            ? `${from} is directly assignable to ${to}.`
            : `${from} is not directly assignable to ${to}; verified transform evidence can still satisfy a conversion contract.`,
          evidence: compatibility,
        }
        if (!compatibility.compatible) {
          gaps.push("Direct assignability is not established for from -> to.")
          const explanation = yield* typeExplainer.explainError({
            ...(input.packageName === undefined ? {} : { packageName: input.packageName }),
            code: 2322,
            message: compatibility.reason ?? `Type ${from} is not assignable to type ${to}.`,
          }).pipe(Effect.catchAll(() => Effect.succeed(null)))
          if (explanation !== null) explanations.push(explanation)
        }
      } else if (input.from !== undefined || input.to !== undefined) {
        gaps.push("Only one side of the from/to contract was provided.")
        nextSteps.add("Provide both from and to to run compatibility and transform verification.")
      }

      if (input.snippet !== undefined) {
        const snippet = yield* snippetEvaluation.checkSnippet(input.snippet, project, pkg, sourceFiles)
        evidence.snippet = snippet
        checks.snippet = {
          ran: true,
          passed: snippet.valid,
          blocking: true,
          summary: snippet.valid ? "Snippet compiles under the package TypeScript project." : "Snippet has TypeScript errors.",
          evidence: snippet,
        }
        if (!snippet.valid) {
          gaps.push("The supplied snippet does not compile.")
          nextSteps.add("Repair the snippet until check-snippet returns valid: true.")
          const firstError = snippet.errors?.[0]
          if (firstError !== undefined) {
            const explanation = yield* typeExplainer.explainError({
              ...(input.packageName === undefined ? {} : { packageName: input.packageName }),
              message: firstError.message,
            }).pipe(Effect.catchAll(() => Effect.succeed(null)))
            if (explanation !== null) explanations.push(explanation)
          }
        }
      } else {
        gaps.push("No snippet was supplied, so Quartz did not verify a concrete call site.")
        nextSteps.add("Add a minimal snippet that exercises the proposed contract at a call site.")
      }

      if (input.includeDiagnostics !== false) {
        const diagnosticsResult = collectPackageDiagnostics(project, pkg, context)
        evidence.diagnostics = diagnosticsResult
        checks.diagnostics = {
          ran: true,
          passed: diagnosticsResult.length === 0,
          blocking: true,
          summary: diagnosticsResult.length === 0
            ? "Package diagnostics are clean."
            : `Package has ${diagnosticsResult.length} TypeScript diagnostic(s).`,
          evidence: diagnosticsResult,
        }
        if (diagnosticsResult.length > 0) {
          gaps.push("The package has ambient TypeScript diagnostics.")
          nextSteps.add("Inspect diagnostics before trusting the contract in this project state.")
        }
      }

      if (hasFromTo && input.includeTransformEvidence !== false) {
        const from = input.from as string
        const to = input.to as string
        const transformResponse = yield* transformSearch.searchRaw({
          ...(input.packageName === undefined ? {} : { packageName: input.packageName }),
          from,
          to,
          verifiedOnly: true,
          limit: input.transformLimit ?? 10,
        })
        evidence.transformSearch = transformResponse
        const verifiedResults = transformResponse.results.filter((result) => result.verification.status === "verified")
        const symbolMatched = input.symbol === undefined
          ? true
          : verifiedResults.some((result) => matchesRequestedSymbol(result.name, input.symbol as string))
        const passed = verifiedResults.length > 0 && symbolMatched
        const directAssignable = checks.compatibility.passed === true
        checks.transform = {
          ran: true,
          passed,
          blocking: !directAssignable,
          summary: passed
            ? input.symbol === undefined
              ? `Found ${verifiedResults.length} compiler-verified transform candidate(s).`
              : `Found compiler-verified transform evidence for ${input.symbol}.`
            : input.symbol === undefined
              ? directAssignable
                ? "No compiler-verified transform candidates were found; direct assignability already supports the contract."
                : "No compiler-verified transform candidates were found."
              : directAssignable
                ? `No compiler-verified transform candidate matched ${input.symbol}; direct assignability already supports the contract.`
                : `No compiler-verified transform candidate matched ${input.symbol}.`,
          evidence: {
            verified: verifiedResults.length,
            returned: transformResponse.results.length,
            symbol: input.symbol,
          },
        }
        if (!passed && !directAssignable) {
          gaps.push(input.symbol === undefined
            ? "No compiler-verified transform candidate was found for from -> to."
            : "No compiler-verified transform candidate matched the requested symbol.")
          nextSteps.add("Run transform-search with includeDiagnostics/includeSyntheticCode to inspect candidate verifier failures.")
        }
      } else if (hasFromTo && input.includeTransformEvidence === false) {
        gaps.push("Transform evidence was skipped by includeTransformEvidence: false.")
        if (input.symbol !== undefined) {
          nextSteps.add("Enable transform evidence to verify that the requested symbol backs the contract.")
        }
      }

      if (explanations.length > 0) evidence.explanations = explanations

      const directAssignable = checks.compatibility.passed === true
      const transformPassed = checks.transform.passed === true
      const snippetOk = checks.snippet.passed !== false
      const diagnosticsOk = checks.diagnostics.passed !== false
      const contractEvidenceOk = hasFromTo ? directAssignable || transformPassed : true
      const hasPositiveEvidence = directAssignable || transformPassed || checks.snippet.passed === true
      const ok = snippetOk && diagnosticsOk && contractEvidenceOk && hasPositiveEvidence

      if (!ok) {
        nextSteps.add("Treat this contract as untrusted until a blocking check passes.")
      }

      return {
        schemaVersion: "verify-contract/v1" as const,
        ok,
        contract: {
          ...(input.from === undefined ? {} : { from: input.from }),
          ...(input.to === undefined ? {} : { to: input.to }),
          ...(input.symbol === undefined ? {} : { symbol: input.symbol }),
          package: pkg.name,
        },
        checks,
        evidence,
        gaps,
        next_steps: [...nextSteps],
      }
    })

    const analyzer: TypeAnalyzer = {
      getPackages: workspace.getPackages,
      listSymbols,
      getTypeInfo,
      expandType: Effect.fnUntraced(function* (symbolName: string, packageName?: string) {
        return yield* cache.withProjectAccess(Effect.gen(function* () {
          const { pkg, project } = yield* resolveTarget(packageName)
          const found = yield* symbolLookup.findSymbol(symbolName, project, pkg)
          if (found === null) return null
          return yield* Effect.try({
            try: () => expandTypeForSymbol(found, project, context),
            catch: toQuartzError("Could not expand type"),
          })
        }))
      }),
      searchTypes: Effect.fnUntraced(function* (options: SearchTypesOptions) {
        return yield* cache.withProjectAccess(Effect.gen(function* () {
          const pattern = options.pattern ?? options.query
          const limit = options.limit ?? 25
          const symbolOptions: SearchTypesOptions = {
            limit,
            ...(pattern === undefined ? {} : { pattern }),
            ...(options.hasProperty === undefined ? {} : { hasProperty: options.hasProperty }),
            ...(options.extends === undefined ? {} : { extends: options.extends }),
            ...(options.packageName === undefined ? {} : { packageName: options.packageName }),
          }
          const symbols = yield* listSymbolsBody({ ...symbolOptions, kind: "all", limit: 1000 })
          const results = []
          for (const symbol of symbols.symbols) {
            const symbolReference = symbol.file === undefined ? symbol.name : `@file:${symbol.file}:${symbol.name}`
            if (options.hasProperty !== undefined || options.extends !== undefined) {
              const { pkg, project } = yield* resolveTarget(symbol.package)
              const found = yield* symbolLookup.findSymbol(symbolReference, project, pkg)
              if (found === null) continue
              const type = found.node.getType()
              if (options.hasProperty !== undefined && type.getProperty(options.hasProperty) === undefined) {
                continue
              }
              if (options.extends !== undefined) {
                const hasBase = type.getBaseTypes().some((baseType) => {
                  const baseSymbol = baseType.getSymbol()
                  return baseSymbol !== undefined && baseSymbol.getName() === options.extends
                })
                if (!hasBase) continue
              }
            }
            const info = yield* getTypeInfoBody(symbolReference, symbol.package)
            if (info !== null) results.push(info)
            if (results.length >= limit) break
          }
          return results
        }))
      }),
      findRelated: (symbolName, packageName) => cache.withProjectAccess(typeRelations.findRelated(symbolName, packageName)),
      evalType: Effect.fnUntraced(function* (expression: string, packageName?: string) {
        return yield* cache.withProjectAccess(Effect.gen(function* () {
          const { pkg, project, sourceFiles } = yield* resolveTarget(packageName)
          return yield* snippetEvaluation.evalType(expression, project, pkg, sourceFiles)
        }))
      }),
      checkSnippet: Effect.fnUntraced(function* (code: string, packageName?: string) {
        return yield* cache.withProjectAccess(Effect.gen(function* () {
          const { pkg, project, sourceFiles } = yield* resolveTarget(packageName)
          return yield* snippetEvaluation.checkSnippet(code, project, pkg, sourceFiles)
        }))
      }),
      getFileDeclarations: Effect.fnUntraced(function* (
        filePath: string,
        options: { readonly symbol?: string; readonly includePrivate?: boolean; readonly packageName?: string } = {},
      ) {
        return yield* cache.withProjectAccess(Effect.gen(function* () {
          const { pkg, project, sourceFiles } = yield* resolveTarget(options.packageName)
          const sourceFile = resolveSourceFile(filePath, config.rootDirectory, project, sourceFiles)
          if (sourceFile === null) return null
          return yield* fileInspection.inspectSourceFile(sourceFile, pkg, options)
        }))
      }),
      getTypeAtPosition: Effect.fnUntraced(function* (
        filePath: string,
        line: number,
        column: number,
        packageName?: string,
      ) {
        return yield* cache.withProjectAccess(Effect.gen(function* () {
          const { project, sourceFiles } = yield* resolveTarget(packageName)
          const sourceFile = resolveSourceFile(filePath, config.rootDirectory, project, sourceFiles)
          if (sourceFile === null) return null
          return yield* Effect.try({
            try: () => getTypeAtPositionInFile(sourceFile, project, line, column, context),
            catch: toQuartzError("Could not get type at position"),
          })
        }))
      }),
      checkCompatibility: (from, to, packageName) =>
        cache.withProjectAccess(typeRelations.checkCompatibility(from, to, packageName)),
      generateGraph: (symbol, options) => cache.withProjectAccess(typeGraph.generateGraph(symbol, options)),
      previewRefactor: (options) => cache.withProjectAccess(refactorPreview.previewRefactor(options)),
      getDiagnostics: Effect.fnUntraced(function* (packageNameOrOptions?: string | DiagnosticOptions) {
        return yield* cache.withProjectAccess(Effect.gen(function* () {
          const packageName =
            typeof packageNameOrOptions === "string" ? packageNameOrOptions : packageNameOrOptions?.packageName
          const rawDiagnostics = yield* diagnostics.getPackageDiagnostics(packageName)
          if (typeof packageNameOrOptions !== "object" || packageNameOrOptions?.explain !== true) {
            return rawDiagnostics
          }
          const errors = yield* Effect.forEach(
            rawDiagnostics.slice(0, 10),
            (diagnostic) =>
              typeExplainer.explainError({
                code: diagnostic.code,
                message: diagnostic.message,
                ...(packageName === undefined ? {} : { packageName }),
              }).pipe(Effect.map((explanation) => ({ ...diagnostic, explanation }))),
            { concurrency: 1 },
          )
          return {
            totalErrors: rawDiagnostics.length,
            explained: errors.length,
            truncated: rawDiagnostics.length > 10,
            errors,
          }
        }))
      }),
      explainError: (options) => cache.withProjectAccess(typeExplainer.explainError(options)),
      explainType: (expression, packageName) => cache.withProjectAccess(typeExplainer.explainType(expression, packageName)),
      transformSearch: (options) => cache.withProjectAccess(transformSearch.search(options)),
      verifyContract: (options) => cache.withProjectAccess(verifyContractBody(options)),
      refresh: Effect.fnUntraced(function* (packageName?: string) {
        if (packageName !== undefined) {
          yield* cache.refreshPackage(packageName)
          yield* transformSearch.clear()
          return `Refreshed TypeScript project for "${packageName}". Next type query will use fresh AST.`
        }
        yield* cache.refreshAll()
        yield* transformSearch.clear()
        return "Refreshed all TypeScript projects. Next type queries will use fresh AST."
      }),
      markDirty: () => cache.markDirty().pipe(Effect.zipRight(transformSearch.clear())),
    }
    return analyzer
  }),
}) {}

export type CoreServices =
  | AnalyzerConfig
  | PackageDiscovery
  | ProjectWorkspace
  | SourceProjectCache
  | SymbolLookup
  | FileInspection
  | SnippetEvaluation
  | Diagnostics
  | TypeRelations
  | TypeExplainer
  | RefactorPreview
  | TypeGraph
  | TransformSearch
  | TypeAnalyzerService

export const CoreLayer = (rootDirectory: string): Layer.Layer<CoreServices> => {
  const configLayer = AnalyzerConfig.layer(rootDirectory)
  const discoveryLayer = PackageDiscovery.Default.pipe(Layer.provide(configLayer))
  const workspaceLayer = ProjectWorkspace.Default.pipe(Layer.provide(Layer.mergeAll(configLayer, discoveryLayer)))
  const cacheLayer = SourceProjectCache.Default.pipe(Layer.provide(workspaceLayer))
  const symbolLookupLayer = SymbolLookup.Default.pipe(Layer.provide(workspaceLayer))
  const fileInspectionLayer = FileInspection.Default.pipe(Layer.provide(workspaceLayer))
  const snippetEvaluationLayer = SnippetEvaluation.Default
  const diagnosticsLayer = Diagnostics.Default.pipe(Layer.provide(Layer.mergeAll(workspaceLayer, cacheLayer)))
  const typeRelationsLayer = TypeRelations.Default.pipe(
    Layer.provide(Layer.mergeAll(workspaceLayer, cacheLayer, symbolLookupLayer)),
  )
  const typeExplainerLayer = TypeExplainer.Default.pipe(
    Layer.provide(
      Layer.mergeAll(workspaceLayer, cacheLayer, diagnosticsLayer, typeRelationsLayer, symbolLookupLayer, snippetEvaluationLayer),
    ),
  )
  const refactorPreviewLayer = RefactorPreview.Default.pipe(
    Layer.provide(Layer.mergeAll(workspaceLayer, cacheLayer, symbolLookupLayer)),
  )
  const typeGraphLayer = TypeGraph.Default.pipe(
    Layer.provide(Layer.mergeAll(workspaceLayer, cacheLayer, symbolLookupLayer, typeRelationsLayer)),
  )
  const transformSearchLayer = TransformSearch.Default.pipe(Layer.provide(Layer.mergeAll(workspaceLayer, cacheLayer)))
  const typeAnalyzerLayer = TypeAnalyzerService.Default.pipe(
    Layer.provide(
      Layer.mergeAll(
        configLayer,
        workspaceLayer,
        cacheLayer,
        symbolLookupLayer,
        fileInspectionLayer,
        snippetEvaluationLayer,
        diagnosticsLayer,
        typeRelationsLayer,
        typeExplainerLayer,
        refactorPreviewLayer,
        typeGraphLayer,
        transformSearchLayer,
      ),
    ),
  )
  return Layer.mergeAll(
    configLayer,
    discoveryLayer,
    workspaceLayer,
    cacheLayer,
    symbolLookupLayer,
    fileInspectionLayer,
    snippetEvaluationLayer,
    diagnosticsLayer,
    typeRelationsLayer,
    typeExplainerLayer,
    refactorPreviewLayer,
    typeGraphLayer,
    transformSearchLayer,
    typeAnalyzerLayer,
  )
}
