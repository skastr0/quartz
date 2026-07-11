import type { PackageInfo } from "../../discovery"
import { QuartzError } from "../../errors"
import {
  buildCallableIndex,
  selectCandidates,
  type TransformSearchOptions,
  type TransformSearchResponse,
  type TransformSearchResult,
} from "../../transform-search"
import type { NativeCommandContext } from "../context"
import { getWorkspaceSourceFiles } from "../symbol-resolution"
import { filterNativeAssignability } from "./assignability-filter"
import { verifyNativeCandidates } from "./candidate-verifier"
import { enumerateNativeCallables } from "./enumerate"
import { parseNativeQuery } from "./query-parser"
import { createNativeTransformResponse } from "./response"
import { createNativeTransformResult } from "./results"
import { resolveNativeSignatures } from "./signature-resolver"
import type { NativeCallableIndex } from "./types"

export const searchNativeTransforms = (
  ctx: NativeCommandContext,
  pkg: PackageInfo,
  options: TransformSearchOptions,
): TransformSearchResponse => {
  const started = performance.now()
  const timing = { indexLookupMs: 0, resolutionMs: 0, assignabilityMs: 0, syntheticMs: 0, totalMs: 0 }
  const session = parseNativeQuery(ctx, pkg, options)
  try {
    const query = session.parsed
    if (!query.isValid) throw new QuartzError({ message: `Invalid query: ${query.validationErrors.join(", ")}` })
    const sourceFiles = getWorkspaceSourceFiles(session.snippet.program, pkg).filter((sourceFile) => !sourceFile.fileName.includes("__quartz_snippet_"))
    const enumeration = enumerateNativeCallables(sourceFiles, pkg.path, session.snippet.project)
    const index = buildCallableIndex(enumeration.entries) as NativeCallableIndex

    const indexStarted = performance.now()
    const indexedCandidateIds = selectCandidates(index, {
      ...(query.from === null ? {} : { fromTokens: query.from.tokens, fromPropKeys: query.from.propKeys }),
      ...(query.to === null ? {} : { toTokens: query.to.tokens, toPropKeys: query.to.propKeys }),
      exportedOnly: query.exportedOnly,
      budget: 1500,
    })
    // A structural query can name properties while a candidate only names an
    // alias (for example `{ id: string }` against `User`). The token index has
    // no sound way to connect those without the checker, so an empty indexed
    // intersection falls back to the bounded exported set.
    const candidateIds = indexedCandidateIds.length > 0
      ? indexedCandidateIds
      : selectCandidates(index, { exportedOnly: query.exportedOnly, budget: 1500 })
    timing.indexLookupMs = performance.now() - indexStarted

    const resolutionStarted = performance.now()
    const resolved = resolveNativeSignatures(candidateIds, index, session.snippet.project)
    timing.resolutionMs = performance.now() - resolutionStarted

    const assignabilityStarted = performance.now()
    const assignable = filterNativeAssignability(resolved, {
      fromType: query.from?.resolvedType ?? null,
      toType: query.to?.resolvedType ?? null,
      paramPosition: query.paramPosition,
      unwrapReturn: query.unwrapReturn,
      allowTypeErasure: options.allowTypeErasure ?? false,
    }, session.snippet.project)
    timing.assignabilityMs = performance.now() - assignabilityStarted

    const syntheticStarted = performance.now()
    const checks = verifyNativeCandidates(ctx, pkg, query, index, assignable)
    timing.syntheticMs = performance.now() - syntheticStarted

    const results = assignable
      .map((candidate) => {
        const entry = index.entries[candidate.candidateId]
        return entry === undefined ? null : createNativeTransformResult(entry, candidate, checks.get(candidate.candidateId) ?? null, query, options, resolved)
      })
      .filter((result): result is TransformSearchResult => result !== null)
      .sort((left, right) => right.score - left.score)
    timing.totalMs = performance.now() - started
    return createNativeTransformResponse(options, query, candidateIds.length, assignable.length, results, timing)
  } finally {
    session.dispose()
  }
}
