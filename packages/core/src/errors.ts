import { Data } from "effect"

export class QuartzError extends Data.TaggedError("QuartzError")<{
  readonly message: string
  readonly cause?: unknown
}> {}

