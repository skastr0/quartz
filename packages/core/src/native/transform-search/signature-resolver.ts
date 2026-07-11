import { SyntaxKind, type Node } from "typescript/unstable/ast"
import {
  NodeBuilderFlags,
  SignatureKind,
  SymbolFlags,
  type Project,
  type Signature,
  type Type,
} from "typescript/unstable/sync"
import type { CallableId } from "../../transform-search/types"
import type {
  NativeCallableEntry,
  NativeCallableIndex,
  NativeResolvedCallSignature,
  NativeResolvedSignature,
  WrapperKind,
} from "./types"

const TYPE_FLAGS = NodeBuilderFlags.NoTruncation | NodeBuilderFlags.UseStructuralFallback | NodeBuilderFlags.WriteTypeArgumentsOfSignature

const signatureContext = (entry: NativeCallableEntry): Node =>
  entry.kind === "Constructor" && entry.node.parent !== undefined ? entry.node.parent : entry.node

const signaturesFor = (entry: NativeCallableEntry, project: Project): readonly Signature[] => {
  const context = signatureContext(entry)
  const type = project.checker.getTypeAtLocation(context)
  return project.checker.getSignaturesOfType(type, entry.kind === "Constructor" ? SignatureKind.Construct : SignatureKind.Call)
}

const unwrap = (type: Type, project: Project): { wrapper: WrapperKind; type: Type | null } => {
  const checker = project.checker
  const symbol = type.getAliasSymbol() ?? type.getSymbol()
  const name = symbol?.name
  let args = type.getAliasTypeArguments()
  if (args.length === 0 && type.isTypeReference()) args = checker.getTypeArguments(type)
  if ((name === "Promise" || name === "PromiseLike" || name === "Observable" || name === "Task") && args[0] !== undefined) {
    return { wrapper: name, type: args[0] }
  }
  if ((name === "Effect" || checker.getPropertiesOfType(type).some((property) => property.name.includes("EffectTypeId"))) && args[0] !== undefined) {
    return { wrapper: "Effect", type: args[0] }
  }
  return { wrapper: null, type: null }
}

const resolveSignature = (signature: Signature, entry: NativeCallableEntry, project: Project): NativeResolvedCallSignature => {
  const checker = project.checker
  const context = signatureContext(entry)
  const parameters = signature.getParameters()
  const params = parameters.map((parameter, index) => {
    const declaration = parameter.declarations[0]?.resolve(project)
    const parameterType = declaration === undefined
      ? checker.getParameterType(signature, index)
      : checker.getTypeOfSymbolAtLocation(parameter, declaration)
    return {
      name: parameter.name,
      type: parameterType,
      typeText: checker.typeToString(parameterType, declaration ?? context, TYPE_FLAGS),
      optional: (parameter.flags & SymbolFlags.Optional) !== SymbolFlags.None,
      rest: signature.hasRestParameter && index === parameters.length - 1,
    }
  })
  const returnType = checker.getReturnTypeOfSignature(signature)
  const unwrapped = unwrap(returnType, project)
  return {
    nativeSignature: signature,
    params,
    returnType,
    returnTypeText: checker.typeToString(returnType, context, TYPE_FLAGS),
    returnWrapper: unwrapped.wrapper,
    unwrappedReturnType: unwrapped.type,
    unwrappedReturnTypeText: unwrapped.type === null ? null : checker.typeToString(unwrapped.type, context, TYPE_FLAGS),
    predicateType: checker.getTypePredicateOfSignature(signature)?.type ?? null,
  }
}

export const resolveNativeSignatures = (
  candidateIds: readonly CallableId[],
  index: NativeCallableIndex,
  project: Project,
): Map<CallableId, NativeResolvedSignature> => {
  const resolved = new Map<CallableId, NativeResolvedSignature>()
  for (const id of candidateIds) {
    const entry = index.entries[id]
    if (entry === undefined) continue
    const signatures = signaturesFor(entry, project).map((signature) => resolveSignature(signature, entry, project))
    if (signatures.length > 0) resolved.set(id, { signatures })
  }
  return resolved
}
