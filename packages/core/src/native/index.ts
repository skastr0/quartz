import type { TypeAnalyzer } from "../analyzer"
import type { NativeCommandContext } from "./context"
import { createNativeEngine } from "./engine"
import { checkCompatibility } from "./commands/check-compatibility"
import { checkSnippet } from "./commands/check-snippet"
import { evalType } from "./commands/eval-type"
import { expandType } from "./commands/expand-type"
import { explainError } from "./commands/explain-error"
import { explainType } from "./commands/explain-type"
import { findRelated } from "./commands/find-related"
import { generateGraph } from "./commands/generate-graph"
import { getDiagnostics } from "./commands/get-diagnostics"
import { getFileDeclarations } from "./commands/get-file-declarations"
import { getPackages } from "./commands/get-packages"
import { getTypeAtPosition } from "./commands/get-type-at-position"
import { getTypeInfo } from "./commands/get-type-info"
import { listSymbols } from "./commands/list-symbols"
import { markDirty } from "./commands/mark-dirty"
import { previewRefactor } from "./commands/preview-refactor"
import { refresh } from "./commands/refresh"
import { searchTypes } from "./commands/search-types"
import { transformSearch } from "./commands/transform-search"
import { verifyContract } from "./commands/verify-contract"

export type { NativeCommandContext } from "./context"
export type { NativeEngine } from "./engine"
export { createNativeEngine } from "./engine"
export { nativeAnalysisTypescriptVersion } from "./version"
export { isNativeRuntimeSupported, assertNativeRuntimeSupported, describeRuntime } from "./runtime"
export {
  engineNotSupported,
  isNativeLoadFailure,
  nativeLoadFailure,
  ENGINE_NOT_SUPPORTED,
  NATIVE_LOAD_FAILURE,
} from "./errors"

export interface NativeAnalyzerHandle {
  readonly analyzer: TypeAnalyzer
  readonly dispose: () => Promise<void>
}

/**
 * The native `TypeAnalyzer`. This delegator is FROZEN after the P0 seam commit:
 * every method routes to its own `commands/<command>.ts` module, so parallel
 * builders implementing different commands never edit the same file. To add a
 * capability, replace the body of the matching command module — not this map.
 *
 * The engine (`tsgo` server) is created here but only *spawns* on the first real
 * project load, so constructing a native analyzer is cheap and side-effect free.
 */
export const createNativeTypeAnalyzer = (rootDirectory: string): NativeAnalyzerHandle => {
  const engine = createNativeEngine(rootDirectory)
  const context: NativeCommandContext = { rootDirectory, engine }

  const analyzer: TypeAnalyzer = {
    getPackages: getPackages(context),
    listSymbols: listSymbols(context),
    getTypeInfo: getTypeInfo(context),
    expandType: expandType(context),
    findRelated: findRelated(context),
    searchTypes: searchTypes(context),
    evalType: evalType(context),
    checkSnippet: checkSnippet(context),
    getFileDeclarations: getFileDeclarations(context),
    checkCompatibility: checkCompatibility(context),
    generateGraph: generateGraph(context),
    previewRefactor: previewRefactor(context),
    getDiagnostics: getDiagnostics(context),
    getTypeAtPosition: getTypeAtPosition(context),
    explainError: explainError(context),
    explainType: explainType(context),
    transformSearch: transformSearch(context),
    verifyContract: verifyContract(context),
    refresh: refresh(context),
    markDirty: markDirty(context),
  }

  return {
    analyzer,
    dispose: async () => {
      engine.dispose()
    },
  }
}
