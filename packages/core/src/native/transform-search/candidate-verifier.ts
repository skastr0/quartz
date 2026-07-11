import type { PackageInfo } from "../../discovery"
import type { AssignabilityCheckResult, CallableId } from "../../transform-search"
import type { NativeCommandContext } from "../context"
import { shouldSkipNativeSyntheticCheck } from "./synthetic-policy"
import { verifyNativeCandidate } from "./synthetic-verifier"
import type { NativeCallableIndex, NativeParsedQuery, NativeSyntheticCheckResult } from "./types"
import { createNativeVerificationEvidence } from "./verification"

export const verifyNativeCandidates = (
  ctx: NativeCommandContext,
  pkg: PackageInfo,
  query: NativeParsedQuery,
  index: NativeCallableIndex,
  candidates: AssignabilityCheckResult[],
): Map<CallableId, NativeSyntheticCheckResult> => {
  const checks = new Map<CallableId, NativeSyntheticCheckResult>()
  for (const candidate of candidates.slice(0, 50)) {
    const entry = index.entries[candidate.candidateId]
    if (entry === undefined) continue
    const skip = shouldSkipNativeSyntheticCheck(entry, candidate)
    if (query.from?.raw === undefined || query.to?.raw === undefined) {
      checks.set(candidate.candidateId, createNativeVerificationEvidence(candidate.candidateId, skip.skip && skip.status !== "verified"
        ? { status: skip.status, method: skip.method, reason: skip.reason }
        : { status: "unverified", method: "assignability_only", reason: "partial_query" }))
    } else if (skip.skip) {
      checks.set(candidate.candidateId, createNativeVerificationEvidence(candidate.candidateId, { status: skip.status, method: skip.method, reason: skip.reason }))
    } else {
      checks.set(candidate.candidateId, verifyNativeCandidate(ctx, pkg, entry, candidate, query.from.raw, query.to.raw, query.unwrapReturn))
    }
  }
  return checks
}
