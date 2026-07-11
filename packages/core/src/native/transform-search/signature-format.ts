import type { AssignabilityCheckResult } from "../../transform-search"
import type { NativeCallableEntry, NativeSignatureMap } from "./types"

export const formatNativeSignature = (
  entry: NativeCallableEntry,
  result: AssignabilityCheckResult,
  resolved: NativeSignatureMap,
): string => {
  const signature = resolved.get(entry.id)?.signatures[result.matchedSignatureIndex ?? 0]
  if (signature === undefined) return entry.kind === "Constructor" ? `new ${entry.qualifiedName}()` : "() => unknown"
  const params = signature.params.map((param) => `${param.rest ? "..." : ""}${param.name}${param.optional ? "?" : ""}: ${param.typeText}`).join(", ")
  return entry.kind === "Constructor"
    ? `new ${entry.qualifiedName}(${params})`
    : `(${params}) => ${signature.returnTypeText}`
}
