import type {
  TransformSearchOptions,
  TransformSearchResponse,
  TransformSearchResult,
  VerificationStatus,
} from "../../transform-search"
import type { NativeParsedQuery } from "./types"

export const createNativeTransformResponse = (
  options: TransformSearchOptions,
  query: NativeParsedQuery,
  candidateCount: number,
  assignableCount: number,
  results: TransformSearchResult[],
  timing: TransformSearchResponse["stats"]["timing"],
): TransformSearchResponse => {
  const limited = results.slice(0, query.limit)
  const verification: Record<VerificationStatus, number> = { verified: 0, unverified: 0, unverifiable: 0 }
  for (const result of results) verification[result.verification.status]++
  return {
    results: limited,
    query: {
      from: options.from ?? null,
      to: options.to ?? null,
      options: {
        paramPosition: query.paramPosition,
        unwrapReturn: query.unwrapReturn,
        exportedOnly: query.exportedOnly,
        ...(options.verifiedOnly === undefined ? {} : { verifiedOnly: options.verifiedOnly }),
        ...(options.minVerificationStatus === undefined ? {} : { minVerificationStatus: options.minVerificationStatus }),
        ...(options.includeDiagnostics === undefined ? {} : { includeDiagnostics: options.includeDiagnostics }),
        ...(options.includeSyntheticCode === undefined ? {} : { includeSyntheticCode: options.includeSyntheticCode }),
        ...(options.includeFailedVerification === undefined ? {} : { includeFailedVerification: options.includeFailedVerification }),
      },
    },
    stats: {
      totalCandidates: candidateCount,
      assignableMatches: assignableCount,
      verifiedMatches: results.length,
      verification,
      returned: limited.length,
      timing,
    },
  }
}
