import { relative, resolve } from "node:path"
import { discoverPackagesSync, type PackageInfo } from "../discovery"
import type { RelatedInfo, RefactorError, RefactorLocation, RefactorPreviewResult, StringLiteralRef } from "../project-types"
import type { NativeCommandContext } from "./context"
import {
  type Node,
  type SourceFile,
  SyntaxKind,
} from "typescript/unstable/ast"
import {
  type Symbol,
  type Project,
} from "typescript/unstable/sync"
import {
  isClassDeclaration,
  isEnumDeclaration,
  isFunctionDeclaration,
  isIdentifier,
  isInterfaceDeclaration,
  isMethodDeclaration,
  isPropertyDeclaration,
  isPropertySignatureDeclaration,
  isTypeAliasDeclaration,
  isTypeReferenceNode,
  isVariableDeclaration,
} from "typescript/unstable/ast/is"

export interface NativeTarget {
  readonly packageInfo: PackageInfo
  readonly project: Project
  readonly program: Project["program"]
  readonly checker: Project["checker"]
  readonly symbol: Symbol
  readonly declaration: Node
  readonly nameNode: Node
}

const resolveNativePackage = (ctx: NativeCommandContext, packageName?: string): PackageInfo => {
  const packages = discoverPackagesSync(ctx.rootDirectory)
  if (packages.length === 0) throw new Error(`No TypeScript package found under ${ctx.rootDirectory}`)

  if (packageName === undefined || packageName.trim() === "") {
    const rootPackage = packages.find((pkg) => pkg.name === "(root)")
    if (rootPackage !== undefined) return rootPackage
    if (packages.length === 1) return packages[0]!
    throw new Error(`Multiple packages found. Please specify a package: ${packages.map((pkg) => pkg.name).join(", ")}`)
  }

  const normalized = packageName.replace(/^\//, "")
  const found = packages.find((pkg) =>
    pkg.name === packageName || pkg.name === normalized || pkg.path.endsWith(packageName),
  )
  if (found === undefined) {
    throw new Error(`Package "${packageName}" not found. Available: ${packages.map((pkg) => pkg.name).join(", ")}`)
  }
  return found
}

export const loadNativeTarget = (
  ctx: NativeCommandContext,
  packageName: string | undefined,
  symbolName: string,
): NativeTarget | null => {
  const packageInfo = resolveNativePackage(ctx, packageName)
  const project = ctx.engine.getProject(packageInfo.tsconfigPath)
  const program = project.program
  const checker = project.checker

  for (const fileName of program.getSourceFileNames()) {
    const sourceFile = program.getSourceFile(fileName)
    if (sourceFile === undefined || !isProjectSourceFile(sourceFile, packageInfo.path)) continue

    let found: NativeTarget | null = null
    const visit = (node: Node): void => {
      if (found !== null || !isIdentifier(node) || node.text !== symbolName) {
        if (found === null) node.forEachChild(visit)
        return
      }

      const symbol = checker.getSymbolAtLocation(node)
      if (symbol === undefined || symbol.name !== symbolName) {
        node.forEachChild(visit)
        return
      }

      const declaration = symbol.declarations
        .map((handle) => handle.resolve(project))
        .find((candidate) => candidate !== undefined && isProjectSourceFile(candidate.getSourceFile(), packageInfo.path))
      if (declaration === undefined) {
        node.forEachChild(visit)
        return
      }

      found = { packageInfo, project, program, checker, symbol, declaration, nameNode: node }
    }
    sourceFile.forEachChild(visit)
    if (found !== null) return found
  }

  return null
}

const projectSourceFiles = (target: Pick<NativeTarget, "program" | "packageInfo">): SourceFile[] =>
  target.program.getSourceFileNames().flatMap((fileName) => {
    const sourceFile = target.program.getSourceFile(fileName)
    return sourceFile !== undefined && isProjectSourceFile(sourceFile, target.packageInfo.path) ? [sourceFile] : []
  })

const relativeNativePath = (ctx: NativeCommandContext, absolutePath: string): string => {
  const root = resolve(ctx.rootDirectory)
  const normalized = resolve(absolutePath)
  return normalized === root || normalized.startsWith(`${root}/`) ? relative(root, normalized) : normalized
}

export const findNativeRelated = (ctx: NativeCommandContext, symbolName: string, packageName?: string): RelatedInfo | null => {
  const target = loadNativeTarget(ctx, packageName, symbolName)
  if (target === null) return null

  return {
    symbol: symbolName,
    referencedBy: findIncomingReferences(ctx, target),
    references: findOutgoingReferences(target),
  }
}

const findIncomingReferences = (
  ctx: NativeCommandContext,
  target: NativeTarget,
): RelatedInfo["referencedBy"] => {
  const results: RelatedInfo["referencedBy"] = []
  const seen = new Set<string>()

  for (const sourceFile of projectSourceFiles(target)) {
    for (const handle of target.checker.getReferencesToSymbolInFile(sourceFile.fileName, target.symbol)) {
      const reference = handle.resolve(target.project)
      if (reference === undefined) continue

      const referenceSourceFile = reference.getSourceFile()
      const containing = findContainingSymbol(target.checker, reference.parent, target.symbol, referenceSourceFile)
      const key = `${containing}:${classifyReferenceContext(reference.parent)}:${lineOf(referenceSourceFile, reference)}`
      if (seen.has(key)) continue
      seen.add(key)

      results.push({
        symbol: containing,
        context: classifyReferenceContext(reference.parent),
        file: relativeNativePath(ctx, referenceSourceFile.fileName),
        line: lineOf(referenceSourceFile, reference),
      })
    }
  }

  return results
}

const findOutgoingReferences = (target: NativeTarget): RelatedInfo["references"] => {
  const references: RelatedInfo["references"] = []
  const seen = new Set<string>()
  const add = (symbol: Symbol | undefined, context: string): void => {
    if (symbol === undefined || symbol.name === target.symbol.name || isPrimitiveRelatedType(symbol.name)) return
    const key = `${symbol.name}:${context}`
    if (seen.has(key)) return
    seen.add(key)
    references.push({ symbol: symbol.name, context })
  }

  const type = target.checker.getTypeAtLocation(target.declaration)
  for (const property of target.checker.getPropertiesOfType(type).slice(0, 50)) {
    const declaration = property.declarations.map((handle) => handle.resolve(target.project)).find(Boolean)
    if (declaration === undefined) continue
    const propertyType = target.checker.getTypeOfSymbolAtLocation(property, declaration)
    add(propertyType.getSymbol() ?? propertyType.getAliasSymbol(), `property "${property.name}"`)
  }

  if (type.isClassOrInterface()) {
    for (const baseType of target.checker.getBaseTypes(type)) add(baseType.getSymbol() ?? baseType.getAliasSymbol(), "extends")
  }

  collectReferencedSymbols(target, (symbol) => add(symbol, referenceContextForNode(symbol, target)))
  return references
}

const collectReferencedSymbols = (target: NativeTarget, add: (symbol: Symbol | undefined) => void): void => {
  const visit = (node: Node): void => {
    if (isIdentifier(node) && isTypeReferencePosition(node)) {
      for (const entry of target.checker.getReferencedSymbolsForNode(node, node.pos)) add(entry.symbol)
    }
    node.forEachChild(visit)
  }
  target.declaration.forEachChild(visit)
}

const referenceContextForNode = (symbol: Symbol | undefined, target: NativeTarget): string => {
  if (symbol === undefined) return "usage"
  const declaration = symbol.declarations.map((handle) => handle.resolve(target.project)).find(Boolean)
  if (declaration !== undefined && declaration.parent.kind === SyntaxKind.HeritageClause) return "extends"
  return "usage"
}

const isTypeReferencePosition = (node: Node): boolean => {
  const parentKind = node.parent?.kind
  return parentKind === SyntaxKind.TypeReference || parentKind === SyntaxKind.ExpressionWithTypeArguments
    || isTypeReferenceNode(node.parent)
}

const classifyReferenceContext = (parent: Node): string => {
  switch (parent.kind) {
    case SyntaxKind.HeritageClause:
      return "extends"
    case SyntaxKind.TypeReference:
      return "type reference"
    case SyntaxKind.PropertyAccessExpression:
      return "property access"
    case SyntaxKind.CallExpression:
      return "call"
    default:
      return "usage"
  }
}

const findContainingSymbol = (
  checker: NativeTarget["checker"],
  start: Node,
  target: Symbol,
  sourceFile: SourceFile,
): string => {
  let current: Node | undefined = start
  while (current !== undefined) {
    const nameNode = declarationName(current)
    const symbol = nameNode === undefined ? undefined : checker.getSymbolAtLocation(nameNode)
    if (symbol !== undefined && symbol.id !== target.id) return symbol.name
    current = current.parent
  }
  return checker.getSymbolAtLocation(sourceFile)?.name ?? "anonymous"
}

const declarationName = (node: Node): Node | undefined => {
  if (
    isClassDeclaration(node) || isEnumDeclaration(node) || isFunctionDeclaration(node) ||
    isInterfaceDeclaration(node) || isMethodDeclaration(node) || isPropertyDeclaration(node) ||
    isPropertySignatureDeclaration(node) || isTypeAliasDeclaration(node) || isVariableDeclaration(node)
  ) {
    const name = node.name
    return name !== undefined && isIdentifier(name) ? name : undefined
  }
  return undefined
}

const lineOf = (sourceFile: SourceFile, node: Node): number => sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1

const isProjectSourceFile = (sourceFile: SourceFile, packagePath: string): boolean => {
  const fileName = resolve(sourceFile.fileName)
  const root = resolve(packagePath)
  return fileName.startsWith(`${root}/`) && !fileName.includes("/node_modules/")
}

const isPrimitiveRelatedType = (typeName: string): boolean => typeName === "string" || typeName === "number" || typeName === "boolean"

export interface NativeRenameSite {
  readonly sourceFile: SourceFile
  readonly node: Node
}

export const findNativeRenameSites = (target: NativeTarget): NativeRenameSite[] => {
  const sites: NativeRenameSite[] = []
  const seen = new Set<string>()
  for (const sourceFile of projectSourceFiles(target)) {
    for (const handle of target.checker.getReferencesToSymbolInFile(sourceFile.fileName, target.symbol)) {
      const node = handle.resolve(target.project)
      if (node === undefined || !isIdentifier(node)) continue
      const key = `${sourceFile.fileName}:${node.pos}`
      if (seen.has(key)) continue
      seen.add(key)
      sites.push({ sourceFile: node.getSourceFile(), node })
    }
  }
  return sites
}

export const buildNativeRenameResult = (
  ctx: NativeCommandContext,
  target: NativeTarget,
  symbolName: string,
  to: string,
  sites: readonly NativeRenameSite[],
): RefactorPreviewResult => {
  const locations: RefactorLocation[] = []
  const predictedErrors: RefactorError[] = []
  const affectedFiles = new Set<string>()
  const replaceRegex = new RegExp(`\\b${escapeRegex(symbolName)}\\b`, "g")

  for (const site of sites) {
    const sourceFile = site.sourceFile
    const file = relativeNativePath(ctx, sourceFile.fileName)
    const line = lineOf(sourceFile, site.node)
    const lineText = sourceFile.text.split("\n")[line - 1] ?? ""
    const before = lineText.trim()
    const after = before.replace(replaceRegex, to)
    affectedFiles.add(sourceFile.fileName)
    addRenameLocationSafetyError(predictedErrors, sourceFile, file, target.packageInfo.path, line)
    locations.push({ file, line, column: sourceFile.getLineAndCharacterOfPosition(site.node.getStart(sourceFile)).character, before, after })
  }

  const stringLiteralLocations: StringLiteralRef[] = []
  const commentLocations: StringLiteralRef[] = []
  for (const sourceFile of projectSourceFiles(target)) {
    if (!affectedFiles.has(sourceFile.fileName)) continue
    collectStringLiteralLocations(sourceFile, ctx, symbolName, stringLiteralLocations)
    collectCommentLocations(sourceFile, ctx, symbolName, commentLocations)
  }

  const safetyNotes: string[] = []
  if (stringLiteralLocations.length > 0) safetyNotes.push(`${stringLiteralLocations.length} string literal(s) contain "${symbolName}" and won't be renamed automatically`)
  if (commentLocations.length > 0) safetyNotes.push(`${commentLocations.length} comment(s) contain "${symbolName}" and may need manual review`)

  return {
    action: "rename",
    from: symbolName,
    to,
    locations: locations.slice(0, 100),
    totalLocations: locations.length,
    predictedErrors,
    confidence: predictedErrors.length > 0 ? "low" : "high",
    safe: predictedErrors.length === 0 && safetyNotes.length === 0,
    safetyNotes,
    stringLiteralLocations: stringLiteralLocations.slice(0, 20),
    commentLocations: commentLocations.slice(0, 20),
  }
}

const addRenameLocationSafetyError = (
  errors: RefactorError[],
  sourceFile: SourceFile,
  file: string,
  packagePath: string,
  line: number,
): void => {
  if (errors.some((error) => error.file === file && error.line === line)) return
  if (sourceFile.isDeclarationFile) {
    errors.push({ file, line, message: "Cannot rename: declaration file (.d.ts)" })
  } else if (!resolve(sourceFile.fileName).startsWith(`${resolve(packagePath)}/`)) {
    errors.push({ file, line, message: "Cannot rename: file is outside package boundary" })
  }
}

const collectStringLiteralLocations = (sourceFile: SourceFile, ctx: NativeCommandContext, symbolName: string, results: StringLiteralRef[]): void => {
  const regex = new RegExp(`\\b${escapeRegex(symbolName)}\\b`)
  const visit = (node: Node): void => {
    if (node.kind === SyntaxKind.StringLiteral && regex.test(node.getText(sourceFile).slice(1, -1))) {
      const line = lineOf(sourceFile, node)
      const content = node.getText(sourceFile).slice(1, -1)
      results.push({ file: relativeNativePath(ctx, sourceFile.fileName), line, content: content.length > 50 ? `${content.slice(0, 50)}...` : content })
    }
    node.forEachChild(visit)
  }
  sourceFile.forEachChild(visit)
}

const collectCommentLocations = (sourceFile: SourceFile, ctx: NativeCommandContext, symbolName: string, results: StringLiteralRef[]): void => {
  const regex = new RegExp(`\\b${escapeRegex(symbolName)}\\b`)
  const lines = sourceFile.text.split("\n")
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!
    const singleLine = line.match(/\/\/(.*)$/)
    if (singleLine !== null && regex.test(singleLine[1]!)) {
      addCommentReference(results, relativeNativePath(ctx, sourceFile.fileName), index + 1, singleLine[1]!.trim())
      continue
    }
    if ((line.includes("/*") || line.includes("*")) && regex.test(line)) {
      const trimmed = line.trim()
      if (trimmed.startsWith("*") || trimmed.startsWith("/*") || trimmed.startsWith("//")) {
        addCommentReference(results, relativeNativePath(ctx, sourceFile.fileName), index + 1, trimmed)
      }
    }
  }
}

const addCommentReference = (results: StringLiteralRef[], file: string, line: number, content: string): void => {
  results.push({ file, line, content: content.length > 50 ? `${content.slice(0, 50)}...` : content })
}

const escapeRegex = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

export const isIdentifierRename = (value: string): boolean => /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(value)
