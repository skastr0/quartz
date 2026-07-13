export interface PackageInfo {
  readonly name: string
  readonly path: string
  readonly tsconfigPath: string
}

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
  readonly constructors?: readonly string[]
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

export interface RelatedInfo {
  readonly symbol: string
  readonly referencedBy: readonly {
    readonly symbol: string
    readonly context: string
    readonly file: string
    readonly line: number
  }[]
  readonly references: readonly {
    readonly symbol: string
    readonly context: string
  }[]
}

export interface FileDeclarationInfo {
  readonly name: string
  readonly kind: string
  readonly line: number
  readonly exported: boolean
  readonly isDefaultExport: boolean
  readonly exportedAs?: string
  readonly type?: string
  readonly signature?: string
}

export interface FileInspectionResult {
  readonly file: string
  readonly package: string
  readonly declarations: readonly FileDeclarationInfo[]
  readonly total: number
}

export interface ErrorExplanationIssue {
  readonly kind: "missing_property" | "type_mismatch" | "excess_property" | "not_callable" | "other"
  readonly property?: string
  readonly expectedType?: string
  readonly actualType?: string
  readonly message: string
}

export interface CompatibilityResult {
  readonly compatible: boolean
  readonly from: string
  readonly to: string
  readonly reason?: string
  readonly issues?: readonly ErrorExplanationIssue[]
}

export interface GraphEdge {
  readonly from: string
  readonly to: string
  readonly label?: string
}

export interface GraphResult {
  readonly root: string
  readonly format: "mermaid" | "dot"
  readonly depth: number
  readonly nodes: readonly string[]
  readonly edges: readonly GraphEdge[]
  readonly graph: string
}

export interface RefactorLocation {
  readonly file: string
  readonly line: number
  readonly column: number
  readonly before: string
  readonly after: string
}

export interface RefactorError {
  readonly file: string
  readonly line: number
  readonly message: string
}

export interface StringLiteralRef {
  readonly file: string
  readonly line: number
  readonly content: string
}

export interface RefactorPreviewResult {
  readonly action: "rename"
  readonly from: string
  readonly to: string
  readonly locations: readonly RefactorLocation[]
  readonly totalLocations: number
  readonly predictedErrors: readonly RefactorError[]
  readonly confidence: "high" | "medium" | "low"
  readonly safe: boolean
  readonly safetyNotes: readonly string[]
  readonly stringLiteralLocations: readonly StringLiteralRef[]
  readonly commentLocations: readonly StringLiteralRef[]
}

export interface SnippetDiagnostic {
  readonly message: string
  readonly line: number
  readonly column: number
  readonly severity: "error" | "warning"
}

export interface SnippetCheckResult {
  readonly valid: boolean
  readonly errors?: readonly SnippetDiagnostic[]
}

export interface ErrorExplanationResult {
  readonly error: {
    readonly code: number
    readonly message: string
  }
  readonly explanation: string
  readonly types?: {
    readonly from?: { readonly name: string; readonly expanded: string }
    readonly to?: { readonly name: string; readonly expanded: string }
    readonly target?: { readonly name: string; readonly expanded: string }
  }
  readonly issues: readonly ErrorExplanationIssue[]
  readonly suggestions: readonly string[]
}

export interface ExplainedDiagnosticInfo extends DiagnosticInfo {
  readonly explanation: ErrorExplanationResult | null
}

export interface ExplainedDiagnosticsResult {
  readonly totalErrors: number
  readonly explained: number
  readonly truncated: boolean
  readonly errors: readonly ExplainedDiagnosticInfo[]
}

export interface TypeExplanationStep {
  readonly step: number
  readonly description: string
  readonly expression: string
  readonly result: string
}

export interface TypeExplanationResult {
  readonly expression: string
  readonly steps: readonly TypeExplanationStep[]
  readonly final: string
}

export type CallableKind =
  | "Function"
  | "VariableCallable"
  | "ClassMethod"
  | "StaticMethod"
  | "Constructor"
  | "ObjectMethod"
  | "InterfaceMethod"
  | "TypeLiteralMethod"
  | "CallableProperty"

export type VerificationStatus = "verified" | "unverified" | "unverifiable"
export type VerificationReason =
  | "exact_type_match"
  | "no_type_annotations"
  | "not_importable"
  | "type_erasure"
  | "synthetic_check_passed"
  | "synthetic_check_failed"
  | "partial_query"

export interface VerificationMeta {
  readonly status: VerificationStatus
  readonly method: "synthetic" | "exact_match" | "assignability_only" | null
  readonly reason: VerificationReason
  readonly diagnostics?: readonly { readonly code: number; readonly message: string }[]
  readonly syntheticCode?: string
}

export interface FromMatchDetails {
  readonly matched: boolean
  readonly paramIndex: number
  readonly paramName: string
  readonly queryType: string
  readonly paramType: string
  readonly exact: boolean
  readonly typeErasure?: boolean
}

export interface ToMatchDetails {
  readonly matched: boolean
  readonly returnType: string
  readonly queryType: string
  readonly exact: boolean
  readonly unwrapped: boolean
  readonly wrapper: "Promise" | "PromiseLike" | "Effect" | "Observable" | "Task" | null
  readonly typeErasure?: boolean
}

export type MatchConfidence = "high" | "medium" | "low"

export interface MatchExplanation {
  readonly summary: string
  readonly details: {
    readonly fromMatch?: {
      readonly description: string
      readonly paramName: string
      readonly paramIndex: number
      readonly compatibility: "exact" | "assignable" | "structural"
    }
    readonly toMatch?: {
      readonly description: string
      readonly compatibility: "exact" | "assignable" | "structural"
      readonly unwrapped?: {
        readonly wrapper: string
        readonly originalType: string
      }
    }
    readonly verification?: {
      readonly method: "synthetic" | "assignability-only"
      readonly passed: boolean
    }
  }
  readonly confidence: MatchConfidence
}

export interface TransformSearchResult {
  readonly name: string
  readonly signature: string
  readonly kind: CallableKind
  readonly file: string
  readonly line: number
  readonly exported: boolean
  readonly deprecated: boolean
  readonly score: number
  readonly confidence: MatchConfidence
  readonly explanation: MatchExplanation
  readonly verification: VerificationMeta
  readonly matchDetails: {
    readonly fromMatch: FromMatchDetails | null
    readonly toMatch: ToMatchDetails | null
  }
}

export interface TransformSearchOptions {
  readonly from?: string
  readonly to?: string
  readonly paramPosition?: number | "any"
  readonly unwrapReturn?: boolean
  readonly exportedOnly?: boolean
  readonly limit?: number
  readonly allowTypeErasure?: boolean
  readonly verifiedOnly?: boolean
  readonly minVerificationStatus?: VerificationStatus
  readonly includeDiagnostics?: boolean
  readonly includeSyntheticCode?: boolean
  readonly includeFailedVerification?: boolean
}

export interface TransformSearchResponse {
  readonly results: readonly TransformSearchResult[]
  readonly query: {
    readonly from: string | null
    readonly to: string | null
    readonly options: {
      readonly paramPosition: number | "any"
      readonly unwrapReturn: boolean
      readonly exportedOnly: boolean
      readonly verifiedOnly?: boolean
      readonly minVerificationStatus?: VerificationStatus
      readonly includeDiagnostics?: boolean
      readonly includeSyntheticCode?: boolean
      readonly includeFailedVerification?: boolean
    }
  }
  readonly stats: {
    readonly totalCandidates: number
    readonly assignableMatches: number
    readonly verifiedMatches: number
    readonly verification: Readonly<Record<VerificationStatus, number>>
    readonly returned: number
    readonly timing: {
      readonly indexLookupMs: number
      readonly resolutionMs: number
      readonly assignabilityMs: number
      readonly syntheticMs: number
      readonly totalMs: number
    }
  }
}

export interface VerifyContractOptions {
  readonly from?: string
  readonly to?: string
  readonly symbol?: string
  readonly snippet?: string
  readonly packageName?: string
  readonly includeDiagnostics?: boolean
  readonly includeTransformEvidence?: boolean
  readonly transformLimit?: number
}

export type VerifyContractCheckKey = "compatibility" | "snippet" | "diagnostics" | "transform"

export interface VerifyContractCheck<T = unknown> {
  readonly ran: boolean
  readonly passed: boolean | null
  readonly blocking: boolean
  readonly summary: string
  readonly evidence?: T
}

export interface VerifyContractDiagnostic {
  readonly file: string
  readonly line: number
  readonly column: number
  readonly message: string
  readonly code: number
}

export interface VerifyContractEvidence {
  readonly compatibility?: CompatibilityResult
  readonly snippet?: SnippetCheckResult
  readonly diagnostics?: readonly VerifyContractDiagnostic[]
  readonly transformSearch?: TransformSearchResponse
  readonly explanations?: readonly ErrorExplanationResult[]
}

export interface VerifyContractResult {
  readonly schemaVersion: "verify-contract/v1"
  readonly ok: boolean
  readonly contract: {
    readonly from?: string
    readonly to?: string
    readonly symbol?: string
    readonly package: string
  }
  readonly checks: Readonly<Record<VerifyContractCheckKey, VerifyContractCheck>>
  readonly evidence: VerifyContractEvidence
  readonly gaps: readonly string[]
  readonly next_steps: readonly string[]
}

export interface TypeAnalyzer {
  readonly getPackages: () => Promise<readonly PackageInfo[]>
  readonly listSymbols: (options?: ListSymbolsOptions) => Promise<SymbolListResult>
  readonly getTypeInfo: (symbolName: string, packageName?: string) => Promise<TypeInfo | null>
  readonly expandType: (symbolName: string, packageName?: string) => Promise<ExpandedType | null>
  readonly findRelated: (symbolName: string, packageName?: string) => Promise<RelatedInfo | null>
  readonly searchTypes: (options: SearchTypesOptions) => Promise<readonly TypeInfo[]>
  readonly evalType: (expression: string, packageName?: string) => Promise<TypeEvaluationResult>
  readonly checkSnippet: (code: string, packageName?: string) => Promise<SnippetCheckResult>
  readonly getFileDeclarations: (
    file: string,
    options?: { readonly symbol?: string; readonly includePrivate?: boolean; readonly packageName?: string },
  ) => Promise<FileInspectionResult | null>
  readonly checkCompatibility: (from: string, to: string, packageName?: string) => Promise<CompatibilityResult>
  readonly generateGraph: (
    symbol: string,
    options?: { readonly depth?: number; readonly format?: "mermaid" | "dot"; readonly packageName?: string },
  ) => Promise<GraphResult | null>
  readonly previewRefactor: (options: RefactorPreviewOptions) => Promise<RefactorPreviewResult>
  readonly getDiagnostics: (
    packageNameOrOptions?: string | DiagnosticOptions,
  ) => Promise<readonly DiagnosticInfo[] | ExplainedDiagnosticsResult>
  readonly getTypeAtPosition: (
    filePath: string,
    line: number,
    column: number,
    packageName?: string,
  ) => Promise<TypeAtPositionResult | null>
  readonly explainError: (options: ErrorExplanationOptions) => Promise<ErrorExplanationResult | null>
  readonly explainType: (expression: string, packageName?: string) => Promise<TypeExplanationResult>
  readonly transformSearch: (
    options: TransformSearchOptions & { readonly packageName?: string },
  ) => Promise<TransformSearchResponse>
  readonly verifyContract: (options: VerifyContractOptions) => Promise<VerifyContractResult>
  readonly refresh: (packageName?: string) => Promise<string>
  readonly markDirty: () => Promise<void>
}
