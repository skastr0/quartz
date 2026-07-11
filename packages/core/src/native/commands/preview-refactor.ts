import { Effect } from "effect"
import type { TypeAnalyzer } from "../../analyzer"
import type { NativeCommandContext } from "../context"
import { QuartzError } from "../../errors"
import { buildNativeRenameResult, findNativeRenameSites, isIdentifierRename, loadNativeTarget } from "../references"

/**
 * Native `previewRefactor` — not yet implemented. Its owning builder replaces this
 * body; the delegator in `native/index.ts` stays frozen. Until then it returns
 * the engine-not-supported error so callers get a clean, actionable failure.
 */
export const previewRefactor =
  (ctx: NativeCommandContext): TypeAnalyzer["previewRefactor"] =>
  (options) =>
    Effect.try({
      try: () => {
        if (!isIdentifierRename(options.symbol) || !isIdentifierRename(options.to)) {
          throw new QuartzError({
            message: "The native refactor preview only supports identifier-only renames.",
            cause: { kind: "engine-not-supported", command: "previewRefactor: non-identifier rename" },
          })
        }
        const target = loadNativeTarget(ctx, options.packageName, options.symbol)
        if (target === null) {
          return {
            action: "rename",
            from: options.symbol,
            to: options.to,
            locations: [],
            totalLocations: 0,
            predictedErrors: [],
            confidence: "low",
            safe: false,
            safetyNotes: [`Symbol "${options.symbol}" not found`],
            stringLiteralLocations: [],
            commentLocations: [],
          }
        }
        return buildNativeRenameResult(ctx, target, options.symbol, options.to, findNativeRenameSites(target))
      },
      catch: (cause) => cause instanceof QuartzError ? cause : new QuartzError({ message: "Could not preview refactor", cause }),
    })
