import { SyntaxKind, type Node, type TypeNode } from "typescript/unstable/ast"
import { isTypeLiteralNode, isTypeNode } from "typescript/unstable/ast/is"
import type { TokenExtractionResult } from "../../transform-search/types"

const primitiveTokens = new Map<SyntaxKind, string>([
  [SyntaxKind.StringKeyword, "string"],
  [SyntaxKind.NumberKeyword, "number"],
  [SyntaxKind.BooleanKeyword, "boolean"],
  [SyntaxKind.VoidKeyword, "void"],
  [SyntaxKind.NeverKeyword, "never"],
  [SyntaxKind.UnknownKeyword, "unknown"],
  [SyntaxKind.AnyKeyword, "any"],
  [SyntaxKind.UndefinedKeyword, "undefined"],
  [SyntaxKind.NullKeyword, "null"],
  [SyntaxKind.ObjectKeyword, "object"],
  [SyntaxKind.SymbolKeyword, "symbol"],
  [SyntaxKind.BigIntKeyword, "bigint"],
  [SyntaxKind.ThisType, "this"],
])

const add = (values: string[], value: string): void => {
  if (value.length > 0 && !values.includes(value)) values.push(value)
}

export const extractTokensFromTypeNode = (node: TypeNode | undefined): TokenExtractionResult => {
  if (node === undefined) return { tokens: [], propKeys: [] }
  const tokens: string[] = []
  const propKeys: string[] = []

  const visit = (current: Node): void => {
    const primitive = primitiveTokens.get(current.kind)
    if (primitive !== undefined) add(tokens, primitive)

    if (current.kind === SyntaxKind.TypeReference) {
      const first = current.getText(current.getSourceFile()).match(/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*/)?.[0]
      if (first !== undefined) {
        add(tokens, first)
        for (const part of first.split(".")) add(tokens, part)
      }
    } else if (current.kind === SyntaxKind.Identifier && isTypeNode(current.parent)) {
      add(tokens, current.getText(current.getSourceFile()))
    }

    if (isTypeLiteralNode(current)) {
      for (const member of current.members) {
        const named = member as Node & { readonly name?: Node }
        if (named.name !== undefined) add(propKeys, named.name.getText(named.name.getSourceFile()).replace(/^['"]|['"]$/g, ""))
      }
    }
    current.forEachChild(visit)
  }

  visit(node)
  return { tokens, propKeys }
}

export const extractTokensFromExpressionText = (expression: string): TokenExtractionResult => {
  const tokens: string[] = []
  const propKeys: string[] = []
  for (const match of expression.matchAll(/\b[A-Za-z_$][\w$]*\b/g)) add(tokens, match[0])
  if (expression.trimStart().startsWith("{")) {
    for (const match of expression.matchAll(/(?:^|[;,{])\s*([A-Za-z_$][\w$]*)\??\s*:/g)) add(propKeys, match[1]!)
  }
  return { tokens, propKeys }
}
