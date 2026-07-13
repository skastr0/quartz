export type DiagnosticSeverity = "error" | "warning" | "suggestion" | "message"

export interface EngineDiagnostic {
  readonly file: string | null
  readonly line: number | null
  readonly column: number | null
  readonly endLine: number | null
  readonly endColumn: number | null
  readonly code: number
  readonly severity: DiagnosticSeverity
  readonly message: string
}

export interface WorkspaceFileChanges {
  readonly changed?: readonly string[]
  readonly created?: readonly string[]
  readonly deleted?: readonly string[]
}

export interface WorkspaceMetadata {
  readonly root: string
  readonly configFile: string
  readonly configFiles: readonly string[]
  readonly revision: number
  readonly analysisTypescriptVersion: string
  readonly closed: boolean
}

export interface WorkspaceOptions {
  readonly tsconfigPath?: string
  readonly tsconfigPaths?: readonly string[]
  readonly collectTiming?: boolean
  readonly tsserverPath?: string
}
