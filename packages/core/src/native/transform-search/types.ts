import type { Node, SourceFile } from "typescript/unstable/ast"
import type { Signature, Type } from "typescript/unstable/sync"
import type {
  CallableEntry,
  CallableId,
  CallableIndex,
  VerificationMeta,
} from "../../transform-search/types"

export type NativeCallableEntry = CallableEntry & {
  readonly node: Node
  readonly sourceFile: SourceFile
}

export type NativeCallableIndex = Omit<CallableIndex, "entries"> & {
  readonly entries: NativeCallableEntry[]
}

export type WrapperKind = "Promise" | "PromiseLike" | "Effect" | "Observable" | "Task" | null

export interface NativeResolvedParam {
  readonly name: string
  readonly type: Type
  readonly typeText: string
  readonly optional: boolean
  readonly rest: boolean
}

export interface NativeResolvedCallSignature {
  readonly nativeSignature: Signature
  readonly params: NativeResolvedParam[]
  readonly returnType: Type
  readonly returnTypeText: string
  readonly returnWrapper: WrapperKind
  readonly unwrappedReturnType: Type | null
  readonly unwrappedReturnTypeText: string | null
  readonly predicateType: Type | null
}

export interface NativeResolvedSignature {
  readonly signatures: NativeResolvedCallSignature[]
}

export type NativeSignatureMap = Map<CallableId, NativeResolvedSignature>

export interface NativeQueryType {
  readonly kind: "symbol" | "expression"
  readonly raw: string
  readonly resolvedType: Type | null
  readonly error: string | null
  readonly tokens: string[]
  readonly propKeys: string[]
}

export interface NativeParsedQuery {
  readonly from: NativeQueryType | null
  readonly to: NativeQueryType | null
  readonly paramPosition: number | "any"
  readonly unwrapReturn: boolean
  readonly exportedOnly: boolean
  readonly limit: number
  readonly isValid: boolean
  readonly validationErrors: string[]
}

export interface NativeSyntheticCheckResult {
  readonly candidateId: CallableId
  readonly verified: boolean
  readonly verification: VerificationMeta
  readonly diagnostics: Array<{ message: string; code: number }>
  readonly syntheticCode: string
}
