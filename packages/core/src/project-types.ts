import type { TransformSearchResponse } from "./transform-search";
import type { PackageRef, SymbolRef, TypeExpressionRef } from "./boundary-refs";

export interface SymbolInfo {
  name: string;
  kind: string;
  file: string;
  line?: number;
  package?: string;
  isIndexExport?: boolean;
}

export interface SymbolListResult {
  symbols: SymbolInfo[];
  total: number;
  truncated: boolean;
  package: string;
}

export interface ListSymbolsOptions {
  pattern?: string;
  kind?: string;
  packageName?: string;
  file?: string;
  limit?: number;
  indexOnly?: boolean;
}

export interface TypeInfo {
  name: string;
  kind: string;
  type: string;
  signature?: string;
  properties?: Array<{ name: string; type: string; optional?: boolean }>;
  constructors?: string[];
  location: { file: string; line: number };
  package?: string;
}

export interface ExpandedType {
  original: string;
  expanded: string;
  properties?: Array<{ name: string; type: string; from?: string }>;
}

export interface RelatedInfo {
  symbol: string;
  referencedBy: Array<{ symbol: string; context: string; file: string; line: number }>;
  references: Array<{ symbol: string; context: string }>;
}

export interface FileDeclarationInfo {
  name: string;
  kind: string;
  line: number;
  exported: boolean;
  isDefaultExport: boolean;
  exportedAs?: string;
  type?: string;
  signature?: string;
}

export interface FileInspectionResult {
  file: string;
  package: string;
  declarations: FileDeclarationInfo[];
  total: number;
}

export interface FileExportMetadata {
  exportedNames: Set<string>;
  defaultExportNames: Set<string>;
  exportAliases: Map<string, string>;
}

export interface CompatibilityResult {
  compatible: boolean;
  from: string;
  to: string;
  reason?: string;
  issues?: ErrorExplanationIssue[];
}

export interface VerifyContractOptions {
  from?: string;
  to?: string;
  symbol?: string;
  snippet?: string;
  packageName?: string;
  includeDiagnostics?: boolean;
  includeTransformEvidence?: boolean;
  transformLimit?: number;
}

export interface ParsedVerifyContractInput {
  from?: TypeExpressionRef;
  to?: TypeExpressionRef;
  symbol?: SymbolRef;
  packageName?: PackageRef;
  snippet?: string;
  includeDiagnostics?: boolean;
  includeTransformEvidence?: boolean;
  transformLimit?: number;
}

export type VerifyContractCheckKey = "compatibility" | "snippet" | "diagnostics" | "transform";

export interface VerifyContractCheck<T = unknown> {
  ran: boolean;
  passed: boolean | null;
  blocking: boolean;
  summary: string;
  evidence?: T;
}

export interface VerifyContractDiagnostic {
  file: string;
  line: number;
  column: number;
  message: string;
  code: number;
}

export interface VerifyContractEvidence {
  compatibility?: CompatibilityResult;
  snippet?: SnippetCheckResult;
  diagnostics?: VerifyContractDiagnostic[];
  transformSearch?: TransformSearchResponse;
  explanations?: ErrorExplanationResult[];
}

export interface VerifyContractResult {
  schemaVersion: "verify-contract/v1";
  ok: boolean;
  contract: {
    from?: string;
    to?: string;
    symbol?: string;
    package: string;
  };
  checks: Record<VerifyContractCheckKey, VerifyContractCheck>;
  evidence: VerifyContractEvidence;
  gaps: string[];
  next_steps: string[];
}

export interface GraphEdge {
  from: string;
  to: string;
  label?: string;
}

export interface GraphResult {
  root: string;
  format: "mermaid" | "dot";
  depth: number;
  nodes: string[];
  edges: GraphEdge[];
  graph: string;
}

export interface RefactorLocation {
  file: string;
  line: number;
  column: number;
  before: string;
  after: string;
}

export interface RefactorError {
  file: string;
  line: number;
  message: string;
}

export interface StringLiteralRef {
  file: string;
  line: number;
  content: string;
}

export interface RefactorPreviewResult {
  action: "rename";
  from: string;
  to: string;
  locations: RefactorLocation[];
  totalLocations: number;
  predictedErrors: RefactorError[];
  confidence: "high" | "medium" | "low";
  safe: boolean;
  safetyNotes: string[];
  stringLiteralLocations: StringLiteralRef[];
  commentLocations: StringLiteralRef[];
}

export interface SnippetDiagnostic {
  message: string;
  line: number;
  column: number;
  severity: "error" | "warning";
}

export interface TypeAtPositionResult {
  type: string;
  expanded: string;
  nodeKind: string;
  nodeText: string;
  location: { file: string; line: number; column: number };
}

export interface SnippetCheckResult {
  valid: boolean;
  errors?: SnippetDiagnostic[];
}

export interface SnippetExportSource {
  filePath: string;
  absolutePath: string;
  isDefault: boolean;
}

export interface SnippetImportPlan {
  fileContent: string;
  importLineCount: number;
}

export interface ErrorExplanationIssue {
  kind: "missing_property" | "type_mismatch" | "excess_property" | "not_callable" | "other";
  property?: string;
  expectedType?: string;
  actualType?: string;
  message: string;
}

export interface ErrorExplanationResult {
  error: {
    code: number;
    message: string;
  };
  explanation: string;
  types?: {
    from?: { name: string; expanded: string };
    to?: { name: string; expanded: string };
    target?: { name: string; expanded: string };
  };
  issues: ErrorExplanationIssue[];
  suggestions: string[];
}

export interface TypeExplanationStep {
  step: number;
  description: string;
  expression: string;
  result: string;
}

export interface TypeExplanationResult {
  expression: string;
  steps: TypeExplanationStep[];
  final: string;
}

export type TypeExpressionComponent =
  | { type: "keyof"; target: string }
  | { type: "utility"; utility: string; args: string[] }
  | { type: "base"; name: string };
