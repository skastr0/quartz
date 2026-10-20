import { relative, resolve } from "node:path"
import type { Identifier, Node, SourceFile } from "tsrs/unstable/ast"
import { SyntaxKind } from "tsrs/unstable/ast"
import { isIdentifier, isTypeReferenceNode } from "tsrs/unstable/ast/is"
import { SymbolFlags, type NodeHandle, type Project, type Symbol, type Type } from "tsrs/unstable/async"
import type { AnalyzerContext } from "./context"
import { FAN_OUT, mapBounded } from "./concurrency"
import { predictRenameErrors } from "./rename-verification"
import { displaySymbolName } from "./symbol-names"
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
      const nodeIds = new Set<string>([await symbolIdentity(project, rootTarget.symbol)])
      const edges: GraphEdge[] = []
      const edgeKeys = new Set<string>()
      const visited = new Set<string>()

      const visit = async (target: Target, displayName: string, currentDepth: number): Promise<void> => {
        const targetId = await symbolIdentity(project, target.symbol)
        if (visited.has(targetId) || currentDepth > depth) return
        visited.add(targetId)

        const outgoing = await findOutgoingReferences(project, target)
        if (currentDepth >= depth) return
        for (const reference of outgoing) {
          const child = await targets.lookup(reference.symbol)
          if (child === null) continue
          const childId = await symbolIdentity(project, child.symbol)
          const childName = displaySymbolName(child.symbol.name)
          if (!nodeIds.has(childId)) {
            nodeIds.add(childId)
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

      const safetyNotes: string[] = []
      try {
        const declarationName = declarationNameNode(target.declaration) ?? target.declaration
        predictedErrors.push(...(await predictRenameErrors(context, pkg, project, declarationName, sites, options.symbol, options.to)))
      } catch (cause) {
        safetyNotes.push(`Could not check the rename against the compiler: ${cause instanceof Error ? cause.message : String(cause)}`)
      }

      const stringLiteralLocations: StringLiteralRef[] = []
      const commentLocations: StringLiteralRef[] = []
      for (const fileName of affectedFiles) {
        const sourceFile = await project.program.getSourceFile(fileName)
        if (sourceFile === undefined) continue
        collectStringLiteralLocations(sourceFile, context.root, options.symbol, stringLiteralLocations)
        collectCommentLocations(sourceFile, context.root, options.symbol, commentLocations)
      }

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
 * Revision-keyed name → Target index. A name is resolved to its Target on first lookup, from the
 * declaration name nodes spelled that way, so a cold lookup costs a few round trips instead of
 * one symbol query per file; results are memoized for recursive graph expansion.
 */
const targetIndexFor = (
  context: AnalyzerContext,
  project: Project,
  pkg: PackageInfo,
  revision: number,
): TargetIndex =>
  context.cacheForRevision(`target-index:${pkg.tsconfigPath}`, revision, () => {
    const memo = new Map<string, Promise<Target | null>>()
    return {
      lookup: (requestedName: string): Promise<Target | null> => {
        const cached = memo.get(requestedName)
        if (cached !== undefined) return cached
        const pending = (async (): Promise<Target | null> => {
          const fromIndex = await resolveDeclaredName(
            project,
            pkg.path,
            context.root,
            await collectNameOccurrences(project, pkg.path, requestedName),
          )
          if (fromIndex !== undefined) return fromIndex
          if (requestedName === "default") {
            const sourceFiles = await projectSourceFiles(project, pkg.path)
            const defaultTarget = await findDefaultExportTarget(project, sourceFiles, pkg.path, context.root)
            if (defaultTarget !== undefined) return defaultTarget
          }
          // Preserve full-scan semantics for names that only appear as usages / default.
          return findTargetByScan(project, pkg.path, context.root, requestedName)
        })()
        memo.set(requestedName, pending)
        return pending
      },
    }
  })

type NameOccurrence = {
  readonly sourceFile: SourceFile
  readonly nameNode: Node
}

const declaredNamesByFile = new WeakMap<SourceFile, Map<string, Node[]>>()

/** Declaration names (and export specifier names) of one file by spelling; each tree is walked once. */
const declaredNamesOf = (sourceFile: SourceFile): Map<string, Node[]> => {
  const cached = declaredNamesByFile.get(sourceFile)
  if (cached !== undefined) return cached
  const byName = new Map<string, Node[]>()
  visit(sourceFile, (node) => {
    let nameNode: Node | undefined
    if (node.kind === SyntaxKind.Identifier && declarationForName(node) !== undefined) {
      nameNode = node
    } else if (node.kind === SyntaxKind.ExportSpecifier) {
      const exportName = (node as ExportSpecifierNode).name
      if (exportName.kind === SyntaxKind.Identifier) nameNode = exportName
    }
    if (nameNode === undefined) return
    const key = nameNode.getText(sourceFile)
    const list = byName.get(key)
    if (list === undefined) byName.set(key, [nameNode])
    else list.push(nameNode)
  })
  declaredNamesByFile.set(sourceFile, byName)
  return byName
}

/** Declaration names (and export specifier names) spelled `name`, in file then node order. */
const collectNameOccurrences = async (
  project: Project,
  packagePath: string,
  name: string,
): Promise<NameOccurrence[]> => {
  const occurrences: NameOccurrence[] = []
  for (const sourceFile of await projectSourceFiles(project, packagePath)) {
    // The source text is already on the client: skip walking trees that cannot contain the name.
    if (!sourceFile.text.includes(name)) continue
    for (const nameNode of declaredNamesOf(sourceFile).get(name) ?? []) occurrences.push({ sourceFile, nameNode })
  }
  return occurrences
}

/** First occurrence of a declared name that resolves to a declaration wins. */
const resolveDeclaredName = async (
  project: Project,
  packagePath: string,
  rootPath: string,
  occurrences: readonly NameOccurrence[],
): Promise<Target | undefined> => {
  for (const { sourceFile, nameNode } of occurrences) {
    const symbol = await project.checker.getSymbolAtLocation(nameNode)
    if (symbol === undefined) continue
    const resolved = await resolveSymbol(project, symbol)
    const declaration =
      declarationForName(nameNode)
      ?? (await findDeclarationForSymbol(sourceFile, project, resolved))
    if (declaration !== undefined) return { symbol: resolved, declaration, packagePath, rootPath }
    const first = resolved.declarations[0]
    const fallback = first === undefined ? undefined : await first.resolve(project)
    if (fallback !== undefined) return { symbol: resolved, declaration: fallback, packagePath, rootPath }
  }
  return undefined
}

/** The first file (in project order) whose module has a default export. */
const findDefaultExportTarget = async (
  project: Project,
  sourceFiles: readonly SourceFile[],
  packagePath: string,
  rootPath: string,
): Promise<Target | undefined> => {
  const moduleSymbols = await project.checker.getSymbolOfSourceFile(sourceFiles.map((sourceFile) => sourceFile.fileName))
  const defaults = await mapBounded(sourceFiles, FAN_OUT, async (_sourceFile, index) => {
    const moduleSymbol = moduleSymbols[index]
    if (moduleSymbol === undefined) return undefined
    const exports = await project.checker.getExportsOfModule(moduleSymbol)
    return exports.find((candidate) => candidate.name === "default")
  })
  for (let index = 0; index < sourceFiles.length; index += 1) {
    const defaultExport = defaults[index]
    if (defaultExport === undefined) continue
    const resolved = await resolveSymbol(project, defaultExport)
    const declaration = await findDeclarationForSymbol(sourceFiles[index]!, project, resolved)
    if (declaration !== undefined) return { symbol: resolved, declaration, packagePath, rootPath }
    const first = resolved.declarations[0]
    const node = first === undefined ? undefined : await first.resolve(project)
    if (node !== undefined) return { symbol: resolved, declaration: node, packagePath, rootPath }
  }
  return undefined
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
    if (!sourceFile.text.includes(requestedName)) continue
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

  if (requestedName === "default") return (await findDefaultExportTarget(project, sourceFiles, packagePath, rootPath)) ?? null

  return null
}

const findDeclarationForSymbol = async (sourceFile: SourceFile, project: Project, target: Symbol): Promise<Node | undefined> => {
  for (const handle of target.declarations) {
    const declaration = await handle.resolve(project)
    if (declaration !== undefined && declaration.getSourceFile().fileName === sourceFile.fileName) return declaration
  }
  return undefined
}


type IncomingReference = {
  readonly sourceFile: SourceFile
  readonly start: number
  readonly containing: string
  readonly context: string
  readonly line: number
}

const findIncomingReferences = async (project: Project, target: Target): Promise<RelatedInfo["referencedBy"]> => {
  const results: Array<RelatedInfo["referencedBy"][number]> = []
  const seen = new Set<string>()
  const perFileCounts = new Map<string, number>()
  // Per node, independent of the others: safe to run concurrently so the checker queries batch.
  const describe = async (node: Node, symbol: Symbol = target.symbol): Promise<IncomingReference | null> => {
    if (node.kind !== SyntaxKind.Identifier || isImportReference(node)) return null
    const sourceFile = node.getSourceFile()
    if (!isProjectSourceFile(sourceFile.fileName, target.packagePath)) return null
    if (!(await matchesCanonicalSymbol(project, symbol, target.symbol))) return null
    if (isTargetDeclarationName(node, target)) return null
    const containing = await findContainingSymbol(project, node.parent, target.symbol)
    const start = node.getStart(sourceFile)
    const position = sourceFile.getLineAndCharacterOfPosition(start)
    return { sourceFile, start, containing, context: classifyReferenceContext(node.parent), line: position.line + 1 }
  }
  // Order-dependent bookkeeping (per-file cap, de-duplication) stays sequential.
  const accept = (reference: IncomingReference | null): void => {
    if (reference === null) return
    const fileName = reference.sourceFile.fileName
    const fileCount = perFileCounts.get(fileName) ?? 0
    if (fileCount >= MAX_REFERENCE_RESULTS_PER_FILE) return
    const key = `${fileName}:${reference.start}:${reference.containing}:${reference.context}`
    if (seen.has(key)) return
    seen.add(key)
    perFileCounts.set(fileName, fileCount + 1)
    results.push({
      symbol: reference.containing,
      context: reference.context,
      file: relativePath(target.rootPath, fileName),
      line: reference.line,
    })
  }
  const add = async (node: Node, symbol: Symbol = target.symbol): Promise<void> => accept(await describe(node, symbol))

  // Prefer compiler-native reference collection: scales with references, not
  // every identifier / type-reference node in the project.
  const declarationName = declarationNameNode(target.declaration) ?? target.declaration
  const declarationPosition = declarationName.getStart(declarationName.getSourceFile())
  try {
    const referenced = await project.languageService.getReferencedSymbolsForNode(declarationName, declarationPosition)
    const entries = referenced.flatMap((entry) =>
      [entry.definition, ...entry.references].map((handle) => ({ handle, symbol: entry.symbol ?? target.symbol })),
    )
    const described = await mapBounded(entries, FAN_OUT, async ({ handle, symbol }) => {
      const node = await resolveIdentifierHandle(project, handle)
      return node === undefined ? null : describe(node, symbol)
    })
    for (const reference of described) accept(reference)
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
  const describe = async (
    symbol: Symbol | undefined,
    context: string,
  ): Promise<{ readonly resolved: Symbol; readonly identity: string; readonly context: string } | null> => {
    if (symbol === undefined) return null
    const resolved = await resolveSymbol(project, symbol)
    if (resolved.id === target.symbol.id || PRIMITIVE_NAMES[resolved.name] === true) return null
    return { resolved, identity: await symbolIdentity(project, resolved), context }
  }
  const accept = (described: Awaited<ReturnType<typeof describe>>): void => {
    if (described === null) return
    const key = `${described.identity}:${described.context}`
    if (seen.has(key)) return
    seen.add(key)
    references.push({ symbol: displaySymbolName(described.resolved.name), context: described.context })
  }
  const symbolOf = async (type: Type): Promise<Symbol | undefined> =>
    (await type.getSymbol()) ?? (await type.getAliasSymbol())

  const type = await project.checker.getTypeAtLocation(target.declaration)
  if (await skipOutgoingType(type)) return references
  const properties = await project.checker.getPropertiesOfType(type)
  const described = await mapBounded(properties.slice(0, 50), FAN_OUT, async (property) => {
    const declarationHandle = property.declarations[0]
    if (declarationHandle === undefined) return null
    const declaration = await declarationHandle.resolve(project)
    if (declaration === undefined) return null
    const propertyType = await project.checker.getTypeOfSymbolAtLocation(property, declaration)
    return describe(await symbolOf(propertyType), `property "${displaySymbolName(property.name)}"`)
  })
  for (const entry of described) accept(entry)
  if (type.isClassOrInterface()) {
    const baseTypes = await project.checker.getBaseTypes(type)
    const bases = await mapBounded(baseTypes, FAN_OUT, async (baseType) => describe(await symbolOf(baseType), "extends"))
    for (const entry of bases) accept(entry)
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
    const referenced = await project.languageService.getReferencedSymbolsForNode(declarationName, position)
    for (const entry of referenced) {
      const handles = [entry.definition, ...entry.references]
      for (const handle of handles) {
        const node = await resolveIdentifierHandle(project, handle)
        if (node === undefined) continue
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
  const moduleSymbol = await project.checker.getSymbolOfSourceFile(sourceFile.fileName)
  return moduleSymbol?.name ?? "anonymous"
}

const resolvedSymbols = new WeakMap<Project, Map<number, Promise<Symbol>>>()

const resolveSymbol = (project: Project, symbol: Symbol): Promise<Symbol> => {
  let byId = resolvedSymbols.get(project)
  if (byId === undefined) {
    byId = new Map()
    resolvedSymbols.set(project, byId)
  }
  const cached = byId.get(symbol.id)
  if (cached !== undefined) return cached
  const resolving = (async (): Promise<Symbol> => {
    let resolved = symbol
    // getAliasedSymbol rejects non-alias symbols, and tsrs prints the panic to stderr.
    if ((symbol.flags & SymbolFlags.Alias) !== SymbolFlags.None) {
      try {
        resolved = await project.checker.getAliasedSymbol(symbol)
      } catch {
        // An unresolvable alias stays as written.
      }
    }
    return project.checker.getTargetSymbol(resolved)
  })()
  byId.set(symbol.id, resolving)
  return resolving
}

const matchesCanonicalSymbol = async (project: Project, candidate: Symbol, target: Symbol): Promise<boolean> =>
  (await resolveSymbol(project, candidate)).id === target.id

const symbolIdentity = async (project: Project, symbol: Symbol): Promise<string> =>
  project.checker.getFullyQualifiedName(await resolveSymbol(project, symbol))

const resolveIdentifierHandle = async (
  project: Project,
  handle: NodeHandle,
): Promise<Identifier | undefined> => {
  if (handle.kind !== SyntaxKind.Identifier) return undefined
  const node = await (handle as NodeHandle<Identifier>).resolve(project)
  return node !== undefined && isIdentifier(node) ? node : undefined
}

const sourceFilesByProject = new WeakMap<Project, Map<string, Promise<SourceFile[]>>>()

const projectSourceFiles = (project: Project, packagePath: string): Promise<SourceFile[]> => {
  let byPackage = sourceFilesByProject.get(project)
  if (byPackage === undefined) {
    byPackage = new Map()
    sourceFilesByProject.set(project, byPackage)
  }
  const cached = byPackage.get(packagePath)
  if (cached !== undefined) return cached
  const loading = (async (): Promise<SourceFile[]> => {
    const names = (await project.program.getSourceFileNames()).filter((name) => isProjectSourceFile(name, packagePath))
    const loaded = await mapBounded(names, FAN_OUT, (name) => project.program.getSourceFile(name))
    return loaded.filter((sourceFile): sourceFile is SourceFile => sourceFile !== undefined)
  })()
  byPackage.set(packagePath, loading)
  loading.catch(() => {
    if (byPackage.get(packagePath) === loading) byPackage.delete(packagePath)
  })
  return loading
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
  let ancestor: Node | undefined = parent
  while (ancestor !== undefined && ancestor.kind !== SyntaxKind.SourceFile) {
    if (ancestor.kind === SyntaxKind.HeritageClause) return "extends"
    ancestor = ancestor.parent
  }
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
