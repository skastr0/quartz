import { Effect } from "effect"
import type { TypeAnalyzer } from "../../analyzer"
import { QuartzError } from "../../errors"
import { formatResults } from "../../transform-search"
import type { NativeCommandContext } from "../context"
import { resolvePackage } from "../snippet-helpers"
import { searchNativeTransforms } from "../transform-search/search-engine"

/**
 * Native structural transform search. Enumeration and token extraction stay on
 * the local native AST; only checker-backed signature/type operations cross the
 * tsgo RPC boundary.
 */
export const transformSearch =
  (ctx: NativeCommandContext): TypeAnalyzer["transformSearch"] =>
  (options) =>
    Effect.gen(function* () {
      const pkg = yield* resolvePackage(ctx, options.packageName)
      return yield* Effect.try({
        try: () => formatResults(searchNativeTransforms(ctx, pkg, options)),
        catch: (cause) => new QuartzError({ message: "Could not search native transforms", cause }),
      })
    })
