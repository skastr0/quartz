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
  readonly category?: string
  readonly file?: string
  readonly line?: number
  readonly column?: number
}

export interface EvaluatedTypeResult {
  readonly result: string
  readonly expanded: string
}

export interface TypeEvaluationError {
  readonly error: string
}

export type TypeEvaluationResult = EvaluatedTypeResult | TypeEvaluationError

export interface ExplainedDiagnosticInfo extends DiagnosticInfo {
  readonly explanation: ErrorExplanationResult | null
}

export interface ExplainedDiagnosticsResult {
  readonly totalErrors: number
  readonly explained: number
  readonly truncated: boolean
  readonly errors: readonly ExplainedDiagnosticInfo[]
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
  readonly evalType: (expression: string, packageName?: string) => Effect.Effect<TypeEvaluationResult, QuartzError>
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
  ) => Effect.Effect<readonly DiagnosticInfo[] | ExplainedDiagnosticsResult, QuartzError>
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
  readonly markDirty: () => Effect.Effect<void, QuartzError>
}
