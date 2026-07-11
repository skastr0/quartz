import { isAbsolute, relative, resolve } from "node:path"
import type { PackageInfo } from "../discovery"
import { QuartzError } from "../errors"
import { SymbolFlags, type Project, type Program, type Symbol, type Type } from "typescript/unstable/sync"
import { SyntaxKind, type Node, type SourceFile } from "typescript/unstable/ast"
import {
  isClassDeclaration,
  isEnumDeclaration,
  isFunctionDeclaration,
  isIdentifier,
  isInterfaceDeclaration,
  isTypeAliasDeclaration,
  isVariableDeclaration,
} from "typescript/unstable/ast/is"
import { formatSyntaxKind } from "typescript/unstable/ast/utils"

export interface NativeSymbolMatch {
  readonly node: Node
  readonly symbol: Symbol
}

const workspaceSourceFilesCache = new WeakMap<Program, readonly SourceFile[]>()
const exportedSymbolsCache = new WeakMap<Project, WeakMap<SourceFile, ReadonlyMap<string, readonly NativeSymbolMatch[]>>>()

export const resolvePackage = (packages: readonly PackageInfo[], packageName?: string): PackageInfo => {
  if (packageName === undefined || packageName.length === 0) {
    const rootPackage = packages.find((pkg) => pkg.name === "(root)")
    if (rootPackage !== undefined) return rootPackage
    if (packages.length === 1) return packages[0]!
    throw new QuartzError({ message: `Multiple packages found. Please specify a package: ${packages.map((pkg) => pkg.name).join(", ")}` })
  }

  const normalized = packageName.replace(/^\//, "")
  const packageInfo = packages.find(
    (pkg) => pkg.name === packageName || pkg.name === normalized || pkg.path.endsWith(packageName),
  )
  if (packageInfo === undefined) {
    throw new QuartzError({ message: `Package "${packageName}" not found. Available: ${packages.map((pkg) => pkg.name).join(", ")}` })
  }
  return packageInfo
}

export const getWorkspaceSourceFiles = (program: Program, packageInfo: PackageInfo): readonly SourceFile[] => {
  const cached = workspaceSourceFilesCache.get(program)
  if (cached !== undefined) return cached.filter((sourceFile) => resolve(sourceFile.fileName).startsWith(resolve(packageInfo.path)))

  const sourceFiles = program
    .getSourceFileNames()
    .filter((fileName) => {
      const sourceFile = program.getSourceFile(fileName)
      return sourceFile !== undefined && !program.isSourceFileFromExternalLibrary(sourceFile)
    })
    .map((fileName) => program.getSourceFile(fileName))
    .filter((sourceFile): sourceFile is SourceFile => sourceFile !== undefined)
  workspaceSourceFilesCache.set(program, sourceFiles)
  return sourceFiles.filter((sourceFile) => resolve(sourceFile.fileName).startsWith(resolve(packageInfo.path)))
}

export const resolveSourceFile = (
  filePath: string,
  rootDirectory: string,
  sourceFiles: readonly SourceFile[],
): SourceFile | null => {
  const targetPath = isAbsolute(filePath) ? resolve(filePath) : resolve(rootDirectory, filePath)
  return (
    sourceFiles.find((sourceFile) => resolve(sourceFile.fileName) === targetPath) ??
    sourceFiles.find((sourceFile) => sourceFile.fileName.endsWith(filePath) || sourceFile.fileName.includes(filePath)) ??
    null
  )
}

export const relativePath = (rootDirectory: string, filePath: string): string => {
  const root = resolve(rootDirectory)
  const absolute = resolve(filePath)
  return absolute.startsWith(`${root}/`) ? relative(root, absolute) : absolute
}

const declarationName = (node: Node | undefined): string | undefined => {
  if (node === undefined) return undefined
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

export const kindToString = (kind: SyntaxKind): string => {
  switch (kind) {
    case SyntaxKind.InterfaceDeclaration:
      return "interface"
    case SyntaxKind.TypeAliasDeclaration:
      return "type"
    case SyntaxKind.ClassDeclaration:
      return "class"
    case SyntaxKind.FunctionDeclaration:
      return "function"
    case SyntaxKind.VariableDeclaration:
      return "variable"
    case SyntaxKind.EnumDeclaration:
      return "enum"
    case SyntaxKind.ModuleDeclaration:
      return "module"
    default:
      return formatSyntaxKind(kind)
  }
}

export const findNativeSymbol = (
  symbolName: string,
  project: Project,
  _packageInfo: PackageInfo,
  rootDirectory: string,
  sourceFiles: readonly SourceFile[],
): NativeSymbolMatch | null => {
  const fileReference = parseFileReference(symbolName)
  if (fileReference !== null) {
    if (fileReference.symbol === "*") return null
    const sourceFile = resolveSourceFile(fileReference.filePath, rootDirectory, sourceFiles)
    return sourceFile === null ? null : findSymbolInSourceFile(fileReference.symbol, sourceFile, project)
  }

  const parts = symbolName.split(".")
  const rootName = parts[0]!
  const matches = sourceFiles.flatMap((sourceFile) => exportedSymbolsForSourceFile(project, sourceFile).get(rootName) ?? [])

  if (matches.length === 0) return null
  if (matches.length > 1) throw new QuartzError({ message: `Symbol "${rootName}" is ambiguous. Use a file-qualified symbol reference.` })
  return navigateSymbolMembers(matches[0]!, parts.slice(1), project)
}

const exportedSymbolsForSourceFile = (
  project: Project,
  sourceFile: SourceFile,
): ReadonlyMap<string, readonly NativeSymbolMatch[]> => {
  let perProject = exportedSymbolsCache.get(project)
  if (perProject === undefined) {
    perProject = new WeakMap<SourceFile, ReadonlyMap<string, readonly NativeSymbolMatch[]>>()
    exportedSymbolsCache.set(project, perProject)
  }
  const cached = perProject.get(sourceFile)
  if (cached !== undefined) return cached

  const matches = new Map<string, NativeSymbolMatch[]>()
  const moduleSymbol = project.checker.getSymbolAtLocation(sourceFile)
  if (moduleSymbol !== undefined) {
    for (const exportedSymbol of project.checker.getExportsOfModule(moduleSymbol)) {
      const declaration = getDeclaration(project, exportedSymbol)
      const actualName = exportedSymbol.name === "default"
        ? declarationName(declaration?.node ?? exportedSymbol.declarations[0]?.resolve(project))
        : exportedSymbol.name
      if (actualName === undefined || declaration === undefined) continue
      const existing = matches.get(actualName)
      if (existing === undefined) matches.set(actualName, [declaration])
      else existing.push(declaration)
    }
  }
  perProject.set(sourceFile, matches)
  return matches
}

const findSymbolInSourceFile = (symbolName: string, sourceFile: SourceFile, project: Project): NativeSymbolMatch | null => {
  const parts = symbolName.split(".")
  const declaration = findDeclaration(sourceFile, parts[0]!)
  if (declaration === undefined) return null
  const symbol = getSymbolForDeclaration(project, declaration)
  return symbol === undefined ? null : navigateSymbolMembers({ node: declaration, symbol }, parts.slice(1), project)
}

const findDeclaration = (sourceFile: SourceFile, name: string): Node | undefined => {
  let match: Node | undefined
  const visit = (node: Node): void => {
    if (match !== undefined) return
    if (declarationName(node) === name) {
      match = node
      return
    }
    node.forEachChild(visit)
  }
  sourceFile.forEachChild(visit)
  return match
}

const getSymbolForDeclaration = (project: Project, node: Node): Symbol | undefined => {
  if (
    isClassDeclaration(node) ||
    isEnumDeclaration(node) ||
    isFunctionDeclaration(node) ||
    isInterfaceDeclaration(node) ||
    isTypeAliasDeclaration(node)
  ) {
    return node.name === undefined ? undefined : project.checker.getSymbolAtLocation(node.name)
  }
  if (isVariableDeclaration(node) && isIdentifier(node.name)) return project.checker.getSymbolAtLocation(node.name)
  return undefined
}

const getDeclaration = (project: Project, symbol: Symbol): NativeSymbolMatch | undefined => {
  const resolvedSymbol = (symbol.flags & SymbolFlags.Alias) !== SymbolFlags.None
    ? project.checker.getAliasedSymbol(symbol)
    : symbol
  for (const handle of resolvedSymbol.declarations) {
    const node = handle.resolve(project)
    if (node === undefined) continue
    const declarationSymbol = getSymbolForDeclaration(project, node)
    if (declarationSymbol !== undefined) return { node, symbol: declarationSymbol }
    if (node.kind === SyntaxKind.ExportSpecifier) {
      const target = project.checker.getAliasedSymbol(symbol)
      for (const targetHandle of target.declarations) {
        const targetNode = targetHandle.resolve(project)
        if (targetNode === undefined) continue
        const targetSymbol = getSymbolForDeclaration(project, targetNode)
        if (targetSymbol !== undefined) return { node: targetNode, symbol: targetSymbol }
      }
    }
  }
  return undefined
}

const navigateSymbolMembers = (
  start: NativeSymbolMatch,
  parts: readonly string[],
  project: Project,
): NativeSymbolMatch | null => {
  let current = start
  for (const memberName of parts) {
    const type = getSymbolType(project, current)
    const property = project.checker.getPropertyOfType(type, memberName)
    if (property !== undefined) {
      const declaration = property.declarations[0]?.resolve(project)
      if (declaration === undefined) return null
      current = { node: declaration, symbol: property }
      continue
    }

    const local = findDeclaration(current.node.getSourceFile(), memberName)
    if (local === undefined) return null
    const localSymbol = getSymbolForDeclaration(project, local)
    if (localSymbol === undefined) return null
    current = { node: local, symbol: localSymbol }
  }
  return current
}

const getSymbolType = (project: Project, match: NativeSymbolMatch): Type => {
  switch (match.node.kind) {
    case SyntaxKind.ClassDeclaration:
    case SyntaxKind.InterfaceDeclaration:
    case SyntaxKind.TypeAliasDeclaration:
    case SyntaxKind.EnumDeclaration:
      return project.checker.getDeclaredTypeOfSymbol(match.symbol)
    default:
      return project.checker.getTypeOfSymbol(match.symbol)
  }
}

const parseFileReference = (symbolName: string): { filePath: string; symbol: string } | null => {
  if (!symbolName.startsWith("@file:")) return null
  const rest = symbolName.slice(6)
  const lastColonIndex = rest.lastIndexOf(":")
  if (lastColonIndex === -1 || lastColonIndex === rest.length - 1) return { filePath: rest.replace(/:$/, ""), symbol: "*" }
  if (lastColonIndex === 1 && /^[a-zA-Z]$/.test(rest[0]!)) return { filePath: rest, symbol: "*" }
  return { filePath: rest.slice(0, lastColonIndex), symbol: rest.slice(lastColonIndex + 1) }
}
