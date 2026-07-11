import type { AssignabilityCheckResult } from "../../transform-search/assignability-filter"
import type { VerificationMeta, VerificationReason, VerificationStatus } from "../../transform-search/types"
import type { NativeCallableEntry } from "./types"

export interface NativeSyntheticPolicy {
  readonly skip: boolean
  readonly status: VerificationStatus
  readonly reason: VerificationReason
  readonly method: VerificationMeta["method"]
}

export const shouldSkipNativeSyntheticCheck = (
  entry: NativeCallableEntry,
  result: AssignabilityCheckResult,
): NativeSyntheticPolicy => {
  if (result.fromMatch?.exact && result.toMatch?.exact) return { skip: true, status: "verified", reason: "exact_type_match", method: "exact_match" }
  if (!entry.hasTypeAnnotations) return { skip: true, status: "unverified", reason: "no_type_annotations", method: null }
  if (entry.exportState !== "exported" || entry.kind === "InterfaceMethod" || entry.kind === "TypeLiteralMethod" || entry.kind === "CallableProperty") {
    return { skip: true, status: "unverifiable", reason: "not_importable", method: null }
  }
  return { skip: false, status: "unverified", reason: "synthetic_check_passed", method: "synthetic" }
}
