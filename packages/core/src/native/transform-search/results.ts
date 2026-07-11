import {
  calculateScore,
  generateExplanation,
  type AssignabilityCheckResult,
  type TransformSearchOptions,
  type TransformSearchResult,
} from "../../transform-search"
import type {
  NativeCallableEntry,
  NativeParsedQuery,
  NativeSignatureMap,
  NativeSyntheticCheckResult,
} from "./types"
import { toSharedQuery } from "./query-parser"
import { formatNativeSignature } from "./signature-format"
import { formatNativeVerification, matchesNativeVerificationFilter } from "./verification"

export const createNativeTransformResult = (
  entry: NativeCallableEntry,
  assignability: AssignabilityCheckResult,
  check: NativeSyntheticCheckResult | null,
  query: NativeParsedQuery,
  options: TransformSearchOptions,
  resolved: NativeSignatureMap,
): TransformSearchResult | null => {
  if (check?.verification.reason === "synthetic_check_failed" && options.includeFailedVerification !== true) return null
  const finalVerification = check?.verification ?? { status: "unverified", method: "assignability_only", reason: "partial_query" }
  if (!matchesNativeVerificationFilter(finalVerification.status, options)) return null
  const score = calculateScore(entry, assignability, check)
  const explanation = generateExplanation(entry, assignability, check, toSharedQuery(query))
  return {
    name: entry.qualifiedName,
    signature: formatNativeSignature(entry, assignability, resolved),
    kind: entry.kind,
    file: entry.filePath,
    line: entry.sourceFile.getLineAndCharacterOfPosition(entry.pos).line + 1,
    exported: entry.exportState === "exported",
    deprecated: entry.isDeprecated,
    score: score.total,
    confidence: explanation.confidence,
    explanation,
    verification: formatNativeVerification(finalVerification, check, options),
    matchDetails: {
      fromMatch: assignability.fromMatch,
      toMatch: assignability.toMatch,
      syntheticVerified: finalVerification.status === "verified",
    },
  }
}
