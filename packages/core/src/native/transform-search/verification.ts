import type {
  CallableId,
  TransformSearchOptions,
  VerificationMeta,
  VerificationStatus,
} from "../../transform-search"
import type { NativeSyntheticCheckResult } from "./types"

const verificationRank: Record<VerificationStatus, number> = { unverifiable: 0, unverified: 1, verified: 2 }

export const createNativeVerificationEvidence = (
  candidateId: CallableId,
  verification: VerificationMeta,
): NativeSyntheticCheckResult => ({
  candidateId,
  verified: verification.status === "verified",
  verification,
  diagnostics: verification.diagnostics ?? [],
  syntheticCode: "",
})

export const matchesNativeVerificationFilter = (status: VerificationStatus, options: TransformSearchOptions): boolean => {
  const minimum = options.verifiedOnly === true ? "verified" : options.minVerificationStatus
  return minimum === undefined || verificationRank[status] >= verificationRank[minimum]
}

export const formatNativeVerification = (
  value: VerificationMeta,
  check: NativeSyntheticCheckResult | null,
  options: TransformSearchOptions,
): VerificationMeta => {
  const { diagnostics: _diagnostics, syntheticCode: _syntheticCode, ...base } = value
  return {
    ...base,
    ...(options.includeDiagnostics === true && check !== null && check.diagnostics.length > 0 ? { diagnostics: check.diagnostics } : {}),
    ...(options.includeSyntheticCode === true && check !== null && check.syntheticCode.length > 0 ? { syntheticCode: check.syntheticCode } : {}),
  }
}
