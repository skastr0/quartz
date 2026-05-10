import { resolve } from "node:path"
import { Effect } from "effect"
import type { PackageInfo } from "./discovery"
import { QuartzError } from "./errors"
import type { ProjectWorkspaceState } from "./project-workspace"
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
import type { TransformSearchOptions } from "./transform-search"

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

type ServiceOwnedAnalyzerKey =
  | "getPackages"
  | "getTypeInfo"
  | "expandType"
  | "searchTypes"
  | "evalType"
  | "checkSnippet"
  | "getFileDeclarations"
  | "getTypeAtPosition"
  | "findRelated"
  | "checkCompatibility"
  | "generateGraph"
  | "previewRefactor"
  | "getDiagnostics"
  | "explainError"
  | "explainType"
  | "transformSearch"

export type LegacyProjectAnalyzer = Omit<TypeAnalyzer, ServiceOwnedAnalyzerKey>

export const createLegacyTypeAnalyzerWithWorkspace = (
  rootDirectory: string,
  workspace?: ProjectWorkspaceState,
): LegacyProjectAnalyzer => {
  const absoluteRootDirectory = resolve(rootDirectory)
  const projectManager = new ProjectManager(absoluteRootDirectory, workspace)

  return {
    listSymbols: (options = {}) => fromProjectPromise(() => projectManager.listSymbols({ limit: 100, ...options })),
    refresh: (packageName) => refreshAnalyzer(projectManager, packageName),
    markDirty: () => projectManager.markDirty(),
  }
}

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
