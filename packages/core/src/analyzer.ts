import { resolve } from "node:path"
import { Effect } from "effect"
import type { PackageInfo } from "./discovery"
import { QuartzError } from "./errors"
import type {
  CompatibilityResult,
  ErrorExplanationResult,
  FileInspectionResult,
  GraphResult,
  RefactorPreviewResult,
  RelatedInfo,
  SnippetCheckResult,
  TypeExplanationResult,
} from "./project-types"
import {
  ProjectManager,
} from "./legacy-project"
import { TransformSearchEngine, formatResults, type TransformSearchOptions } from "./transform-search"

export interface SymbolInfo {
  readonly name: string
  readonly kind: string
  readonly file: string
  readonly line?: number
  readonly package?: string
  readonly isIndexExport?: boolean
}

export interface SymbolListResult {
  readonly symbols: readonly SymbolInfo[]
  readonly total: number
  readonly truncated: boolean
  readonly package?: string
}

export interface ListSymbolsOptions {
  readonly pattern?: string
  readonly kind?: string
  readonly packageName?: string
  readonly file?: string
  readonly limit?: number
  readonly indexOnly?: boolean
}

export interface TypePropertyInfo {
  readonly name: string
  readonly type: string
  readonly optional?: boolean
  readonly from?: string
}

export interface TypeInfo {
  readonly name: string
  readonly kind: string
  readonly type: string
  readonly signature?: string
  readonly properties?: readonly TypePropertyInfo[]
  readonly location: {
    readonly file: string
    readonly line: number
  }
  readonly package?: string
}

export interface ExpandedType {
  readonly original: string
  readonly expanded: string
  readonly properties: readonly TypePropertyInfo[]
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] }

export interface TypeAtPositionResult {
  readonly type: string
  readonly expanded: string
  readonly nodeKind: string
  readonly nodeText: string
  readonly location: {
    readonly file: string
    readonly line: number
    readonly column: number
  }
}

export interface DiagnosticInfo {
  readonly message: string
  readonly code: number
  readonly category: string
  readonly file?: string
  readonly line?: number
  readonly column?: number
}

export interface SearchTypesOptions {
  readonly query?: string
  readonly pattern?: string
  readonly hasProperty?: string
  readonly extends?: string
  readonly packageName?: string
  readonly limit?: number
}

export interface DiagnosticOptions {
  readonly packageName?: string
  readonly explain?: boolean
}

export interface ErrorExplanationOptions {
  readonly code?: number
  readonly message?: string
  readonly file?: string
  readonly line?: number
  readonly packageName?: string
}

export interface RefactorPreviewOptions {
  readonly action: "rename"
  readonly symbol: string
  readonly to: string
  readonly packageName?: string
}

export interface TypeAnalyzer {
  readonly getPackages: () => Effect.Effect<readonly PackageInfo[], QuartzError>
  readonly listSymbols: (options?: ListSymbolsOptions) => Effect.Effect<SymbolListResult, QuartzError>
  readonly getTypeInfo: (symbolName: string, packageName?: string) => Effect.Effect<TypeInfo | null, QuartzError>
  readonly expandType: (symbolName: string, packageName?: string) => Effect.Effect<ExpandedType | null, QuartzError>
  readonly findRelated: (symbolName: string, packageName?: string) => Effect.Effect<RelatedInfo | null, QuartzError>
  readonly searchTypes: (options: SearchTypesOptions) => Effect.Effect<readonly TypeInfo[], QuartzError>
  readonly evalType: (expression: string, packageName?: string) => Effect.Effect<unknown, QuartzError>
  readonly checkSnippet: (code: string, packageName?: string) => Effect.Effect<SnippetCheckResult, QuartzError>
  readonly getFileDeclarations: (
    file: string,
    options?: { readonly symbol?: string; readonly includePrivate?: boolean; readonly packageName?: string },
  ) => Effect.Effect<FileInspectionResult | null, QuartzError>
  readonly checkCompatibility: (
    from: string,
    to: string,
    packageName?: string,
  ) => Effect.Effect<CompatibilityResult, QuartzError>
  readonly generateGraph: (
    symbol: string,
    options?: { readonly depth?: number; readonly format?: "mermaid" | "dot"; readonly packageName?: string },
  ) => Effect.Effect<GraphResult | null, QuartzError>
  readonly previewRefactor: (options: RefactorPreviewOptions) => Effect.Effect<RefactorPreviewResult, QuartzError>
  readonly getDiagnostics: (
    packageNameOrOptions?: string | DiagnosticOptions,
  ) => Effect.Effect<readonly DiagnosticInfo[] | unknown, QuartzError>
  readonly getTypeAtPosition: (
    filePath: string,
    line: number,
    column: number,
    packageName?: string,
  ) => Effect.Effect<TypeAtPositionResult | null, QuartzError>
  readonly explainError: (
    options: ErrorExplanationOptions,
  ) => Effect.Effect<ErrorExplanationResult | null, QuartzError>
  readonly explainType: (expression: string, packageName?: string) => Effect.Effect<TypeExplanationResult, QuartzError>
  readonly transformSearch: (
    options: TransformSearchOptions & { readonly packageName?: string },
  ) => Effect.Effect<string, QuartzError>
  readonly refresh: (packageName?: string) => Effect.Effect<string, QuartzError>
  readonly markDirty: () => void
}

const fromProjectPromise = <A>(try_: () => Promise<A>): Effect.Effect<A, QuartzError> =>
  Effect.tryPromise({
    try: try_,
    catch: (cause) =>
      new QuartzError({
        message: cause instanceof Error ? cause.message : String(cause),
        cause,
      }),
  })

export const createTypeAnalyzer = (rootDirectory: string): TypeAnalyzer => {
  const absoluteRootDirectory = resolve(rootDirectory)
  const projectManager = new ProjectManager(absoluteRootDirectory)

  return {
    getPackages: () => fromProjectPromise(() => projectManager.getPackages()),
    listSymbols: (options = {}) => fromProjectPromise(() => projectManager.listSymbols({ limit: 100, ...options })),
    getTypeInfo: (symbolName, packageName) => fromProjectPromise(() => projectManager.getTypeInfo(symbolName, packageName)),
    expandType: (symbolName, packageName) =>
      fromProjectPromise(async () => {
        const expanded = await projectManager.expandType(symbolName, packageName)
        return expanded === null ? null : { ...expanded, properties: expanded.properties ?? [] }
      }),
    findRelated: (symbolName, packageName) => fromProjectPromise(() => projectManager.findRelated(symbolName, packageName)),
    searchTypes: (options) => searchTypes(projectManager, options),
    evalType: (expression, packageName) => fromProjectPromise(() => projectManager.evalType(expression, packageName)),
    checkSnippet: (code, packageName) => fromProjectPromise(() => projectManager.checkSnippet(code, packageName)),
    getFileDeclarations: (file, options = {}) =>
      fromProjectPromise(() => projectManager.getFileDeclarations(file, options)),
    checkCompatibility: (from, to, packageName) =>
      fromProjectPromise(() => projectManager.checkCompatibility(from, to, packageName)),
    generateGraph: (symbol, options = {}) => fromProjectPromise(() => projectManager.generateGraph(symbol, options)),
    previewRefactor: (options) => fromProjectPromise(() => projectManager.previewRefactor(options)),
    getDiagnostics: (packageNameOrOptions) => getDiagnostics(projectManager, packageNameOrOptions),
    getTypeAtPosition: (filePath, line, column, packageName) =>
      fromProjectPromise(() => projectManager.getTypeAtPosition(filePath, line, column, packageName)),
    explainError: (options) => fromProjectPromise(() => projectManager.explainError(options)),
    explainType: (expression, packageName) => fromProjectPromise(() => projectManager.explainType(expression, packageName)),
    transformSearch: (options) => transformSearch(projectManager, options),
    refresh: (packageName) => refreshAnalyzer(projectManager, packageName),
    markDirty: () => projectManager.markDirty(),
  }
}

const searchTypes = (
  projectManager: ProjectManager,
  options: SearchTypesOptions,
): Effect.Effect<readonly TypeInfo[], QuartzError> =>
  Effect.gen(function* () {
    const symbolOptions: Mutable<SearchTypesOptions> = { limit: options.limit ?? 25 }
    const pattern = options.pattern ?? options.query
    if (pattern !== undefined) symbolOptions.pattern = pattern
    if (options.hasProperty !== undefined) symbolOptions.hasProperty = options.hasProperty
    if (options.extends !== undefined) symbolOptions.extends = options.extends
    if (options.packageName !== undefined) symbolOptions.packageName = options.packageName
    const symbols = yield* fromProjectPromise(() =>
      projectManager.searchTypes(symbolOptions, options.packageName),
    )
    const results = yield* Effect.forEach(
      symbols.symbols,
      (symbol) => fromProjectPromise(() => projectManager.getTypeInfo(symbol.name, symbol.package)),
      { concurrency: 4 },
    )

    return results.filter((item): item is NonNullable<typeof item> => item !== null)
  })

const getDiagnostics = (
  projectManager: ProjectManager,
  packageNameOrOptions?: string | DiagnosticOptions,
): Effect.Effect<readonly DiagnosticInfo[] | unknown, QuartzError> =>
  fromProjectPromise(() =>
    typeof packageNameOrOptions === "object" && packageNameOrOptions?.explain === true
      ? getExplainedDiagnostics(projectManager, packageNameOrOptions)
      : projectManager.getPackageDiagnostics(
          typeof packageNameOrOptions === "string" ? packageNameOrOptions : packageNameOrOptions?.packageName,
        ),
  )

const getExplainedDiagnostics = async (
  projectManager: ProjectManager,
  options: DiagnosticOptions,
): Promise<unknown> => {
  const diagnostics = await projectManager.getPackageDiagnostics(options.packageName)
  const errors = await Promise.all(
    diagnostics.slice(0, 10).map(async (diagnostic) => ({
      ...diagnostic,
      explanation: await projectManager.explainError({
        code: diagnostic.code,
        message: diagnostic.message,
        ...(options.packageName === undefined ? {} : { packageName: options.packageName }),
      }),
    })),
  )
  return {
    totalErrors: diagnostics.length,
    explained: errors.length,
    truncated: diagnostics.length > 10,
    errors,
  }
}

const transformSearch = (
  projectManager: ProjectManager,
  options: TransformSearchOptions & { readonly packageName?: string },
): Effect.Effect<string, QuartzError> =>
  fromProjectPromise(async () => {
    const pkg = await projectManager.resolvePackagePublic(options.packageName)
    const project = projectManager.getProjectPublic(pkg)
    const sourceFiles = projectManager.getSourceFilesPublic(project, pkg)
    const engine = new TransformSearchEngine(project, pkg.path, sourceFiles)
    const result = await engine.search(options)
    return formatResults(result)
  })

const refreshAnalyzer = (
  projectManager: ProjectManager,
  packageName?: string,
): Effect.Effect<string, QuartzError> =>
  fromProjectPromise(async () => {
    if (packageName !== undefined) {
      await projectManager.refreshPackage(packageName)
      return `Refreshed TypeScript project for "${packageName}". Next type query will use fresh AST.`
    }
    projectManager.refreshAll()
    return "Refreshed all TypeScript projects. Next type queries will use fresh AST."
  })
