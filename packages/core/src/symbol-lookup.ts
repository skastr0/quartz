import { isAbsolute, join } from "node:path"
import {
  type FunctionDeclaration,
  type MethodDeclaration,
  type ParameterDeclaration,
  Node,
  type Project,
  type SourceFile,
  type Symbol,
  SyntaxKind,
} from "ts-morph"
import { getDeclarationName } from "./declarations"
import type { PackageInfo } from "./discovery"
import {
  getWorkspaceSourceFiles,
  type ProjectWorkspaceState,
  workspaceRelativePath,
} from "./project-workspace"

interface SymbolMatch {
  readonly node: Node
  readonly symbol: Symbol
  readonly file: string
  readonly line: number
  readonly isDefault: boolean
}

export class SymbolLookup {
  constructor(private readonly workspace: ProjectWorkspaceState) {}

  findSymbol(symbolName: string, project: Project, pkg: PackageInfo): { node: Node; symbol: Symbol } | null {
    const fileRef = parseFileReference(symbolName)
    if (fileRef !== null) {
      if (fileRef.symbol === "*") return null
      return this.findSymbolInFile(fileRef.filePath, fileRef.symbol, project, pkg)
    }

    const parts = symbolName.split(".")
    const rootName = parts[0]!
    const matches = this.findExportedSymbolMatches(rootName, project, pkg)
    const match = this.resolveSingleSymbolMatch(rootName, matches)
    return match === null ? null : this.navigateExportedSymbolMembers(match.node, match.symbol, parts)
  }

  findSymbolInFile(
    filePath: string,
    symbolName: string,
    project: Project,
    pkg: PackageInfo,
  ): { node: Node; symbol: Symbol } | null {
    const sourceFile = this.resolveSourceFileForLookup(filePath, project, pkg)
    if (sourceFile === null) return null
    const parts = symbolName.split(".")
    const rootName = parts[0]!
    const root = this.findRootSymbolInSourceFile(sourceFile, rootName)
    return root === null ? null : this.navigateSymbolMembers(root.node, root.symbol, parts)
  }

  private resolveSourceFileForLookup(filePath: string, project: Project, pkg: PackageInfo): SourceFile | null {
    const targetPath = isAbsolute(filePath) ? filePath : join(this.workspace.rootDirectory, filePath)
    const sourceFile = project.getSourceFile(targetPath)
    if (sourceFile !== undefined) return sourceFile

    return getWorkspaceSourceFiles(project, pkg).find((candidate) => {
      const candidatePath = candidate.getFilePath()
      return candidatePath.endsWith(filePath) || candidatePath.includes(filePath)
    }) ?? null
  }

  private findRootSymbolInSourceFile(sourceFile: SourceFile, rootName: string): { node: Node; symbol: Symbol } | null {
    return (
      findNamedNodeSymbol(sourceFile.getClasses(), rootName) ??
      findNamedNodeSymbol(sourceFile.getInterfaces(), rootName) ??
      findNamedNodeSymbol(sourceFile.getTypeAliases(), rootName) ??
      findNamedNodeSymbol(sourceFile.getFunctions(), rootName) ??
      findNamedNodeSymbol(sourceFile.getEnums(), rootName) ??
      findVariableDeclarationSymbol(sourceFile, rootName) ??
      findExportedRootSymbol(sourceFile, rootName)
    )
  }

  private navigateSymbolMembers(
    startNode: Node,
    startSymbol: Symbol,
    parts: readonly string[],
  ): { node: Node; symbol: Symbol } | null {
    let node = startNode
    let symbol: Symbol | undefined = startSymbol

    for (let index = 1; index < parts.length && symbol !== undefined; index++) {
      const memberName = parts[index]!
      const property = node.getType().getProperty(memberName)
      const propDecl = property?.getDeclarations()[0]
      if (property === undefined || propDecl === undefined) return null
      node = propDecl
      symbol = property
    }

    return symbol === undefined ? null : { node, symbol }
  }

  private findExportedSymbolMatches(rootName: string, project: Project, pkg: PackageInfo): SymbolMatch[] {
    const matches: SymbolMatch[] = []

    for (const sourceFile of getWorkspaceSourceFiles(project, pkg)) {
      const exports = sourceFile.getExportedDeclarations()
      addNamedExportMatch(matches, sourceFile, exports.get(rootName), this.workspace)
      addDefaultExportMatches(matches, sourceFile, rootName, exports.get("default"), this.workspace)
    }

    return matches
  }

  private resolveSingleSymbolMatch(rootName: string, matches: readonly SymbolMatch[]): SymbolMatch | null {
    if (matches.length === 0) return null
    if (matches.length > 1) throw new Error(formatAmbiguousSymbolError(rootName, matches))
    return matches[0]!
  }

  private navigateExportedSymbolMembers(
    startNode: Node,
    startSymbol: Symbol,
    parts: readonly string[],
  ): { node: Node; symbol: Symbol } | null {
    let node: Node = startNode
    let symbol: Symbol | undefined = startSymbol

    for (let index = 1; index < parts.length && symbol !== undefined; index++) {
      const memberName = parts[index]!
      const property = node.getType().getProperty(memberName)

      if (property !== undefined) {
        const propDecl = property.getDeclarations()[0]
        if (propDecl === undefined) return null
        node = propDecl
        symbol = property
        continue
      }

      const localVar = findLocalVariable(node, memberName)
      if (localVar === null) return null
      node = localVar.node
      symbol = localVar.symbol
    }

    return symbol === undefined ? null : { node, symbol }
  }
}

const parseFileReference = (symbolName: string): { filePath: string; symbol: string } | null => {
  if (!symbolName.startsWith("@file:")) return null

  const rest = symbolName.slice(6)
  const lastColonIndex = rest.lastIndexOf(":")

  if (lastColonIndex === -1 || lastColonIndex === rest.length - 1) {
    return { filePath: rest.replace(/:$/, ""), symbol: "*" }
  }

  if (lastColonIndex === 1 && /^[a-zA-Z]$/.test(rest[0]!)) {
    return { filePath: rest, symbol: "*" }
  }

  return {
    filePath: rest.slice(0, lastColonIndex),
    symbol: rest.slice(lastColonIndex + 1),
  }
}

const findNamedNodeSymbol = (nodes: readonly Node[], rootName: string): { node: Node; symbol: Symbol } | null => {
  for (const node of nodes) {
    if (getDeclarationName(node) !== rootName) continue
    const symbol = node.getSymbol()
    if (symbol !== undefined) return { node, symbol }
  }
  return null
}

const findVariableDeclarationSymbol = (sourceFile: SourceFile, rootName: string): { node: Node; symbol: Symbol } | null => {
  for (const statement of sourceFile.getVariableStatements()) {
    for (const declaration of statement.getDeclarations()) {
      if (declaration.getName() !== rootName) continue
      const symbol = declaration.getSymbol()
      if (symbol !== undefined) return { node: declaration, symbol }
    }
  }
  return null
}

const findExportedRootSymbol = (sourceFile: SourceFile, rootName: string): { node: Node; symbol: Symbol } | null => {
  for (const [exportName, declarations] of sourceFile.getExportedDeclarations()) {
    if (exportName !== rootName && exportName !== "default") continue
    for (const declaration of declarations) {
      const actualName = exportName === "default" ? getDeclarationName(declaration) : exportName
      if (actualName !== rootName) continue
      const symbol = declaration.getSymbol()
      if (symbol !== undefined) return { node: declaration, symbol }
    }
  }

  return null
}

const addNamedExportMatch = (
  matches: SymbolMatch[],
  sourceFile: SourceFile,
  declarations: Node[] | undefined,
  workspace: ProjectWorkspaceState,
): void => {
  const node = declarations?.[0]
  const symbol = node?.getSymbol()
  if (node !== undefined && symbol !== undefined) {
    matches.push(toSymbolMatch(node, symbol, sourceFile, false, workspace))
  }
}

const addDefaultExportMatches = (
  matches: SymbolMatch[],
  sourceFile: SourceFile,
  rootName: string,
  declarations: Node[] | undefined,
  workspace: ProjectWorkspaceState,
): void => {
  for (const declaration of declarations ?? []) {
    if (getDeclarationName(declaration) !== rootName) continue
    const symbol = declaration.getSymbol()
    if (symbol !== undefined) matches.push(toSymbolMatch(declaration, symbol, sourceFile, true, workspace))
  }
}

const toSymbolMatch = (
  node: Node,
  symbol: Symbol,
  sourceFile: SourceFile,
  isDefault: boolean,
  workspace: ProjectWorkspaceState,
): SymbolMatch => ({
  node,
  symbol,
  file: workspaceRelativePath(workspace, sourceFile.getFilePath()),
  line: node.getStartLineNumber(),
  isDefault,
})

const formatAmbiguousSymbolError = (rootName: string, matches: readonly SymbolMatch[]): string => {
  const locations = matches
    .map((match) => `  - ${match.file}:${match.line}${match.isDefault ? " (default export)" : ""}`)
    .join("\n")
  return `Ambiguous symbol "${rootName}". Found in multiple files:\n${locations}\nUse @file:path/to/file.ts:${rootName} to specify.`
}

const findLocalVariable = (parentNode: Node, varName: string): { node: Node; symbol: Symbol } | null => {
  const body = getFunctionBody(parentNode)
  if (body === null) return null

  for (const declaration of body.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
    if (declaration.getName() !== varName) continue
    const symbol = declaration.getSymbol()
    if (symbol !== undefined) return { node: declaration, symbol }
  }

  for (const parameter of getFunctionParameters(parentNode)) {
    if (parameter.getName() !== varName) continue
    const symbol = parameter.getSymbol()
    if (symbol !== undefined) return { node: parameter, symbol }
  }

  return null
}

const getFunctionBody = (node: Node): Node | null => {
  if (Node.isMethodDeclaration(node)) return (node as MethodDeclaration).getBody() ?? null
  if (Node.isFunctionDeclaration(node)) return (node as FunctionDeclaration).getBody() ?? null
  if (Node.isArrowFunction(node)) return node.getChildAtIndex(node.getChildCount() - 1)
  return null
}

const getFunctionParameters = (node: Node): ParameterDeclaration[] => {
  if (Node.isMethodDeclaration(node)) return (node as MethodDeclaration).getParameters()
  if (Node.isFunctionDeclaration(node)) return (node as FunctionDeclaration).getParameters()
  return []
}
