import { QuartzError } from "../errors"

/**
 * Discriminants attached to the `cause` of native-engine QuartzErrors so that
 * callers (and, later, per-command fallback logic) can pattern-match the reason
 * without parsing message strings.
 */
export const ENGINE_NOT_SUPPORTED = "engine-not-supported" as const
export const NATIVE_LOAD_FAILURE = "native-load-failure" as const

export interface EngineNotSupportedCause {
  readonly kind: typeof ENGINE_NOT_SUPPORTED
  readonly command: string
}

export interface NativeLoadFailureCause {
  readonly kind: typeof NATIVE_LOAD_FAILURE
  readonly reason?: unknown
}

/**
 * The error every not-yet-implemented native command returns. It is deliberately
 * actionable: it names the capability and points at the escape hatch (the morph
 * engine) so an operator is never stuck.
 */
export const engineNotSupported = (command: string): QuartzError =>
  new QuartzError({
    message:
      `The native TypeScript engine does not yet support "${command}". ` +
      `Set QUARTZ_ENGINE=morph to use the ts-morph engine until the native command is implemented.`,
    cause: { kind: ENGINE_NOT_SUPPORTED, command } satisfies EngineNotSupportedCause,
  })

/**
 * Raised when the native engine cannot start or load a project. This is the
 * signal that engine selection uses to fall back to the morph engine (for
 * example on an unsupported runtime or a legacy tsconfig).
 */
export const nativeLoadFailure = (message: string, reason?: unknown): QuartzError =>
  new QuartzError({
    message,
    cause: { kind: NATIVE_LOAD_FAILURE, ...(reason === undefined ? {} : { reason }) } satisfies NativeLoadFailureCause,
  })

/** Type guard: was this QuartzError produced because the native engine could not load? */
export const isNativeLoadFailure = (error: QuartzError): boolean =>
  typeof error.cause === "object" &&
  error.cause !== null &&
  (error.cause as { kind?: unknown }).kind === NATIVE_LOAD_FAILURE
