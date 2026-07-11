import { Effect } from "effect"
import type { TypeAnalyzer } from "../../analyzer"
import type { SymbolInfo } from "../../analyzer"
import { discoverPackages } from "../../discovery"
import { QuartzError } from "../../errors"
import type { NativeCommandContext } from "../context"
import { getNativeExportDeclarations } from "../export-resolution"
import { getWorkspaceSourceFiles, kindToString, relativePath, resolvePackage } from "../symbol-resolution"

/**
 * Native `listSymbols` — not yet implemented. Its owning builder replaces this
 * body; the delegator in `native/index.ts` stays frozen. Until then it returns
 * the engine-not-supported error so callers get a clean, actionable failure.
 */
export const listSymbols =
  (ctx: NativeCommandContext): TypeAnalyzer["listSymbols"] =>
  (options = {}) =>
    Effect.gen(function* () {
      const packages = yield* discoverPackages(ctx.rootDirectory)
      return yield* Effect.try({
        try: () => {
          const packageInfo = resolvePackage(packages, options.packageName)
          const project = ctx.engine.getProject(packageInfo.tsconfigPath)
          const sourceFiles = getWorkspaceSourceFiles(project.program, packageInfo)
          const namePattern = options.pattern === undefined ? null : new RegExp(options.pattern, "i")
          const filePattern = options.file === undefined ? null : new RegExp(options.file, "i")
          const limit = options.limit ?? 100
          const symbols: SymbolInfo[] = []

          for (const sourceFile of sourceFiles) {
            const file = relativePath(ctx.rootDirectory, sourceFile.fileName)
            const isIndexExport = file.endsWith("/index") || file.endsWith("/index.tsx") || file === "index" || file === "index.tsx"
            if (options.indexOnly === true && !isIndexExport) continue
            if (filePattern !== null && !filePattern.test(file)) continue

            for (const declaration of getNativeExportDeclarations(sourceFile, project)) {
              const name = declaration.exportName === "default"
                ? declaration.declarationName ?? "default"
                : declaration.exportName
              const kind = kindToString(declaration.node.kind)
              if (options.kind !== undefined && options.kind !== "all" && options.kind !== kind) continue
              if (namePattern !== null && !namePattern.test(name)) continue
              symbols.push({
                name,
                kind,
                file,
                line: declaration.node.getSourceFile().getLineAndCharacterOfPosition(declaration.node.getStart()).line + 1,
                package: packageInfo.name,
                isIndexExport,
              })
            }
          }

          symbols.sort((left, right) => {
            if (left.isIndexExport && !right.isIndexExport) return -1
            if (!left.isIndexExport && right.isIndexExport) return 1
            return left.name.localeCompare(right.name)
          })
          return {
            symbols: symbols.length > limit ? symbols.slice(0, limit) : symbols,
            total: symbols.length,
            truncated: symbols.length > limit,
            package: packageInfo.name,
          }
        },
        catch: (cause) => new QuartzError({ message: "Could not list symbols", cause }),
      })
    })
