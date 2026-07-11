import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import { discoverPackagesSync } from "../packages/core/src/discovery"
import {
  createProjectWorkspaceState,
  getCachedProject,
  kindToString,
  workspaceRelativePath,
} from "../packages/core/src/project-workspace"
import { findSymbolInWorkspace } from "../packages/core/src/symbol-lookup"
import {
  expandTypeForSymbol,
  getTypeInfoForSymbol,
  type SymbolAnalysisContext,
} from "../packages/core/src/symbol-file-snippet-analysis"
import { createNativeEngine } from "../packages/core/src/native/engine"
import { expandType } from "../packages/core/src/native/commands/expand-type"
import { getTypeInfo } from "../packages/core/src/native/commands/get-type-info"
import { isNativeRuntimeSupported } from "../packages/core/src/native/runtime"

const here = dirname(fileURLToPath(import.meta.url))
const fixturesRoot = join(here, "fixtures")

describe.runIf(isNativeRuntimeSupported())("native info and expand", () => {
  it("matches morph envelopes for representative fixture symbols", async () => {
    const workspace = createProjectWorkspaceState(fixturesRoot)
    const packageInfo = discoverPackagesSync(fixturesRoot)[0]!
    const morphProject = getCachedProject(workspace, packageInfo)
    const morphContext: SymbolAnalysisContext = {
      rootDirectory: fixturesRoot,
      kindToString,
      relativePath: (filePath: string) => workspaceRelativePath(workspace, filePath),
    }
    const nativeEngine = createNativeEngine(fixturesRoot)
    const nativeContext = { rootDirectory: fixturesRoot, engine: nativeEngine }
    try {
      for (const symbol of [
        "User",
        "User.name",
        "@file:types/basic.ts:internalHelper",
        "RefactorableUser",
        "Role",
        "DefaultExportedClass",
        "UserService",
        "UserSummary",
      ]) {
        const morphFound = findSymbolInWorkspace(workspace, symbol, morphProject, packageInfo)
        const morphInfo = morphFound === null ? null : getTypeInfoForSymbol(morphFound, packageInfo, morphContext)
        const nativeInfo = await Effect.runPromise(getTypeInfo(nativeContext)(symbol))
        expect(normalizeCompilerFormatting(nativeInfo), `getTypeInfo(${symbol})`).toEqual(
          normalizeCompilerFormatting(morphInfo),
        )

        const morphExpanded = morphFound === null ? null : expandTypeForSymbol(morphFound, morphProject, morphContext)
        const nativeExpanded = await Effect.runPromise(expandType(nativeContext)(symbol))
        expect(normalizeCompilerFormatting(nativeExpanded), `expandType(${symbol})`).toEqual(
          normalizeCompilerFormatting(morphExpanded),
        )
      }
    } finally {
      nativeEngine.dispose()
    }
  })
})

const normalizeCompilerFormatting = (value: unknown): unknown => {
  if (typeof value === "string" && value.includes(" | ")) {
    return value.split(" | ").sort().join(" | ")
  }
  if (Array.isArray(value)) return value.map(normalizeCompilerFormatting)
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [key, normalizeCompilerFormatting(nested)]),
    )
  }
  return value
}
