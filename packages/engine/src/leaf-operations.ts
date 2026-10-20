import { isAbsolute, relative, resolve } from "node:path"
import type {
  CompatibilityResult,
  DiagnosticInfo,
  DiagnosticOptions,
  ErrorExplanationIssue,
  ExplainedDiagnosticsResult,
  ExpandedType,
  EvaluatedTypeResult,
  FileDeclarationInfo,
  FileInspectionResult,
  ListSymbolsOptions,
  PackageInfo,
  SearchTypesOptions,
  SymbolInfo,
  SymbolListResult,
  TypeAnalyzer,
  TypeAtPositionResult,
  TypeEvaluationResult,
  TypeExplanationResult,
  TypeInfo,
  TypePropertyInfo,
} from "./contracts"
import { FAN_OUT, mapBounded } from "./concurrency"
import { diskIndexFor } from "./disk-index"
import { AnalyzerContext } from "./context"
import {
  DiagnosticCategory,
  ModifierFlags,
  NodeBuilderFlags,
  SignatureKind,
  SymbolFlags,
  type Diagnostic,
  type Project,
  type Symbol,
  type Type,
} from "tsrs/unstable/async"
import { SyntaxKind, type Node, type SourceFile } from "tsrs/unstable/ast"
import {
  isClassDeclaration,
  isEnumDeclaration,
  isExportDeclaration,
  isExportSpecifier,
  isFunctionDeclaration,
  isIdentifier,
  isInterfaceDeclaration,
  isTypeAliasDeclaration,
  isTypeReferenceNode,
  isVariableDeclaration,
  isVariableStatement,
} from "tsrs/unstable/ast/is"
import {
  createVirtualFileRegistry,
  resolveVirtualFileDirectory,
  synthesizePackageImports,
  withVirtualFile,
  type VirtualFileRegistry,
} from "./virtual-files"
import { symbolDeclarationFor } from "./position-symbol"
import { displaySymbolName } from "./symbol-names"

const TYPE_FLAGS =
  NodeBuilderFlags.NoTruncation |
  NodeBuilderFlags.UseStructuralFallback |
  NodeBuilderFlags.WriteTypeArgumentsOfSignature |
  NodeBuilderFlags.InTypeAlias |
  NodeBuilderFlags.UseAliasDefinedOutsideCurrentScope
const EXPAND_FLAGS = TYPE_FLAGS | NodeBuilderFlags.WriteArrayAsGenericType
const MAX_PROPERTIES = 50
const MAX_NODE_TEXT = 100

interface SymbolMatch {
  readonly node: Node
  readonly symbol: Symbol
  readonly exportedName?: string
}

interface DeclarationMetadata {
  readonly node: Node
  readonly name: string
  readonly exported: boolean
  readonly isDefaultExport: boolean
  readonly exportedAs?: string
}

const kindToString = (kind: SyntaxKind): string => {
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
      return (SyntaxKind[kind] ?? "unknown").replace(/Declaration$/, "").replace(/Statement$/, "").toLowerCase()
  }
}

const packageSourceNames = async (project: Project, packageInfo: PackageInfo): Promise<string[]> => {
  const root = resolve(packageInfo.path)
  // Only files under the package root are kept, so skip fetching the rest (default libs, other packages).
  return (await project.program.getSourceFileNames()).filter((name) => {
    const file = resolve(name)
    return file === root || file.startsWith(`${root}/`)
  })
}

const loadPackageSources = async (
  project: Project,
  packageInfo: PackageInfo,
  names: readonly string[],
): Promise<readonly SourceFile[]> => {
  const root = resolve(packageInfo.path)
  const files = await mapBounded(names, FAN_OUT, async (name) => {
    const source = await project.program.getSourceFile(name)
    if (source === undefined || await project.program.isSourceFileFromExternalLibrary(source)) return undefined
    const file = resolve(source.fileName)
    return file === root || file.startsWith(`${root}/`) ? source : undefined
  })
  return files.filter((source): source is SourceFile => source !== undefined)
}

const sourceFilesFor = (
  context: AnalyzerContext,
  project: Project,
  packageInfo: PackageInfo,
  revision: number,
): Promise<readonly SourceFile[]> =>
  context.cacheForRevision(`source-files:${packageInfo.tsconfigPath}`, revision, async () =>
    loadPackageSources(project, packageInfo, await packageSourceNames(project, packageInfo)),
  )

/** Names of the package modules that are not external library files; no trees are fetched. */
const moduleNamesAmong = async (project: Project, names: readonly string[]): Promise<string[]> => {
  const external = await mapBounded(names, FAN_OUT, async (name) => (await project.program.getSourceFileMetadata(name))?.isFromExternalLibrary === true)
  return names.filter((_, index) => !external[index])
}

const moduleNamesFor = (
  context: AnalyzerContext,
  project: Project,
  packageInfo: PackageInfo,
  revision: number,
): Promise<readonly string[]> =>
  context.cacheForRevision(`module-names:${packageInfo.tsconfigPath}`, revision, async () =>
    moduleNamesAmong(project, await packageSourceNames(project, packageInfo)),
  )

/**
 * The package modules that can export `name`: files whose disk text provably matches the snapshot
 * are kept only if they spell the name or contain `export *`; every other file is kept. Same order
 * as moduleNamesFor, and every module that could contribute an export called `name`, or declared
 * with it, is in the list.
 */
const moduleNamesMentioning = (
  context: AnalyzerContext,
  project: Project,
  packageInfo: PackageInfo,
  revision: number,
  name: string,
): Promise<readonly string[]> =>
  context.cacheForRevision(`module-names-mentioning:${packageInfo.tsconfigPath}:${name}`, revision, async () => {
    const names = await packageSourceNames(project, packageInfo)
    const index = await diskIndexFor(project, names)
    return moduleNamesAmong(project, index === null ? names : index.candidates(name, names, { starExports: true }))
  })

/**
 * Resolve a caller-supplied path to a source file of the package program. Symbols
 * re-exported from a dependency package report that package's files, so an exact
 * path that lies outside the package directory still resolves when the program
 * contains it as workspace source.
 */
const findSourceFile = async (
  context: AnalyzerContext,
  project: Project,
  packageFiles: readonly SourceFile[],
  file: string,
): Promise<SourceFile | undefined> => {
  const target = isAbsolute(file) ? resolve(file) : resolve(context.root, file)
  const inPackage = packageFiles.find((candidate) => resolve(candidate.fileName) === target || candidate.fileName.endsWith(file))
  if (inPackage !== undefined) return inPackage
  const base = resolve(context.root)
  // isSourceFileFromExternalLibrary is true for workspace dependencies resolved through
  // node_modules symlinks, so judge by path: workspace source, not installed code.
  if (!target.startsWith(`${base}/`) || target.includes("/node_modules/")) return undefined
  return project.program.getSourceFile(target)
}

const relativePath = (root: string, file: string): string => {
  const absolute = resolve(file)
  const base = resolve(root)
  return absolute === base || absolute.startsWith(`${base}/`) ? relative(base, absolute) : absolute
}

const declarationName = (node: Node): string | undefined => {
  if (isClassDeclaration(node) || isEnumDeclaration(node) || isFunctionDeclaration(node) || isInterfaceDeclaration(node) || isTypeAliasDeclaration(node)) {
    return node.name?.text
  }
  if (isVariableDeclaration(node) && isIdentifier(node.name)) return node.name.text
  return undefined
}

const declarationSymbol = async (project: Project, node: Node): Promise<Symbol | undefined> => {
  if (isClassDeclaration(node) || isEnumDeclaration(node) || isFunctionDeclaration(node) || isInterfaceDeclaration(node) || isTypeAliasDeclaration(node)) {
    return node.name === undefined ? undefined : project.checker.getSymbolAtLocation(node.name)
  }
  if (isVariableDeclaration(node) && isIdentifier(node.name)) return project.checker.getSymbolAtLocation(node.name)
  return undefined
}

const declarationsIn = (source: SourceFile): readonly Node[] => {
  const declarations: Node[] = []
  for (const statement of source.statements) {
    if (isClassDeclaration(statement) || isEnumDeclaration(statement) || isFunctionDeclaration(statement) || isInterfaceDeclaration(statement) || isTypeAliasDeclaration(statement)) {
      declarations.push(statement)
    } else if (isVariableStatement(statement)) {
      declarations.push(...statement.declarationList.declarations)
    }
  }
  return declarations
}

const isExported = (node: Node): boolean => {
  const modifiers = (node as Node & { readonly modifierFlags?: ModifierFlags }).modifierFlags
  return modifiers !== undefined && (modifiers & ModifierFlags.Export) !== 0
}

const isDefault = (node: Node): boolean => {
  const modifiers = (node as Node & { readonly modifierFlags?: ModifierFlags }).modifierFlags
  return modifiers !== undefined && (modifiers & ModifierFlags.Default) !== 0
}

const exportMatchesFor = async (
  project: Project,
  moduleSymbol: Symbol | undefined,
): Promise<readonly SymbolMatch[]> => {
  if (moduleSymbol === undefined) return []
  const exported = await project.checker.getExportsOfModule(moduleSymbol)
  const matches: SymbolMatch[] = []
  for (const exportedSymbol of exported) {
    const resolvedSymbol = (exportedSymbol.flags & SymbolFlags.Alias) !== SymbolFlags.None
      ? await project.checker.getAliasedSymbol(exportedSymbol)
      : exportedSymbol
    for (const handle of resolvedSymbol.declarations) {
      const node = await handle.resolve(project)
      if (node === undefined) continue
      const name = declarationName(node)
      if (name !== undefined) {
        matches.push({ node, symbol: (await declarationSymbol(project, node)) ?? resolvedSymbol, exportedName: exportedSymbol.name })
        break
      }
      if (isExportSpecifier(node)) {
        const target = await project.checker.getAliasedSymbol(exportedSymbol)
        for (const targetHandle of target.declarations) {
          const targetNode = await targetHandle.resolve(project)
          if (targetNode === undefined) continue
          const targetName = declarationName(targetNode)
          if (targetName !== undefined) {
            matches.push({ node: targetNode, symbol: (await declarationSymbol(project, targetNode)) ?? target, exportedName: exportedSymbol.name })
            break
          }
        }
        break
      }
    }
  }
  return matches
}

const exportedMatches = async (project: Project, moduleNames: readonly string[]): Promise<readonly SymbolMatch[]> => {
  const moduleSymbols = await project.checker.getSymbolOfSourceFile(moduleNames)
  const all = await Promise.all(
    moduleSymbols.map((moduleSymbol) => exportMatchesFor(project, moduleSymbol)),
  )
  // A declaration re-exported by another module (a barrel or index) comes back
  // once per exporting module. Keep one match per declaration and exported name.
  const seen = new Set<string>()
  return all.flat().filter((match) => {
    const key = `${match.node.getSourceFile().fileName}:${match.node.pos}:${match.exportedName ?? ""}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

const exportedMatchesFor = (
  context: AnalyzerContext,
  project: Project,
  packageInfo: PackageInfo,
  revision: number,
): Promise<readonly SymbolMatch[]> =>
  context.cacheForRevision(`exported-matches:${packageInfo.tsconfigPath}`, revision, async () =>
    exportedMatches(project, await moduleNamesFor(context, project, packageInfo, revision)),
  )

const parseFileReference = (value: string): { readonly file: string; readonly symbol: string } | null => {
  if (!value.startsWith("@file:")) return null
  const rest = value.slice(6)
  const index = rest.lastIndexOf(":")
  return index < 0 ? { file: rest, symbol: "*" } : { file: rest.slice(0, index), symbol: rest.slice(index + 1) }
}

const findMatch = async (
  project: Project,
  sourceFiles: readonly SourceFile[],
  root: string,
  symbolName: string,
  matches: readonly SymbolMatch[],
): Promise<SymbolMatch | null> => {
  const reference = parseFileReference(symbolName)
  if (reference !== null) {
    const source = sourceFiles.find((candidate) => resolve(candidate.fileName) === resolve(root, reference.file) || candidate.fileName.endsWith(reference.file))
    if (source === undefined || reference.symbol === "*") return null
    const [rootName, ...members] = reference.symbol.split(".")
    const local = declarationsIn(source).find((node) => declarationName(node) === rootName)
    if (local === undefined) return null
    const symbol = await declarationSymbol(project, local)
    if (symbol === undefined) return null
    let current: SymbolMatch = { node: local, symbol }
    for (const member of members) {
      const type = await typeForNode(current.node, current.symbol, project)
      const property = await project.checker.getPropertyOfType(type, member)
      if (property === undefined) return null
      const node = await property.declarations[0]?.resolve(project)
      if (node === undefined) return null
      current = { node, symbol: property }
    }
    return current
  }
  const parts = symbolName.split(".")
  const rootName = parts[0]!
  const match = matches.find((candidate) => (candidate.exportedName === rootName || declarationName(candidate.node) === rootName))
  if (match === undefined) return null
  let current = match
  for (const member of parts.slice(1)) {
    const type = await typeForNode(current.node, current.symbol, project)
    const property = await project.checker.getPropertyOfType(type, member)
    if (property === undefined) return null
    const node = await property.declarations[0]?.resolve(project)
    if (node === undefined) return null
    current = { node, symbol: property }
  }
  return current
}

const typeForNode = async (node: Node, symbol: Symbol, project: Project): Promise<Type> => {
  if (isClassDeclaration(node) || isEnumDeclaration(node) || isInterfaceDeclaration(node) || isTypeAliasDeclaration(node)) {
    return project.checker.getDeclaredTypeOfSymbol(symbol)
  }
  return project.checker.getTypeOfSymbol(symbol)
}

const hasOptional = (symbol: Symbol): boolean => (symbol.flags & SymbolFlags.Optional) !== SymbolFlags.None

const propertiesFor = async (
  type: Type,
  project: Project,
  location: Node,
  root: string,
  includeFrom: boolean,
  flags = TYPE_FLAGS,
): Promise<readonly TypePropertyInfo[]> => {
  const properties = await project.checker.getPropertiesOfType(type)
  if (properties.length === 0 || properties.length > MAX_PROPERTIES) return []

  const declarations = await Promise.all(
    properties.map(async (property) => {
      const handle = property.declarations[0]
      return handle === undefined ? undefined : await handle.resolve(project)
    }),
  )

  const packageRoot = resolve(root)
  const included: { readonly property: Symbol; readonly declaration: Node | undefined }[] = []
  for (let index = 0; index < properties.length; index += 1) {
    const property = properties[index]!
    const declaration = declarations[index]
    if (
      includeFrom &&
      declaration !== undefined &&
      resolve(declaration.getSourceFile().fileName).includes(`${packageRoot}/node_modules/`)
    ) {
      continue
    }
    included.push({ property, declaration })
  }
  if (included.length === 0) return []

  // Symbols returned from an instantiated type carry its type mapper. Resolving
  // the declaration node instead would report the generic parameter (for
  // example `T`) rather than the use-site property type (for example `string`).
  const propertyTypes = await project.checker.getTypeOfSymbol(included.map((item) => item.property))
  const typeByProperty = new Map<Symbol, Type>()
  for (let index = 0; index < included.length; index += 1) {
    typeByProperty.set(included[index]!.property, propertyTypes[index]!)
  }

  return Promise.all(
    included.map(async ({ property, declaration }): Promise<TypePropertyInfo> => {
      const propertyType = typeByProperty.get(property)!
      const result: TypePropertyInfo = {
        name: displaySymbolName(property.name),
        type: await project.checker.typeToString(propertyType, declaration ?? location, flags),
        ...(hasOptional(property) ? { optional: true } : {}),
      }
      if (includeFrom && declaration !== undefined) {
        return { ...result, from: relativePath(root, declaration.getSourceFile().fileName) }
      }
      return result
    }),
  )
}

const makeTypeInfo = async (match: SymbolMatch, project: Project, packageInfo: PackageInfo, root: string): Promise<TypeInfo> => {
  const type = await typeForNode(match.node, match.symbol, project)
  const kind = declarationName(match.node) === undefined
    ? SyntaxKind[match.node.kind] ?? "unknown"
    : kindToString(match.node.kind)
  const info: TypeInfo = {
    name: match.symbol.name,
    kind,
    type: await project.checker.typeToString(type, match.node, TYPE_FLAGS),
    location: { file: relativePath(root, match.node.getSourceFile().fileName), line: match.node.getSourceFile().getLineAndCharacterOfPosition(match.node.getStart()).line + 1 },
    package: packageInfo.name,
  }
  const withSignature = isClassDeclaration(match.node)
    ? { ...info, signature: `class ${match.symbol.name}` }
    : isInterfaceDeclaration(match.node)
      ? { ...info, signature: `interface ${match.symbol.name}` }
      : isTypeAliasDeclaration(match.node)
        ? { ...info, signature: `type ${match.symbol.name}` }
        : info
  let result: TypeInfo = withSignature
  if (isFunctionDeclaration(match.node)) {
    const signatures = await project.checker.getSignaturesOfType(type, SignatureKind.Call)
    const texts = await Promise.all(signatures.map(async (signature) => signature.declaration === undefined ? undefined : (await signature.declaration.resolve(project))?.getText()))
    const signature = texts.filter((text): text is string => text !== undefined).join("\n")
    if (signature.length > 0) result = { ...result, signature }
  }
  const properties = await propertiesFor(type, project, match.node, root, true)
  return properties.length > 0 ? { ...result, properties } : result
}

const metadataFor = async (project: Project, source: SourceFile): Promise<readonly DeclarationMetadata[]> => {
  const moduleSymbol = await project.checker.getSymbolOfSourceFile(source.fileName)
  const matches = await exportMatchesFor(project, moduleSymbol)
  const direct = declarationsIn(source).flatMap((node): DeclarationMetadata[] => {
    const name = declarationName(node)
    if (name === undefined) return []
    return [{ node, name, exported: isExported(source.statements.find((statement) => statement.pos <= node.pos && statement.end >= node.end) ?? node), isDefaultExport: isDefault(node) }]
  })
  const aliases = matches.flatMap((match): DeclarationMetadata[] => {
    const name = declarationName(match.node)
    if (name === undefined) return []
    return [{ node: match.node, name, exported: true, isDefaultExport: match.exportedName === "default", ...(match.exportedName !== name && match.exportedName !== "default" ? { exportedAs: match.exportedName } : {}) }]
  })
  const byNode = new Map<number, DeclarationMetadata>()
  for (const item of [...direct, ...aliases]) byNode.set(item.node.pos, item)
  return [...byNode.values()]
}

const diagnosticCategory = (category: DiagnosticCategory): string | undefined => DiagnosticCategory[category]
const sourceLocation = (source: SourceFile | undefined, position: number): { readonly line: number; readonly column: number } | undefined => {
  if (source === undefined || position < 0) return undefined
  const point = source.getLineAndCharacterOfPosition(Math.min(position, source.text.length))
  return { line: point.line + 1, column: point.character + 1 }
}

const mapDiagnostic = async (diagnostic: Diagnostic, project: Project, root: string): Promise<DiagnosticInfo> => {
  const source = diagnostic.fileName === undefined ? undefined : await project.program.getSourceFile(diagnostic.fileName)
  const location = sourceLocation(source, diagnostic.pos)
  const category = diagnosticCategory(diagnostic.category)
  return {
    message: diagnostic.text,
    code: diagnostic.code,
    ...(category === undefined ? {} : { category }),
    ...(diagnostic.fileName === undefined ? {} : { file: relativePath(root, diagnostic.fileName) }),
    ...(location === undefined ? {} : { line: location.line, column: location.column }),
    }
}

const findNodeAt = (node: Node, position: number): Node => {
  let best = node
  node.forEachChild((child) => {
    if (child.pos <= position && position <= child.end) best = findNodeAt(child, position)
  })
  return best
}

const semanticTypeNode = (node: Node): Node => {
  let current = node.parent
  while (current !== undefined && current.kind !== SyntaxKind.SourceFile) {
    if (isTypeReferenceNode(current)) {
      return node.pos >= current.typeName.pos && node.end <= current.typeName.end ? current : node
    }
    current = current.parent
  }
  return node
}

const evaluateTypeExpression = async (
  expression: string,
  context: AnalyzerContext,
  packageName: string | undefined,
  registry: VirtualFileRegistry,
): Promise<TypeEvaluationResult> => {
  const normalized = expression.trim()
  if (normalized.length === 0) return { error: `Could not evaluate type expression: ${expression}` }
  const pkg = context.package(packageName)
  return withVirtualFile(registry, "", async (lease) => {
    const imports = await context.withProject(
      (project) => synthesizePackageImports(project, pkg.path, lease.path),
      packageName,
    )
    const content = `${imports.content}type __QuartzEval = ${normalized}\nconst __QuartzEvalValue: ${normalized} = undefined as unknown as ${normalized}\nvoid __QuartzEvalValue\n`
    return context.workspace.withVirtualFile(pkg.tsconfigPath, lease.path, content, async (project, filePath) => {
      const source = await project.program.getSourceFile(filePath)
      const declaration = source?.statements
        .filter(isVariableStatement)
        .flatMap((statement) => statement.declarationList.declarations)
        .find((candidate) => isIdentifier(candidate.name) && candidate.name.text === "__QuartzEvalValue")
      if (source === undefined || declaration === undefined) {
        return { error: `Could not evaluate type expression: ${expression}` }
      }
      const diagnostics = (await project.program.getSemanticDiagnostics(filePath)).filter(
        (diagnostic) => diagnostic.category === DiagnosticCategory.Error,
      )
      if (diagnostics[0] !== undefined) return { error: diagnostics[0].text }
      const type = await project.checker.getTypeAtLocation(declaration)
      const [result, expanded] = await Promise.all([
        project.checker.typeToString(type, declaration, TYPE_FLAGS),
        project.checker.typeToString(type, declaration, EXPAND_FLAGS),
      ])
      return {
        result,
        // Reuse when expansion flags do not change the rendering.
        expanded: expanded === result ? result : expanded,
      }
    })
  })
}

export interface LeafOperations {
  readonly getPackages: () => Promise<readonly PackageInfo[]>
  readonly listSymbols: (options?: ListSymbolsOptions) => Promise<SymbolListResult>
  readonly getTypeInfo: (symbolName: string, packageName?: string) => Promise<TypeInfo | null>
  readonly expandType: (symbolName: string, packageName?: string) => Promise<ExpandedType | null>
  readonly searchTypes: (options: SearchTypesOptions) => Promise<readonly TypeInfo[]>
  readonly evalType: (expression: string, packageName?: string) => Promise<TypeEvaluationResult>
  readonly getFileDeclarations: (file: string, options?: { readonly symbol?: string; readonly includePrivate?: boolean; readonly packageName?: string }) => Promise<FileInspectionResult | null>
  readonly checkCompatibility: (from: string, to: string, packageName?: string) => Promise<{ readonly compatible: boolean; readonly from: string; readonly to: string; readonly reason?: string; readonly issues?: readonly ErrorExplanationIssue[] }>
  readonly getDiagnostics: TypeAnalyzer["getDiagnostics"]
  readonly getTypeAtPosition: (filePath: string, line: number, column: number, packageName?: string) => Promise<TypeAtPositionResult | null>
  readonly explainType: (expression: string, packageName?: string) => Promise<TypeExplanationResult>
}

/** The export called `symbolName`, from the modules that can provide it instead of every module of the package. */
const matchFor = async (
  context: AnalyzerContext,
  project: Project,
  pkg: PackageInfo,
  revision: number,
  symbolName: string,
): Promise<SymbolMatch | null> => {
  const reference = parseFileReference(symbolName)
  if (reference !== null) {
    // A file reference never reads the export index: it needs only the file it names.
    const target = resolve(context.root, reference.file)
    let sourceFiles: readonly SourceFile[] = []
    for (const name of await packageSourceNames(project, pkg)) {
      if (resolve(name) !== target && !name.endsWith(reference.file)) continue
      sourceFiles = await loadPackageSources(project, pkg, [name])
      if (sourceFiles.length > 0) break
    }
    return findMatch(project, sourceFiles, context.root, symbolName, [])
  }
  const rootName = symbolName.split(".")[0]!
  const moduleNames = await moduleNamesMentioning(context, project, pkg, revision, rootName)
  const matches = await context.cacheForRevision(
    `exported-matches-mentioning:${pkg.tsconfigPath}:${rootName}`,
    revision,
    () => exportedMatches(project, moduleNames),
  )
  return findMatch(project, [], context.root, symbolName, matches)
}

export const createLeafOperations = (context: AnalyzerContext): LeafOperations => {
  const virtualFiles = createVirtualFileRegistry(resolveVirtualFileDirectory(context.root), "__quartz_type_eval_")
  const getPackages = async (): Promise<readonly PackageInfo[]> => context.packages
  const listSymbols = (options: ListSymbolsOptions = {}): Promise<SymbolListResult> => context.withProject(async (project, pkg, revision) => {
    const matches = await exportedMatchesFor(context, project, pkg, revision)
    const namePattern = options.pattern === undefined ? undefined : new RegExp(options.pattern, "i")
    const filePattern = options.file === undefined ? undefined : new RegExp(options.file, "i")
    const all: SymbolInfo[] = []
    for (const match of matches) {
      const name = match.exportedName === "default" ? (declarationName(match.node) ?? "default") : match.exportedName ?? declarationName(match.node)
      if (name === undefined) continue
      const file = relativePath(context.root, match.node.getSourceFile().fileName)
      const isIndexExport = /(?:^|\/)index(?:\.[cm]?[jt]sx?)?$/.test(file)
      if (options.indexOnly === true && !isIndexExport) continue
      if (filePattern !== undefined && !filePattern.test(file)) continue
      const kind = kindToString(match.node.kind)
      if (options.kind !== undefined && options.kind !== "all" && options.kind !== kind) continue
      if (namePattern !== undefined && !namePattern.test(name)) continue
      all.push({ name, kind, file, line: match.node.getSourceFile().getLineAndCharacterOfPosition(match.node.getStart()).line + 1, package: pkg.name, isIndexExport })
    }
    all.sort((left, right) => (left.isIndexExport === right.isIndexExport ? left.name.localeCompare(right.name) : left.isIndexExport ? -1 : 1))
    const limit = options.limit ?? 100
    return { symbols: all.slice(0, limit), total: all.length, truncated: all.length > limit, package: pkg.name }
  }, options.packageName)

  const getTypeInfo = (symbolName: string, packageName?: string): Promise<TypeInfo | null> => context.withProject(async (project, pkg, revision) => {
    const match = await matchFor(context, project, pkg, revision, symbolName)
    return match === null ? null : makeTypeInfo(match, project, pkg, context.root)
  }, packageName)

  const expandType = (symbolName: string, packageName?: string): Promise<ExpandedType | null> => context.withProject(async (project, pkg, revision) => {
    const match = await matchFor(context, project, pkg, revision, symbolName)
    if (match === null) return null
    const type = await typeForNode(match.node, match.symbol, project)
    // original/expanded previously issued identical EXPAND_FLAGS typeToString calls — share one render.
    const [rendered, properties] = await Promise.all([
      project.checker.typeToString(type, match.node, EXPAND_FLAGS),
      propertiesFor(type, project, match.node, context.root, true, EXPAND_FLAGS),
    ])
    return { original: rendered, expanded: rendered, properties }
  }, packageName)

  const searchTypes = (options: SearchTypesOptions): Promise<readonly TypeInfo[]> => context.withProject(async (project, pkg, revision) => {
    const matches = await exportedMatchesFor(context, project, pkg, revision)
    const pattern = options.pattern ?? options.query
    const regex = pattern === undefined ? undefined : new RegExp(pattern, "i")
    const results: TypeInfo[] = []
    for (const match of matches) {
      const name = match.exportedName === "default" ? declarationName(match.node) ?? "default" : match.exportedName ?? declarationName(match.node)
      if (name === undefined || (regex !== undefined && !regex.test(name))) continue
      const type = await typeForNode(match.node, match.symbol, project)
      if (options.hasProperty !== undefined && await project.checker.getPropertyOfType(type, options.hasProperty) === undefined) continue
      if (options.extends !== undefined) {
        const bases = await type.getBaseTypes()
        if (bases === undefined || !(await Promise.all(bases.map(async (base) => (await (await base.getSymbol())?.name) === options.extends))).some(Boolean)) continue
      }
      results.push(await makeTypeInfo(match, project, pkg, context.root))
      if (results.length >= (options.limit ?? 25)) break
    }
    return results
  }, options.packageName)

  const evalType = (expression: string, packageName?: string): Promise<TypeEvaluationResult> =>
    evaluateTypeExpression(expression, context, packageName, virtualFiles)

  const getFileDeclarations = (file: string, options: { readonly symbol?: string; readonly includePrivate?: boolean; readonly packageName?: string } = {}): Promise<FileInspectionResult | null> => context.withProject(async (project, pkg, revision) => {
    const sourceFiles = await sourceFilesFor(context, project, pkg, revision)
    const source = await findSourceFile(context, project, sourceFiles, file)
    if (source === undefined) return null
    const filter = options.symbol === undefined ? undefined : new RegExp(options.symbol, "i")
    const metadata = await metadataFor(project, source)
    const declarations: FileDeclarationInfo[] = []
    for (const item of metadata) {
      if (filter !== undefined && !filter.test(item.name)) continue
      if (!item.exported && options.includePrivate !== true) continue
      let info: FileDeclarationInfo = { name: item.name, kind: kindToString(item.node.kind), line: source.getLineAndCharacterOfPosition(item.node.getStart()).line + 1, exported: item.exported, isDefaultExport: item.isDefaultExport, ...(item.exportedAs === undefined ? {} : { exportedAs: item.exportedAs }) }
      const symbol = await declarationSymbol(project, item.node)
      if (symbol !== undefined) {
        const type = await typeForNode(item.node, symbol, project)
        if (info.kind !== "class" && info.kind !== "interface" && info.kind !== "enum") info = { ...info, type: await project.checker.typeToString(type, item.node, TYPE_FLAGS) }
        if (info.kind === "function") {
          const signatures = await project.checker.getSignaturesOfType(type, SignatureKind.Call)
          const parts = await Promise.all(signatures.map(async (signature) => {
            const params = await signature.getParameters()
            const rendered = await Promise.all(params.map(async (parameter) => `${parameter.name}: ${await project.checker.typeToString(await project.checker.getTypeOfSymbolAtLocation(parameter, item.node), item.node, TYPE_FLAGS)}`))
            return `(${rendered.join(", ")}) => ${await project.checker.typeToString(await project.checker.getReturnTypeOfSignature(signature), item.node, TYPE_FLAGS)}`
          }))
          if (parts.length > 0) info = { ...info, signature: parts.join(" | ") }
        }
      }
      declarations.push(info)
    }
    declarations.sort((left, right) => (left.exported === right.exported ? left.name.localeCompare(right.name) : left.exported ? -1 : 1))
    return { file: relativePath(context.root, source.fileName), package: pkg.name, declarations, total: declarations.length }
  }, options.packageName)

  const checkCompatibility = (from: string, to: string, packageName?: string): Promise<CompatibilityResult> => context.withProject(async (project, pkg, revision) => {
    const [fromMatch, toMatch] = await Promise.all([
      matchFor(context, project, pkg, revision, from),
      matchFor(context, project, pkg, revision, to),
    ])
    if (fromMatch === null || toMatch === null) {
      const missing = fromMatch === null ? from : to
      const message = `Symbol "${missing}" not found`
      return { compatible: false, from, to, reason: message, issues: [{ kind: "other", message }] }
    }
    const fromType = await typeForNode(fromMatch.node, fromMatch.symbol, project)
    const toType = await typeForNode(toMatch.node, toMatch.symbol, project)
    const [fromText, toText] = await Promise.all([
      project.checker.typeToString(fromType, fromMatch.node),
      project.checker.typeToString(toType, toMatch.node),
    ])
    if (await project.checker.isTypeAssignableTo(fromType, toType)) return { compatible: true, from: fromText, to: toText }
    const issues: ErrorExplanationIssue[] = []
    const reasons: string[] = []
    const [fromProperties, targetProperties] = await Promise.all([
      project.checker.getPropertiesOfType(fromType),
      project.checker.getPropertiesOfType(toType),
    ])
    const fromNames = new Set(fromProperties.map((property) => property.name))
    const missingRequired = targetProperties.filter((property) => !hasOptional(property) && !fromNames.has(property.name))
    if (missingRequired.length > 0) {
      const missingTypes = await project.checker.getTypeOfSymbol(missingRequired)
      const expectedTexts = await Promise.all(
        missingTypes.map((missingType) => project.checker.typeToString(missingType, toMatch.node)),
      )
      for (let index = 0; index < missingRequired.length; index += 1) {
        const property = missingRequired[index]!
        const expected = expectedTexts[index]!
        const message = `Property '${displaySymbolName(property.name)}' is missing in type '${fromText}' but required in type '${toText}' (expected: ${expected})`
        reasons.push(message)
        issues.push({ kind: "missing_property", property: displaySymbolName(property.name), expectedType: expected, message })
      }
    }
    for (const property of fromProperties) {
      const target = await project.checker.getPropertyOfType(toType, property.name)
      if (target === undefined) continue
      const [actualType, expectedType] = await Promise.all([
        project.checker.getTypeOfSymbolAtLocation(property, fromMatch.node),
        project.checker.getTypeOfSymbolAtLocation(target, toMatch.node),
      ])
      if (await project.checker.isTypeAssignableTo(actualType, expectedType)) continue
      const [actual, expected] = await Promise.all([
        project.checker.typeToString(actualType, fromMatch.node),
        project.checker.typeToString(expectedType, toMatch.node),
      ])
      const message = `Property '${displaySymbolName(property.name)}' has incompatible types: '${actual}' is not assignable to '${expected}'`
      reasons.push(message)
      issues.push({ kind: "type_mismatch", property: displaySymbolName(property.name), actualType: actual, expectedType: expected, message })
    }
    if (reasons.length === 0) {
      const message = `Type '${fromText}' is not assignable to type '${toText}'`
      reasons.push(message)
      issues.push({ kind: "other", message })
    }
    return { compatible: false, from: fromText, to: toText, reason: reasons.join("; "), issues }
  }, packageName)

  const getDiagnostics = (packageNameOrOptions?: string | DiagnosticOptions): Promise<readonly DiagnosticInfo[] | ExplainedDiagnosticsResult> => context.withProject(async (project, pkg) => {
    const options = typeof packageNameOrOptions === "object" ? packageNameOrOptions : undefined
    const diagnostics = (await Promise.all([project.program.getConfigFileParsingDiagnostics(), project.program.getSyntacticDiagnostics(), project.program.getSemanticDiagnostics()])).flat()
    const packageRoot = resolve(pkg.path)
    const unique = new Map<string, Diagnostic>()
    for (const diagnostic of diagnostics) {
      if (diagnostic.fileName !== undefined && !(resolve(diagnostic.fileName) === packageRoot || resolve(diagnostic.fileName).startsWith(`${packageRoot}/`))) continue
      unique.set([diagnostic.fileName ?? "", diagnostic.pos, diagnostic.code, diagnostic.text].join("\u0000"), diagnostic)
    }
    const errors = await Promise.all([...unique.values()].map((diagnostic) => mapDiagnostic(diagnostic, project, context.root)))
    if (options?.explain !== true) return errors
    const explained = errors.map((error) => ({ ...error, explanation: null }))
    return { totalErrors: explained.length, explained: 0, truncated: false, errors: explained }
  }, typeof packageNameOrOptions === "string" ? packageNameOrOptions : packageNameOrOptions?.packageName)

  const getTypeAtPosition = (filePath: string, line: number, column: number, packageName?: string): Promise<TypeAtPositionResult | null> => context.withProject(async (project, pkg, revision) => {
    const sourceFiles = await sourceFilesFor(context, project, pkg, revision)
    const source = await findSourceFile(context, project, sourceFiles, filePath)
    if (source === undefined || line < 1 || column < 1) return null
    let position: number
    try { position = source.getPositionOfLineAndCharacter(line - 1, column - 1) } catch { return null }
    if (position > source.text.length) return null
    const node = semanticTypeNode(findNodeAt(source, position))
    const type = await project.checker.getTypeAtLocation(node)
    const point = source.getLineAndCharacterOfPosition(node.getStart())
    // Default flags vs EXPAND_FLAGS are different renders — issue both in one round-trip window.
    // When the expanded form equals the default form, share the string reference.
    const [typeText, expandedText] = await Promise.all([
      project.checker.typeToString(type, node),
      project.checker.typeToString(type, node, EXPAND_FLAGS),
    ])
    const { symbol, declaration } = await symbolDeclarationFor(
      project,
      node,
      type,
      (fileName) => relativePath(context.root, fileName),
    )
    const text = node.getText(source)
    const nodeText = text.length > MAX_NODE_TEXT ? `${text.slice(0, MAX_NODE_TEXT)}...` : text
    return {
      type: typeText,
      expanded: expandedText === typeText ? typeText : expandedText,
      nodeKind: SyntaxKind[node.kind] ?? "unknown",
      nodeText,
      location: {
        file: relativePath(context.root, source.fileName),
        line: point.line + 1,
        column: point.character + 1,
      },
      symbol,
      declaration,
    }
  }, packageName)

  const explainType = async (expression: string, packageName?: string): Promise<TypeExplanationResult> => {
    const result = await evaluateTypeExpression(expression, context, packageName, virtualFiles)
    const final = "error" in result ? `Error: ${result.error}` : result.expanded
    return { expression, steps: [{ step: 1, description: `Expand ${expression}`, expression, result: final }], final }
  }

  return { getPackages, listSymbols, getTypeInfo, expandType, searchTypes, evalType, getFileDeclarations, checkCompatibility, getDiagnostics, getTypeAtPosition, explainType }
}
