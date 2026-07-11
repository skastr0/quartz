import { SymbolFlags, type Project, type Symbol } from "typescript/unstable/sync"
import type { Node, SourceFile } from "typescript/unstable/ast"
import {
  isClassDeclaration,
  isEnumDeclaration,
  isFunctionDeclaration,
  isIdentifier,
  isInterfaceDeclaration,
  isTypeAliasDeclaration,
  isVariableDeclaration,
} from "typescript/unstable/ast/is"

export interface NativeExportDeclaration {
  readonly exportName: string
  readonly symbol: Symbol
  readonly node: Node
  readonly declarationName: string | undefined
}

export const getNativeExportDeclarations = (
  sourceFile: SourceFile,
  project: Project,
): readonly NativeExportDeclaration[] => {
  const moduleSymbol = project.checker.getSymbolAtLocation(sourceFile)
  if (moduleSymbol === undefined) return []

  return project.checker.getExportsOfModule(moduleSymbol).flatMap((exportedSymbol) => {
    const symbol = resolveAlias(exportedSymbol, project)
    return symbol.declarations.flatMap((handle) => {
      const node = handle.resolve(project)
      return node === undefined
        ? []
        : [{ exportName: exportedSymbol.name, symbol, node, declarationName: getNativeDeclarationName(node) }]
    })
  })
}

const resolveAlias = (symbol: Symbol, project: Project): Symbol => {
  let current = symbol
  const seen = new Set<number>()
  while ((current.flags & SymbolFlags.Alias) !== SymbolFlags.None && !seen.has(current.id)) {
    seen.add(current.id)
    const next = project.checker.getAliasedSymbol(current)
    if (next.id === current.id) break
    current = next
  }
  return current
}

export const getNativeDeclarationName = (node: Node): string | undefined => {
  if (
    isClassDeclaration(node) ||
    isEnumDeclaration(node) ||
    isFunctionDeclaration(node) ||
    isInterfaceDeclaration(node) ||
    isTypeAliasDeclaration(node)
  ) {
    return node.name?.text
  }
  if (isVariableDeclaration(node) && isIdentifier(node.name)) return node.name.text
  return undefined
}
