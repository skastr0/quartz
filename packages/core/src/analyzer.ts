import { resolve } from "node:path"
import { Effect } from "effect"
import type { PackageInfo } from "./discovery"
import { TypeLevelToolsError } from "./errors"
import {
  ProjectManager,
  type CompatibilityResult,
  type FileInspectionResult,
  type GraphResult,
  type RefactorPreviewResult,
  type RelatedInfo,
  type SnippetCheckResult,
  type TypeExplanationResult,
  type ErrorExplanationResult,
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
  readonly getPackages: () => Effect.Effect<readonly PackageInfo[], TypeLevelToolsError>
  readonly listSymbols: (options?: ListSymbolsOptions) => Effect.Effect<SymbolListResult, TypeLevelToolsError>
  readonly getTypeInfo: (symbolName: string, packageName?: string) => Effect.Effect<TypeInfo | null, TypeLevelToolsError>
  readonly expandType: (symbolName: string, packageName?: string) => Effect.Effect<ExpandedType | null, TypeLevelToolsError>
  readonly findRelated: (symbolName: string, packageName?: string) => Effect.Effect<RelatedInfo | null, TypeLevelToolsError>
  readonly searchTypes: (options: SearchTypesOptions) => Effect.Effect<readonly TypeInfo[], TypeLevelToolsError>
  readonly evalType: (expression: string, packageName?: string) => Effect.Effect<unknown, TypeLevelToolsError>
  readonly checkSnippet: (code: string, packageName?: string) => Effect.Effect<SnippetCheckResult, TypeLevelToolsError>
  readonly getFileDeclarations: (
    file: string,
    options?: { readonly symbol?: string; readonly includePrivate?: boolean; readonly packageName?: string },
  ) => Effect.Effect<FileInspectionResult | null, TypeLevelToolsError>
  readonly checkCompatibility: (
    from: string,
    to: string,
    packageName?: string,
  ) => Effect.Effect<CompatibilityResult, TypeLevelToolsError>
  readonly generateGraph: (
    symbol: string,
    options?: { readonly depth?: number; readonly format?: "mermaid" | "dot"; readonly packageName?: string },
  ) => Effect.Effect<GraphResult | null, TypeLevelToolsError>
  readonly previewRefactor: (options: RefactorPreviewOptions) => Effect.Effect<RefactorPreviewResult, TypeLevelToolsError>
  readonly getDiagnostics: (
    packageNameOrOptions?: string | DiagnosticOptions,
  ) => Effect.Effect<readonly DiagnosticInfo[] | unknown, TypeLevelToolsError>
  readonly getTypeAtPosition: (
    filePath: string,
    line: number,
    column: number,
    packageName?: string,
  ) => Effect.Effect<TypeAtPositionResult | null, TypeLevelToolsError>
  readonly explainError: (
    options: ErrorExplanationOptions,
  ) => Effect.Effect<ErrorExplanationResult | null, TypeLevelToolsError>
  readonly explainType: (expression: string, packageName?: string) => Effect.Effect<TypeExplanationResult, TypeLevelToolsError>
  readonly transformSearch: (
    options: TransformSearchOptions & { readonly packageName?: string },
  ) => Effect.Effect<string, TypeLevelToolsError>
  readonly refresh: (packageName?: string) => Effect.Effect<string, TypeLevelToolsError>
  readonly markDirty: () => void
}

export const createTypeAnalyzer = (rootDirectory: string): TypeAnalyzer => {
  const absoluteRootDirectory = resolve(rootDirectory)
  const projectManager = new ProjectManager(absoluteRootDirectory)
  const fromPromise = <A>(try_: () => Promise<A>): Effect.Effect<A, TypeLevelToolsError> =>
    Effect.tryPromise({
      try: try_,
      catch: (cause) =>
        new TypeLevelToolsError({
          message: cause instanceof Error ? cause.message : String(cause),
          cause,
        }),
    })

  const searchTypes = (options: SearchTypesOptions): Effect.Effect<readonly TypeInfo[], TypeLevelToolsError> =>
    Effect.gen(function* () {
      const symbolOptions: Mutable<ListSymbolsOptions> = { limit: options.limit ?? 25 }
      if (options.query !== undefined) symbolOptions.pattern = options.query
      if (options.packageName !== undefined) symbolOptions.packageName = options.packageName
      const symbols = yield* fromPromise(() => projectManager.listSymbols(symbolOptions))
      const results = yield* Effect.forEach(
        symbols.symbols,
        (symbol) => fromPromise(() => projectManager.getTypeInfo(symbol.name, symbol.package)),
        { concurrency: 4 },
      )

      return results.filter((item): item is NonNullable<typeof item> => item !== null)
    })

  return {
    getPackages: () => fromPromise(() => projectManager.getPackages()),
    listSymbols: (options = {}) => fromPromise(() => projectManager.listSymbols({ limit: 100, ...options })),
    getTypeInfo: (symbolName, packageName) => fromPromise(() => projectManager.getTypeInfo(symbolName, packageName)),
    expandType: (symbolName, packageName) =>
      fromPromise(async () => {
        const expanded = await projectManager.expandType(symbolName, packageName)
        return expanded === null ? null : { ...expanded, properties: expanded.properties ?? [] }
      }),
    findRelated: (symbolName, packageName) => fromPromise(() => projectManager.findRelated(symbolName, packageName)),
    searchTypes,
    evalType: (expression, packageName) => fromPromise(() => projectManager.evalType(expression, packageName)),
    checkSnippet: (code, packageName) => fromPromise(() => projectManager.checkSnippet(code, packageName)),
    getFileDeclarations: (file, options = {}) =>
      fromPromise(() => projectManager.getFileDeclarations(file, options)),
    checkCompatibility: (from, to, packageName) =>
      fromPromise(() => projectManager.checkCompatibility(from, to, packageName)),
    generateGraph: (symbol, options = {}) => fromPromise(() => projectManager.generateGraph(symbol, options)),
    previewRefactor: (options) => fromPromise(() => projectManager.previewRefactor(options)),
    getDiagnostics: (packageNameOrOptions) =>
      fromPromise(() => {
        if (typeof packageNameOrOptions === "object" && packageNameOrOptions?.explain === true) {
          return projectManager.getPackageDiagnostics(packageNameOrOptions.packageName).then(async (diagnostics) => {
            const errors = await Promise.all(
              diagnostics.slice(0, 10).map(async (diagnostic) => ({
                ...diagnostic,
                explanation: await projectManager.explainError({
                  code: diagnostic.code,
                  message: diagnostic.message,
                  ...(packageNameOrOptions.packageName === undefined
                    ? {}
                    : { packageName: packageNameOrOptions.packageName }),
                }),
              })),
            )
            return {
              totalErrors: diagnostics.length,
              explained: errors.length,
              truncated: diagnostics.length > 10,
              errors,
            }
          })
        }
        return projectManager.getPackageDiagnostics(
          typeof packageNameOrOptions === "string" ? packageNameOrOptions : packageNameOrOptions?.packageName,
        )
      }),
    getTypeAtPosition: (filePath, line, column, packageName) =>
      fromPromise(() => projectManager.getTypeAtPosition(filePath, line, column, packageName)),
    explainError: (options) => fromPromise(() => projectManager.explainError(options)),
    explainType: (expression, packageName) => fromPromise(() => projectManager.explainType(expression, packageName)),
    transformSearch: (options) =>
      fromPromise(async () => {
        const pkg = await projectManager.resolvePackagePublic(options.packageName)
        const project = projectManager.getProjectPublic(pkg)
        const sourceFiles = projectManager.getSourceFilesPublic(project, pkg)
        const engine = new TransformSearchEngine(project, pkg.path, sourceFiles)
        const result = await engine.search(options)
        return formatResults(result)
      }),
    refresh: (packageName) =>
      fromPromise(async () => {
        if (packageName !== undefined) {
          await projectManager.refreshPackage(packageName)
          return `Refreshed TypeScript project for "${packageName}". Next type query will use fresh AST.`
        }
        projectManager.refreshAll()
        return "Refreshed all TypeScript projects. Next type queries will use fresh AST."
      }),
    markDirty: () => projectManager.markDirty(),
  }
}
