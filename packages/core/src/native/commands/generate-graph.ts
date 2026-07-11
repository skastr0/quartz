import { Effect } from "effect"
import type { TypeAnalyzer } from "../../analyzer"
import type { NativeCommandContext } from "../context"
import { engineNotSupported } from "../errors"

/**
 * Native `generateGraph` — not yet implemented. Its owning builder replaces this
 * body; the delegator in `native/index.ts` stays frozen. Until then it returns
 * the engine-not-supported error so callers get a clean, actionable failure.
 */
export const generateGraph =
  (_ctx: NativeCommandContext): TypeAnalyzer["generateGraph"] =>
  () =>
    Effect.fail(engineNotSupported("generateGraph"))
