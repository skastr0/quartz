import { NodeBuilderFlags, TypeFlags, type Project, type Type } from "typescript/unstable/sync"
import type {
  AssignabilityCheckResult,
  FromMatchDetails,
  ToMatchDetails,
} from "../../transform-search/assignability-filter"
import type { CallableId } from "../../transform-search/types"
import type { NativeResolvedCallSignature, NativeResolvedSignature } from "./types"

export interface NativeAssignabilityOptions {
  readonly fromType: Type | null
  readonly toType: Type | null
  readonly paramPosition: number | "any"
  readonly unwrapReturn: boolean
  readonly allowTypeErasure?: boolean
}

const TYPE_FLAGS = NodeBuilderFlags.NoTruncation | NodeBuilderFlags.UseStructuralFallback | NodeBuilderFlags.WriteTypeArgumentsOfSignature

const typeText = (type: Type, project: Project): string => project.checker.typeToString(type, undefined, TYPE_FLAGS)

const involvesTypeErasure = (type: Type, project: Project): boolean => {
  if ((type.flags & TypeFlags.AnyOrUnknown) !== TypeFlags.None) return true
  if (typeText(type, project) === "any" || typeText(type, project) === "unknown") return true
  return project.checker.getIndexInfosOfType(type).some((info) => (info.valueType.flags & TypeFlags.AnyOrUnknown) !== TypeFlags.None)
}

const identical = (left: Type, right: Type, project: Project): boolean =>
  left.id === right.id || typeText(left, project) === typeText(right, project)

const fromMatch = (
  query: Type,
  signature: NativeResolvedCallSignature,
  position: number | "any",
  project: Project,
): FromMatchDetails => {
  const candidates = position === "any"
    ? signature.params.map((param, index) => ({ param, index }))
    : signature.params[position] === undefined ? [] : [{ param: signature.params[position]!, index: position }]
  for (const { param, index } of candidates) {
    // Native checker handles cross-file and array assignability directly. Do not port morph's text/array fallbacks.
    if (!project.checker.isTypeAssignableTo(query, param.type)) continue
    return {
      matched: true,
      paramIndex: index,
      paramName: param.name,
      queryType: typeText(query, project),
      paramType: param.typeText,
      exact: identical(query, param.type, project),
      typeErasure: involvesTypeErasure(param.type, project),
    }
  }
  return { matched: false, paramIndex: -1, paramName: "", queryType: typeText(query, project), paramType: "", exact: false }
}

const toMatch = (
  query: Type,
  signature: NativeResolvedCallSignature,
  unwrapReturn: boolean,
  project: Project,
): ToMatchDetails => {
  const directType = signature.predicateType ?? signature.returnType
  const directText = signature.predicateType === null ? signature.returnTypeText : typeText(signature.predicateType, project)
  if (project.checker.isTypeAssignableTo(directType, query)) {
    return {
      matched: true,
      returnType: directText,
      queryType: typeText(query, project),
      exact: identical(directType, query, project),
      unwrapped: false,
      wrapper: null,
      typeErasure: involvesTypeErasure(directType, project),
    }
  }
  if (unwrapReturn && signature.unwrappedReturnType !== null && signature.returnWrapper !== null && project.checker.isTypeAssignableTo(signature.unwrappedReturnType, query)) {
    return {
      matched: true,
      returnType: signature.unwrappedReturnTypeText ?? signature.returnTypeText,
      queryType: typeText(query, project),
      exact: identical(signature.unwrappedReturnType, query, project),
      unwrapped: true,
      wrapper: signature.returnWrapper,
      typeErasure: involvesTypeErasure(signature.unwrappedReturnType, project),
    }
  }
  return {
    matched: false,
    returnType: signature.returnTypeText,
    queryType: typeText(query, project),
    exact: false,
    unwrapped: false,
    wrapper: null,
  }
}

const noMatch = (candidateId: CallableId): AssignabilityCheckResult => ({
  candidateId,
  matches: false,
  matchedSignatureIndex: null,
  fromMatch: null,
  toMatch: null,
  score: 0,
})

export const filterNativeAssignability = (
  candidates: Map<CallableId, NativeResolvedSignature>,
  options: NativeAssignabilityOptions,
  project: Project,
): AssignabilityCheckResult[] => {
  const results: AssignabilityCheckResult[] = []
  for (const [candidateId, resolved] of candidates) {
    let result = noMatch(candidateId)
    for (let signatureIndex = 0; signatureIndex < resolved.signatures.length; signatureIndex++) {
      const signature = resolved.signatures[signatureIndex]!
      const from = options.fromType === null ? null : fromMatch(options.fromType, signature, options.paramPosition, project)
      if (from !== null && !from.matched) continue
      const to = options.toType === null ? null : toMatch(options.toType, signature, options.unwrapReturn, project)
      if (to !== null && !to.matched) continue
      const erased = Boolean(from?.typeErasure || to?.typeErasure)
      result = {
        candidateId,
        matches: true,
        matchedSignatureIndex: signatureIndex,
        fromMatch: from,
        toMatch: to,
        score: (from?.exact ? 100 : from === null ? 0 : 50) + (to?.exact ? 100 : to === null ? 0 : 50),
        typeErasure: erased,
      }
      break
    }
    if (result.matches && (options.allowTypeErasure === true || result.typeErasure !== true)) results.push(result)
  }
  return results.sort((left, right) => right.score - left.score)
}
