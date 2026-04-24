import { Data } from "effect"

export class TypeLevelToolsError extends Data.TaggedError("TypeLevelToolsError")<{
  readonly message: string
  readonly cause?: unknown
}> {}

