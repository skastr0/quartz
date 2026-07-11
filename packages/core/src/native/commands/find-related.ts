import { Effect } from "effect"
import type { TypeAnalyzer } from "../../analyzer"
import type { NativeCommandContext } from "../context"
import { QuartzError } from "../../errors"
import { findNativeRelated } from "../references"

/**
 * Native `findRelated` — not yet implemented. Its owning builder replaces this
 * body; the delegator in `native/index.ts` stays frozen. Until then it returns
 * the engine-not-supported error so callers get a clean, actionable failure.
 */
export const findRelated =
  (ctx: NativeCommandContext): TypeAnalyzer["findRelated"] =>
  (symbolName, packageName) =>
    Effect.try({
      try: () => findNativeRelated(ctx, symbolName, packageName),
      catch: (cause) => cause instanceof QuartzError ? cause : new QuartzError({ message: "Could not find related symbols", cause }),
    })
