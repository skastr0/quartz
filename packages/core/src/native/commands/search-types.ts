import { Effect } from "effect"
import type { TypeAnalyzer } from "../../analyzer"
import { discoverPackages } from "../../discovery"
import { QuartzError } from "../../errors"
import type { NativeCommandContext } from "../context"
import { findNativeSymbol, getWorkspaceSourceFiles, resolvePackage } from "../symbol-resolution"
import { getTypeInfo } from "./get-type-info"
import { listSymbols } from "./list-symbols"
import { typeForNode } from "./get-type-info"

/**
 * Native `searchTypes` — not yet implemented. Its owning builder replaces this
 * body; the delegator in `native/index.ts` stays frozen. Until then it returns
 * the engine-not-supported error so callers get a clean, actionable failure.
 */
export const searchTypes =
  (ctx: NativeCommandContext): TypeAnalyzer["searchTypes"] =>
  (options) =>
    Effect.gen(function* () {
      const pattern = options.pattern ?? options.query
      const limit = options.limit ?? 25
      const listed = yield* listSymbols(ctx)({
        ...(pattern === undefined ? {} : { pattern }),
        ...(options.packageName === undefined ? {} : { packageName: options.packageName }),
        kind: "all",
        limit: 1000,
      })
      const packages = yield* discoverPackages(ctx.rootDirectory)
      const packageInfo = yield* Effect.try({
        try: () => resolvePackage(packages, options.packageName),
        catch: (cause) => new QuartzError({ message: "Could not resolve search package", cause }),
      })
      const project = ctx.engine.getProject(packageInfo.tsconfigPath)
      const sourceFiles = getWorkspaceSourceFiles(project.program, packageInfo)
      const results = []

      for (const symbol of listed.symbols) {
        const reference = `@file:${symbol.file}:${symbol.name}`
        if (options.hasProperty !== undefined || options.extends !== undefined) {
          const found = findNativeSymbol(reference, project, packageInfo, ctx.rootDirectory, sourceFiles)
          if (found === null) continue
          const type = typeForNode(found.node, found.symbol, project.checker)
          if (options.hasProperty !== undefined && project.checker.getPropertyOfType(type, options.hasProperty) === undefined) continue
          if (options.extends !== undefined) {
            const matchesBase = (type.getBaseTypes() ?? []).some((base) => {
              const baseSymbol = base.getSymbol() ?? base.getAliasSymbol()
              return baseSymbol?.name === options.extends
            })
            if (!matchesBase) continue
          }
        }
        const info = yield* getTypeInfo(ctx)(reference, options.packageName)
        if (info !== null) results.push(info)
        if (results.length >= limit) break
      }
      return results
    })
