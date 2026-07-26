export type QuartzEngineErrorCode =
  | "WORKSPACE_CLOSED"
  | "WORKSPACE_OPEN_FAILED"
  | "WORKSPACE_REFRESH_FAILED"
  | "TRANSFORM_QUERY_UNRESOLVED"

export class QuartzEngineError extends Error {
  readonly code: QuartzEngineErrorCode
  readonly cause: unknown

  constructor(code: QuartzEngineErrorCode, message: string, cause?: unknown) {
    super(message)
    this.name = "QuartzEngineError"
    this.code = code
    this.cause = cause
  }
}
