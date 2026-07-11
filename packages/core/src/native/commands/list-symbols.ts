import { Effect } from "effect"
import type { TypeAnalyzer } from "../../analyzer"
import type { NativeCommandContext } from "../context"
import { engineNotSupported } from "../errors"

/**
 * Native `listSymbols` — not yet implemented. Its owning builder replaces this
 * body; the delegator in `native/index.ts` stays frozen. Until then it returns
 * the engine-not-supported error so callers get a clean, actionable failure.
 */
export const listSymbols =
  (_ctx: NativeCommandContext): TypeAnalyzer["listSymbols"] =>
  () =>
    Effect.fail(engineNotSupported("listSymbols"))
