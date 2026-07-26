import { relative, resolve } from "node:path"
import type { Node, SourceFile } from "typescript/unstable/ast"
import { SyntaxKind } from "typescript/unstable/ast"
import { isTypeReferenceNode } from "typescript/unstable/ast/is"
import type { Project, Symbol, Type } from "typescript/unstable/async"
import type { AnalyzerContext } from "./context"
import type {
  GraphEdge,
  GraphResult,
  PackageInfo,
  RefactorError,
  RefactorLocation,
  RefactorPreviewResult,
  RefactorPreviewOptions,
  RelatedInfo,
  StringLiteralRef,
} from "./contracts"

type Target = {
  readonly symbol: Symbol
  readonly declaration: Node
  readonly packagePath: string
  readonly rootPath: string
}

type TargetIndex = {
  readonly lookup: (requestedName: string) => Promise<Target | null>
}

type RenameSite = {
  readonly sourceFile: SourceFile
  readonly node: Node
}

type NamedNode = Node & { readonly name?: Node }
type ExportSpecifierNode = Node & { readonly name: Node; readonly propertyName?: Node }

const PRIMITIVE_NAMES: Record<string, true> = {
  string: true,
  number: true,
  boolean: true,
  undefined: true,
  null: true,
  void: true,
  any: true,
  never: true,
  object: true,
  symbol: true,
  bigint: true,
  Date: true,
  Array: true,
  Object: true,
  String: true,
  Number: true,
  Boolean: true,
  Promise: true,
  Map: true,
  Set: true,
  WeakMap: true,
  WeakSet: true,
  Error: true,
  Function: true,
}
const MAX_RENAME_LOCATIONS = 100
const MAX_STRING_OR_COMMENT_LOCATIONS = 20
const MAX_REFERENCE_RESULTS_PER_FILE = 100
const MAX_GRAPH_DEPTH = 4

export const createReferenceOperations = (context: AnalyzerContext) => ({
  findRelated: (symbolName: string, packageName?: string): Promise<RelatedInfo | null> =>
    context.withProject(async (project, pkg, revision) => {
      const target = await findTarget(context, project, pkg, revision, symbolName)
      if (target === null) return null
      return {
        symbol: symbolName,
        referencedBy: await findIncomingReferences(project, target),
        references: await findOutgoingReferences(project, target),
      }
    }, packageName),

  generateGraph: (
    symbolName: string,
    options: { readonly depth?: number; readonly format?: "mermaid" | "dot"; readonly packageName?: string } = {},
  ): Promise<GraphResult | null> =>
    context.withProject(async (project, pkg, revision) => {
      const depth = Math.max(0, Math.min(options.depth ?? 2, MAX_GRAPH_DEPTH))
      const format = options.format ?? "mermaid"
      const targets = targetIndexFor(context, project, pkg, revision)
      const rootTarget = await targets.lookup(symbolName)
      if (rootTarget === null) return null

      const nodes: string[] = [symbolName]
      const nodeIds = new Set<string>([String(rootTarget.symbol.id)])
      const edges: GraphEdge[] = []
      const edgeKeys = new Set<string>()
      const visited = new Set<string>()

      const visit = async (target: Target, displayName: string, currentDepth: number): Promise<void> => {
        const targetId = String(target.symbol.id)
        if (visited.has(targetId) || currentDepth > depth) return
        visited.add(targetId)

        const outgoing = await findOutgoingReferences(project, target)
        if (currentDepth >= depth) return
        for (const reference of outgoing) {
          const child = await targets.lookup(reference.symbol)
          if (child === null) continue
          const childId = String(child.symbol.id)
          const childName = child.symbol.name
          if (!nodeIds.has(childId)) {
            nodes.push(childName)
          }
          const edgeKey = `${targetId}:${childId}:${reference.context}`
          if (!edgeKeys.has(edgeKey)) {
            edgeKeys.add(edgeKey)
            edges.push({ from: displayName, to: childName, label: reference.context })
          }
          await visit(child, childName, currentDepth + 1)
        }
      }

      await visit(rootTarget, symbolName, 0)
      return {
        root: symbolName,
        format,
        depth,
        nodes,
        edges,
        graph: format === "mermaid" ? toMermaid(edges) : toDot(edges),
      }
    }, options.packageName),

  previewRefactor: (options: RefactorPreviewOptions): Promise<RefactorPreviewResult> =>
    context.withProject(async (project, pkg, revision) => {
      if (options.action !== "rename") {
        throw new Error(`Unsupported refactor action: ${options.action}`)
      }
      const target = await findTarget(context, project, pkg, revision, options.symbol)
      if (target === null) {
        throw new Error(`Symbol "${options.symbol}" not found`)
      }

      const sites = await findRenameSites(project, target)
      const locations: RefactorLocation[] = []
      const predictedErrors: RefactorError[] = []
      const affectedFiles = new Set<string>()
      for (const site of sites) {
        const sourceFile = site.sourceFile
        const file = relativePath(context.root, sourceFile.fileName)
        const position = sourceFile.getLineAndCharacterOfPosition(site.node.getStart(sourceFile))
        const line = position.line + 1
        const lineText = getLineText(sourceFile, position.line)
        const before = lineText.trim()
        const after = replaceSiteOnTrimmedLine(lineText, before, position.character, site.node.getText(sourceFile), options.to)
        affectedFiles.add(sourceFile.fileName)
        addRenameSafetyError(predictedErrors, sourceFile, file, pkg.path, line)
        locations.push({ file, line, column: position.character + 1, before, after })
      }

      const stringLiteralLocations: StringLiteralRef[] = []
      const commentLocations: StringLiteralRef[] = []
      for (const fileName of affectedFiles) {
        const sourceFile = await project.program.getSourceFile(fileName)
        if (sourceFile === undefined) continue
        collectStringLiteralLocations(sourceFile, context.root, options.symbol, stringLiteralLocations)
        collectCommentLocations(sourceFile, context.root, options.symbol, commentLocations)
      }

      const safetyNotes: string[] = []
      if (stringLiteralLocations.length > 0) {
        safetyNotes.push(`${stringLiteralLocations.length} string literal(s) contain "${options.symbol}" and won't be renamed automatically`)
      }
      if (commentLocations.length > 0) {
        safetyNotes.push(`${commentLocations.length} comment(s) contain "${options.symbol}" and may need manual review`)
      }

      return {
        action: "rename",
        from: options.symbol,
        to: options.to,
        locations: locations.slice(0, MAX_RENAME_LOCATIONS),
        totalLocations: locations.length,
        predictedErrors,
        confidence: predictedErrors.length > 0 ? "low" : "high",
        safe: predictedErrors.length === 0 && safetyNotes.length === 0,
        safetyNotes,
        stringLiteralLocations: stringLiteralLocations.slice(0, MAX_STRING_OR_COMMENT_LOCATIONS),
        commentLocations: commentLocations.slice(0, MAX_STRING_OR_COMMENT_LOCATIONS),
      }
    }, options.packageName),
})

const findTarget = (
  context: AnalyzerContext,
  project: Project,
  pkg: PackageInfo,
  revision: number,
  requestedName: string,
): Promise<Target | null> => targetIndexFor(context, project, pkg, revision).lookup(requestedName)

/**
 * Revision-keyed name → Target index. Built once per package revision so recursive
 * graph expansion (and repeated findTarget callers) do not re-scan the project for
 * every child symbol name.
 */
const targetIndexFor = (
  context: AnalyzerContext,
  project: Project,
  pkg: PackageInfo,
  revision: number,
): TargetIndex =>
  context.cacheForRevision(`target-index:${pkg.tsconfigPath}`, revision, () => {
    const memo = new Map<string, Promise<Target | null>>()
    let declarationIndex: Promise<Map<string, Target>> | undefined
    const loadDeclarationIndex = (): Promise<Map<string, Target>> => {
      declarationIndex ??= buildDeclarationTargetIndex(project, pkg.path, context.root)
      return declarationIndex
    }
    return {
      lookup: (requestedName: string): Promise<Target | null> => {
        const cached = memo.get(requestedName)
        if (cached !== undefined) return cached
        const pending = (async (): Promise<Target | null> => {
          const byName = await loadDeclarationIndex()
          const fromIndex = byName.get(requestedName)
          if (fromIndex !== undefined) return fromIndex
          // Preserve full-scan semantics for names that only appear as usages / default.
          return findTargetByScan(project, pkg.path, context.root, requestedName)
        })()
        memo.set(requestedName, pending)
        return pending
      },
    }
  })

const buildDeclarationTargetIndex = async (
  project: Project,
  packagePath: string,
  rootPath: string,
): Promise<Map<string, Target>> => {
  const byName = new Map<string, Target>()
  const sourceFiles = await projectSourceFiles(project, packagePath)

  for (const sourceFile of sourceFiles) {
    const named: Node[] = []
    visit(sourceFile, (node) => {
      if (node.kind === SyntaxKind.Identifier && declarationForName(node) !== undefined) {
        named.push(node)
        return
      }
      if (node.kind === SyntaxKind.ExportSpecifier) {
        const exportName = (node as ExportSpecifierNode).name
        if (exportName.kind === SyntaxKind.Identifier) named.push(exportName)
      }
    })
    if (named.length === 0) continue

    const symbols = await project.checker.getSymbolAtLocation(named)
    for (let index = 0; index < named.length; index += 1) {
      const nameNode = named[index]!
      const key = nameNode.getText(sourceFile)
      if (byName.has(key)) continue
      const symbol = symbols[index]
      if (symbol === undefined) continue
      const resolved = await resolveSymbol(project, symbol)
      const declaration =
        declarationForName(nameNode)
        ?? (await findDeclarationForSymbol(sourceFile, project, resolved))
      if (declaration !== undefined) {
        byName.set(key, { symbol: resolved, declaration, packagePath, rootPath })
        continue
      }
      const first = resolved.declarations[0]
      const fallback = first === undefined ? undefined : await first.resolve(project)
      if (fallback !== undefined) byName.set(key, { symbol: resolved, declaration: fallback, packagePath, rootPath })
    }
  }

  if (!byName.has("default")) {
    for (const sourceFile of sourceFiles) {
      const moduleSymbol = await project.checker.getSymbolAtLocation(sourceFile)
      if (moduleSymbol === undefined) continue
      const exports = await project.checker.getExportsOfModule(moduleSymbol)
      const defaultExport = exports.find((candidate) => candidate.name === "default")
      if (defaultExport === undefined) continue
      const resolved = await resolveSymbol(project, defaultExport)
      const declaration = await findDeclarationForSymbol(sourceFile, project, resolved)
      if (declaration !== undefined) {
        byName.set("default", { symbol: resolved, declaration, packagePath, rootPath })
        break
      }
      const first = resolved.declarations[0]
      const node = first === undefined ? undefined : await first.resolve(project)
      if (node !== undefined) {
        byName.set("default", { symbol: resolved, declaration: node, packagePath, rootPath })
        break
      }
    }
  }

  return byName
}

const findTargetByScan = async (
  project: Project,
  packagePath: string,
  rootPath: string,
  requestedName: string,
): Promise<Target | null> => {
  const sourceFiles = await projectSourceFiles(project, packagePath)
  let canonical: Symbol | undefined

  for (const sourceFile of sourceFiles) {
    const identifiers: Node[] = []
    visit(sourceFile, (node) => {
      if (node.kind === SyntaxKind.Identifier && node.getText(sourceFile) === requestedName) identifiers.push(node)
    })
    if (identifiers.length === 0) continue
    const symbols = await project.checker.getSymbolAtLocation(identifiers)
    for (let index = 0; index < identifiers.length; index += 1) {
      const identifier = identifiers[index]!
      const symbol = symbols[index]
      if (symbol === undefined) continue
      const resolved = await resolveSymbol(project, symbol)
      canonical ??= resolved
      if (resolved.id !== canonical.id) continue
      const declaration = declarationForName(identifier)
      if (declaration !== undefined) return { symbol: resolved, declaration, packagePath, rootPath }
    }

    if (canonical !== undefined) break
  }

  if (canonical !== undefined) {
    for (const sourceFile of sourceFiles) {
      const declaration = await findDeclarationForSymbol(sourceFile, project, canonical)
      if (declaration !== undefined) return { symbol: canonical, declaration, packagePath, rootPath }
    }
    const first = canonical.declarations[0]
    const declaration = first === undefined ? undefined : await first.resolve(project)
    if (declaration !== undefined) return { symbol: canonical, declaration, packagePath, rootPath }
  }

  if (requestedName === "default") {
    for (const sourceFile of sourceFiles) {
      const moduleSymbol = await project.checker.getSymbolAtLocation(sourceFile)
      if (moduleSymbol === undefined) continue
      const exports = await project.checker.getExportsOfModule(moduleSymbol)
      const defaultExport = exports.find((candidate) => candidate.name === "default")
      if (defaultExport === undefined) continue
      const resolved = await resolveSymbol(project, defaultExport)
      const declaration = await findDeclarationForSymbol(sourceFile, project, resolved)
      if (declaration !== undefined) return { symbol: resolved, declaration, packagePath, rootPath }
      const first = resolved.declarations[0]
      const node = first === undefined ? undefined : await first.resolve(project)
      if (node !== undefined) return { symbol: resolved, declaration: node, packagePath, rootPath }
    }
  }

  return null
}

const findDeclarationForSymbol = async (sourceFile: SourceFile, project: Project, target: Symbol): Promise<Node | undefined> => {
  for (const handle of target.declarations) {
    const declaration = await handle.resolve(project)
    if (declaration !== undefined && declaration.getSourceFile().fileName === sourceFile.fileName) return declaration
  }
  return undefined
}


const findIncomingReferences = async (project: Project, target: Target): Promise<RelatedInfo["referencedBy"]> => {
  const results: Array<RelatedInfo["referencedBy"][number]> = []
  const seen = new Set<string>()
  const perFileCounts = new Map<string, number>()
  const add = async (node: Node, symbol: Symbol = target.symbol): Promise<void> => {
    if (node.kind !== SyntaxKind.Identifier || isImportReference(node)) return
    const sourceFile = node.getSourceFile()
    if (!isProjectSourceFile(sourceFile.fileName, target.packagePath)) return
    const fileCount = perFileCounts.get(sourceFile.fileName) ?? 0
    if (fileCount >= MAX_REFERENCE_RESULTS_PER_FILE) return
    if (!(await matchesCanonicalSymbol(project, symbol, target.symbol))) return
    if (isTargetDeclarationName(node, target)) return
    const containing = await findContainingSymbol(project, node.parent, target.symbol)
    const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
    const context = classifyReferenceContext(node.parent)
    const key = `${sourceFile.fileName}:${node.getStart(sourceFile)}:${containing}:${context}`
    if (seen.has(key)) return
    seen.add(key)
    perFileCounts.set(sourceFile.fileName, fileCount + 1)
    results.push({
      symbol: containing,
      context,
      file: relativePath(target.rootPath, sourceFile.fileName),
      line: position.line + 1,
    })
  }

  // Prefer compiler-native reference collection: scales with references, not
  // every identifier / type-reference node in the project.
  const declarationName = declarationNameNode(target.declaration) ?? target.declaration
  const declarationPosition = declarationName.getStart(declarationName.getSourceFile())
  try {
    const referenced = await project.checker.getReferencedSymbolsForNode(declarationName, declarationPosition)
    for (const entry of referenced) {
      const handles = [entry.definition, ...entry.references]
      for (const handle of handles) {
        const node = await handle.resolve(project)
        if (node !== undefined) await add(node, entry.symbol ?? target.symbol)
      }
    }
    if (results.length > 0) return results
  } catch {
    // Fall through to the per-file scan if the native reference API rejects the node.
  }

  // Fallback: per-file native references + batched type-reference verification.
  const sourceFiles = await projectSourceFiles(project, target.packagePath)
  for (const sourceFile of sourceFiles) {
    const handles = await project.checker.getReferencesToSymbolInFile(sourceFile.fileName, target.symbol)
    for (const handle of handles) {
      const node = await handle.resolve(project)
      if (node !== undefined) await add(node)
    }

    const typeNodes: Node[] = []
    visit(sourceFile, (node) => {
      if (node.kind === SyntaxKind.Identifier && isTypeReferencePosition(node)) typeNodes.push(node)
    })
    if (typeNodes.length === 0) continue
    const symbols = await project.checker.getSymbolAtLocation(typeNodes)
    for (let index = 0; index < typeNodes.length; index += 1) {
      await add(typeNodes[index]!, symbols[index])
    }
  }
  return results
}

const findOutgoingReferences = async (project: Project, target: Target): Promise<RelatedInfo["references"]> => {
  const references: Array<RelatedInfo["references"][number]> = []
  const seen = new Set<string>()
  const add = async (symbol: Symbol | undefined, context: string): Promise<void> => {
    if (symbol === undefined) return
    const resolved = await resolveSymbol(project, symbol)
    if (resolved.id === target.symbol.id || PRIMITIVE_NAMES[resolved.name] === true) return
    const key = `${resolved.id}:${context}`
    if (seen.has(key)) return
    seen.add(key)
    references.push({ symbol: resolved.name, context })
  }

  const type = await project.checker.getTypeAtLocation(target.declaration)
  if (await skipOutgoingType(type)) return references
  const properties = await project.checker.getPropertiesOfType(type)
  for (const property of properties.slice(0, 50)) {
    const declarationHandle = property.declarations[0]
    if (declarationHandle === undefined) continue
    const declaration = await declarationHandle.resolve(project)
    if (declaration === undefined) continue
    const propertyType = await project.checker.getTypeOfSymbolAtLocation(property, declaration)
    await add((await propertyType.getSymbol()) ?? (await propertyType.getAliasSymbol()), `property "${property.name}"`)
  }
  if (type.isClassOrInterface()) {
    const baseTypes = await project.checker.getBaseTypes(type)
    for (const baseType of baseTypes) await add((await baseType.getSymbol()) ?? (await baseType.getAliasSymbol()), "extends")
  }
  return references
}

const findRenameSites = async (project: Project, target: Target): Promise<RenameSite[]> => {
  const sites: RenameSite[] = []
  const seen = new Set<string>()

  // Prefer compiler-native reference collection: scales with references, not
  // every identifier in the project.
  const declarationName = declarationNameNode(target.declaration) ?? target.declaration
  const position = declarationName.getStart(declarationName.getSourceFile())
  try {
    const referenced = await project.checker.getReferencedSymbolsForNode(declarationName, position)
    for (const entry of referenced) {
      const handles = [entry.definition, ...entry.references]
      for (const handle of handles) {
        const node = await handle.resolve(project)
        if (node === undefined || node.kind !== SyntaxKind.Identifier) continue
        const sourceFile = node.getSourceFile()
        if (!isProjectSourceFile(sourceFile.fileName, target.packagePath)) continue
        addSite(sites, seen, sourceFile, node)
      }
    }
    if (sites.length > 0) return sites
  } catch {
    // Fall through to the full scan if the native reference API rejects the node.
  }

  // Fallback: batch symbol lookup across identifiers (still one call per file).
  const sourceFiles = await projectSourceFiles(project, target.packagePath)
  const resolvedTarget = await resolveSymbol(project, target.symbol)
  for (const sourceFile of sourceFiles) {
    const nodes: Node[] = []
    visit(sourceFile, (node) => {
      if (node.kind === SyntaxKind.Identifier) nodes.push(node)
    })
    if (nodes.length === 0) continue
    const symbols = await project.checker.getSymbolAtLocation(nodes)
    for (let index = 0; index < nodes.length; index += 1) {
      const node = nodes[index]!
      const symbol = symbols[index]
      if (symbol === undefined) continue
      const resolved = await resolveSymbol(project, symbol)
      if (resolved.id !== resolvedTarget.id) continue
      addSite(sites, seen, sourceFile, node)
    }
  }
  return sites
}

const addSite = (sites: RenameSite[], seen: Set<string>, sourceFile: SourceFile, node: Node): void => {
  const key = `${sourceFile.fileName}:${node.pos}`
  if (seen.has(key)) return
  seen.add(key)
  sites.push({ sourceFile, node })
}

const findContainingSymbol = async (project: Project, start: Node, target: Symbol): Promise<string> => {
  let current: Node | undefined = start
  while (current !== undefined && current.kind !== SyntaxKind.SourceFile) {
    const nameNode = declarationNameNode(current)
    if (nameNode !== undefined) {
      const symbol = await project.checker.getSymbolAtLocation(nameNode)
      if (symbol !== undefined && !(await matchesCanonicalSymbol(project, symbol, target))) return symbol.name
    }
    current = current.parent
  }
  const sourceFile = start.getSourceFile()
  const moduleSymbol = await project.checker.getSymbolAtLocation(sourceFile)
  return moduleSymbol?.name ?? "anonymous"
}

const resolveSymbol = async (project: Project, symbol: Symbol): Promise<Symbol> => {
  try {
    return await project.checker.getAliasedSymbol(symbol)
  } catch {
    return symbol
  }
}

const matchesCanonicalSymbol = async (project: Project, candidate: Symbol, target: Symbol): Promise<boolean> =>
  (await resolveSymbol(project, candidate)).id === target.id

const projectSourceFiles = async (project: Project, packagePath: string): Promise<SourceFile[]> => {
  const names = await project.program.getSourceFileNames()
  const files: SourceFile[] = []
  for (const name of names) {
    if (!isProjectSourceFile(name, packagePath)) continue
    const sourceFile = await project.program.getSourceFile(name)
    if (sourceFile !== undefined) files.push(sourceFile)
  }
  return files
}

const isProjectSourceFile = (fileName: string, packagePath: string): boolean => {
  const file = resolve(fileName)
  const root = resolve(packagePath)
  return (file === root || file.startsWith(`${root}/`)) && !file.includes("/node_modules/")
}

const relativePath = (root: string, fileName: string): string => {
  const file = resolve(fileName)
  const normalizedRoot = resolve(root)
  return file === normalizedRoot || file.startsWith(`${normalizedRoot}/`) ? relative(normalizedRoot, file) : file
}


const visit = (node: Node, callback: (node: Node) => void): void => {
  callback(node)
  node.forEachChild((child) => {
    visit(child, callback)
  })
}

const declarationForName = (nameNode: Node): Node | undefined => {
  const parent = nameNode.parent
  if (declarationNameNode(parent) === nameNode) return parent
  return undefined
}
const isImportReference = (node: Node): boolean => {
  let current: Node | undefined = node.parent
  while (current !== undefined && current.kind !== SyntaxKind.SourceFile) {
    if (current.kind === SyntaxKind.ImportDeclaration) return true
    current = current.parent
  }
  return false
}

const declarationNameNode = (node: Node): Node | undefined => {
  switch (node.kind) {
    case SyntaxKind.ClassDeclaration:
    case SyntaxKind.ClassExpression:
    case SyntaxKind.FunctionDeclaration:
    case SyntaxKind.FunctionExpression:
    case SyntaxKind.InterfaceDeclaration:
    case SyntaxKind.TypeAliasDeclaration:
    case SyntaxKind.EnumDeclaration:
    case SyntaxKind.VariableDeclaration:
    case SyntaxKind.MethodDeclaration:
    case SyntaxKind.MethodSignature:
    case SyntaxKind.PropertyDeclaration:
    case SyntaxKind.PropertySignature:
    case SyntaxKind.EnumMember:
    case SyntaxKind.ImportEqualsDeclaration:
      return (node as NamedNode).name
    default:
      return undefined
  }
}

const isTargetDeclarationName = (node: Node, target: Target): boolean => {
  const declaration = declarationForName(node)
  return declaration !== undefined && declaration.pos === target.declaration.pos
}

const isTypeReferencePosition = (node: Node): boolean => {
  const parent = node.parent
  return parent !== undefined && (
    parent.kind === SyntaxKind.TypeReference
    || parent.kind === SyntaxKind.ExpressionWithTypeArguments
    || isTypeReferenceNode(parent)
  )
}

const classifyReferenceContext = (parent: Node): string => {
  switch (parent.kind) {
    case SyntaxKind.HeritageClause:
      return "extends"
    case SyntaxKind.TypeReference:
    case SyntaxKind.ExpressionWithTypeArguments:
      return "type reference"
    case SyntaxKind.PropertyAccessExpression:
      return "property access"
    case SyntaxKind.CallExpression:
      return "call"
    default:
      return "usage"
  }
}

const skipOutgoingType = async (type: Type): Promise<boolean> => {
  if (type.isIntrinsicType() || type.isLiteralType()) return true
  if (type.isUnionType()) {
    const members = await type.getTypes()
    return members.every((member) => member.isIntrinsicType() || member.isLiteralType())
  }
  return false
}
const toMermaid = (edges: readonly GraphEdge[]): string => {
  const lines = ["graph TD"]
  const seen = new Set<string>()
  for (const edge of edges) {
    const from = sanitizeMermaidId(edge.from)
    const to = sanitizeMermaidId(edge.to)
    const key = `${from}-->${to}`
    if (seen.has(key)) continue
    seen.add(key)
    const label = edge.label?.replace(/"/g, "'").replace(/[|[\]]/g, "")
    lines.push(label === undefined ? `  ${from} --> ${to}` : `  ${from} -->|${label}| ${to}`)
  }
  return lines.join("\n")
}

const toDot = (edges: readonly GraphEdge[]): string => {
  const lines = ["digraph G {", "  rankdir=TB;", "  node [shape=box];"]
  const seen = new Set<string>()
  for (const edge of edges) {
    const key = `${edge.from}->${edge.to}`
    if (seen.has(key)) continue
    seen.add(key)
    const from = `"${edge.from.replace(/"/g, '\\"')}"`
    const to = `"${edge.to.replace(/"/g, '\\"')}"`
    const label = edge.label?.replace(/"/g, '\\"')
    lines.push(label === undefined ? `  ${from} -> ${to};` : `  ${from} -> ${to} [label="${label}"];`)
  }
  lines.push("}")
  return lines.join("\n")
}

const sanitizeMermaidId = (name: string): string => name.replace(/[^a-zA-Z0-9_]/g, "_")

const addRenameSafetyError = (
  errors: RefactorError[],
  sourceFile: SourceFile,
  file: string,
  packagePath: string,
  line: number,
): void => {
  if (errors.some((error) => error.file === file && error.line === line)) return
  if (sourceFile.isDeclarationFile) errors.push({ file, line, message: "Cannot rename: declaration file (.d.ts)" })
  else if (!isProjectSourceFile(sourceFile.fileName, packagePath)) errors.push({ file, line, message: "Cannot rename: file is outside package boundary" })
}

const getLineText = (sourceFile: SourceFile, line: number): string => {
  const starts = sourceFile.getLineStarts()
  const start = starts[line] ?? 0
  const end = starts[line + 1] ?? sourceFile.text.length
  return sourceFile.text.slice(start, end).replace(/\r$/, "")
}

const replaceSiteOnTrimmedLine = (lineText: string, trimmed: string, character: number, token: string, replacement: string): string => {
  const trimOffset = lineText.length - lineText.trimStart().length
  const relativeCharacter = character - trimOffset
  if (relativeCharacter >= 0 && relativeCharacter + token.length <= trimmed.length && trimmed.slice(relativeCharacter, relativeCharacter + token.length) === token) {
    return `${trimmed.slice(0, relativeCharacter)}${replacement}${trimmed.slice(relativeCharacter + token.length)}`
  }
  return trimmed.replace(new RegExp(`\\b${escapeRegex(token)}\\b`, "g"), replacement)
}

const collectStringLiteralLocations = (sourceFile: SourceFile, root: string, symbolName: string, results: StringLiteralRef[]): void => {
  const regex = new RegExp(`\\b${escapeRegex(symbolName)}\\b`)
  visit(sourceFile, (node) => {
    if (node.kind !== SyntaxKind.StringLiteral) return
    const content = node.getText(sourceFile).slice(1, -1)
    if (!regex.test(content)) return
    const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
    results.push({ file: relativePath(root, sourceFile.fileName), line: position.line + 1, content: content.length > 50 ? `${content.slice(0, 50)}...` : content })
  })
}

const collectCommentLocations = (sourceFile: SourceFile, root: string, symbolName: string, results: StringLiteralRef[]): void => {
  const regex = new RegExp(`\\b${escapeRegex(symbolName)}\\b`)
  const lines = sourceFile.text.split(/\n/)
  const file = relativePath(root, sourceFile.fileName)
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!.replace(/\r$/, "")
    const singleLine = line.match(/\/\/(.*)$/)
    if (singleLine !== null && regex.test(singleLine[1]!)) {
      results.push({ file, line: index + 1, content: truncateComment(singleLine[1]!.trim()) })
      continue
    }
    if ((line.includes("/*") || line.includes("*")) && regex.test(line)) {
      const trimmed = line.trim()
      if (trimmed.startsWith("*") || trimmed.startsWith("/*") || trimmed.startsWith("//")) results.push({ file, line: index + 1, content: truncateComment(trimmed) })
    }
  }
}

const truncateComment = (content: string): string => content.length > 50 ? `${content.slice(0, 50)}...` : content
const escapeRegex = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
