import { existsSync } from "node:fs"
import { isAbsolute, join, relative, resolve } from "node:path"
import {
  Node,
  Project,
  SyntaxKind,
  TypeFormatFlags,
  type Diagnostic,
  type SourceFile,
} from "ts-morph"
import { Effect } from "effect"
import { discoverPackages, type PackageInfo } from "./discovery"
import { TypeLevelToolsError } from "./errors"
import {
  ProjectManager,
  type CompatibilityResult,
  type FileInspectionResult,
  type GraphResult,
  type RefactorPreviewResult,
  type RelatedInfo,
  type SnippetCheckResult,
  type TypeExplanationResult,
  type ErrorExplanationResult,
} from "./legacy-project"
import { TransformSearchEngine, formatResults, type TransformSearchOptions } from "./transform-search"

export interface SymbolInfo {
  readonly name: string
  readonly kind: string
  readonly file: string
  readonly line?: number
  readonly package?: string
  readonly isIndexExport?: boolean
}

export interface SymbolListResult {
  readonly symbols: readonly SymbolInfo[]
  readonly total: number
  readonly truncated: boolean
  readonly package?: string
}

export interface ListSymbolsOptions {
  readonly pattern?: string
  readonly kind?: string
  readonly packageName?: string
  readonly file?: string
  readonly limit?: number
  readonly indexOnly?: boolean
}

export interface TypePropertyInfo {
  readonly name: string
  readonly type: string
  readonly optional?: boolean
  readonly from?: string
}

export interface TypeInfo {
  readonly name: string
  readonly kind: string
  readonly type: string
  readonly signature?: string
  readonly properties?: readonly TypePropertyInfo[]
  readonly location: {
    readonly file: string
    readonly line: number
  }
  readonly package?: string
}

export interface ExpandedType {
  readonly original: string
  readonly expanded: string
  readonly properties: readonly TypePropertyInfo[]
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] }

export interface TypeAtPositionResult {
  readonly type: string
  readonly expanded: string
  readonly nodeKind: string
  readonly nodeText: string
  readonly location: {
    readonly file: string
    readonly line: number
    readonly column: number
  }
}

export interface DiagnosticInfo {
  readonly message: string
  readonly code: number
  readonly category: string
  readonly file?: string
  readonly line?: number
  readonly column?: number
}

export interface SearchTypesOptions {
  readonly query?: string
  readonly pattern?: string
  readonly hasProperty?: string
  readonly extends?: string
  readonly packageName?: string
  readonly limit?: number
}

export interface DiagnosticOptions {
  readonly packageName?: string
  readonly explain?: boolean
}

export interface ErrorExplanationOptions {
  readonly code?: number
  readonly message?: string
  readonly file?: string
  readonly line?: number
  readonly packageName?: string
}

export interface RefactorPreviewOptions {
  readonly action: "rename"
  readonly symbol: string
  readonly to: string
  readonly packageName?: string
}

export interface TypeAnalyzer {
  readonly getPackages: () => Effect.Effect<readonly PackageInfo[], TypeLevelToolsError>
  readonly listSymbols: (options?: ListSymbolsOptions) => Effect.Effect<SymbolListResult, TypeLevelToolsError>
  readonly getTypeInfo: (symbolName: string, packageName?: string) => Effect.Effect<TypeInfo | null, TypeLevelToolsError>
  readonly expandType: (symbolName: string, packageName?: string) => Effect.Effect<ExpandedType | null, TypeLevelToolsError>
  readonly findRelated: (symbolName: string, packageName?: string) => Effect.Effect<RelatedInfo | null, TypeLevelToolsError>
  readonly searchTypes: (options: SearchTypesOptions) => Effect.Effect<readonly TypeInfo[], TypeLevelToolsError>
  readonly evalType: (expression: string, packageName?: string) => Effect.Effect<unknown, TypeLevelToolsError>
  readonly checkSnippet: (code: string, packageName?: string) => Effect.Effect<SnippetCheckResult, TypeLevelToolsError>
  readonly getFileDeclarations: (
    file: string,
    options?: { readonly symbol?: string; readonly includePrivate?: boolean; readonly packageName?: string },
  ) => Effect.Effect<FileInspectionResult | null, TypeLevelToolsError>
  readonly checkCompatibility: (
    from: string,
    to: string,
    packageName?: string,
  ) => Effect.Effect<CompatibilityResult, TypeLevelToolsError>
  readonly generateGraph: (
    symbol: string,
    options?: { readonly depth?: number; readonly format?: "mermaid" | "dot"; readonly packageName?: string },
  ) => Effect.Effect<GraphResult | null, TypeLevelToolsError>
  readonly previewRefactor: (options: RefactorPreviewOptions) => Effect.Effect<RefactorPreviewResult, TypeLevelToolsError>
  readonly getDiagnostics: (
    packageNameOrOptions?: string | DiagnosticOptions,
  ) => Effect.Effect<readonly DiagnosticInfo[] | unknown, TypeLevelToolsError>
  readonly getTypeAtPosition: (
    filePath: string,
    line: number,
    column: number,
    packageName?: string,
  ) => Effect.Effect<TypeAtPositionResult | null, TypeLevelToolsError>
  readonly explainError: (
    options: ErrorExplanationOptions,
  ) => Effect.Effect<ErrorExplanationResult | null, TypeLevelToolsError>
  readonly explainType: (expression: string, packageName?: string) => Effect.Effect<TypeExplanationResult, TypeLevelToolsError>
  readonly transformSearch: (
    options: TransformSearchOptions & { readonly packageName?: string },
  ) => Effect.Effect<string, TypeLevelToolsError>
  readonly refresh: (packageName?: string) => Effect.Effect<string, TypeLevelToolsError>
  readonly markDirty: () => void
}

interface CachedProject {
  readonly project: Project
  readonly packageInfo: PackageInfo
}

export const createTypeAnalyzer = (rootDirectory: string): TypeAnalyzer => {
  const absoluteRootDirectory = resolve(rootDirectory)
  const projectManager = new ProjectManager(absoluteRootDirectory)
  const fromPromise = <A>(try_: () => Promise<A>): Effect.Effect<A, TypeLevelToolsError> =>
    Effect.tryPromise({
      try: try_,
      catch: (cause) =>
        new TypeLevelToolsError({
          message: cause instanceof Error ? cause.message : String(cause),
          cause,
        }),
    })

  let packages: readonly PackageInfo[] | null = null
  const projectCache = new Map<string, CachedProject>()

  const getPackages = (): Effect.Effect<readonly PackageInfo[], TypeLevelToolsError> =>
    Effect.gen(function* () {
      if (packages === null) {
        packages = yield* discoverPackages(absoluteRootDirectory)
      }
      return packages
    })

  const resolvePackage = (packageName?: string): Effect.Effect<PackageInfo, TypeLevelToolsError> =>
    Effect.gen(function* () {
      const discovered = yield* getPackages()
      const resolved =
        packageName === undefined
          ? discovered[0]
          : discovered.find((pkg) => pkg.name === packageName || pkg.path.endsWith(packageName))

      if (resolved === undefined) {
        return yield* Effect.fail(
          new TypeLevelToolsError({
            message: packageName === undefined ? "No TypeScript package found" : `Package not found: ${packageName}`,
          }),
        )
      }

      return resolved
    })

  const getProject = (packageName?: string): Effect.Effect<CachedProject, TypeLevelToolsError> =>
    Effect.gen(function* () {
      const packageInfo = yield* resolvePackage(packageName)
      const cached = projectCache.get(packageInfo.name)
      if (cached !== undefined) return cached

      const project = new Project({
        tsConfigFilePath: packageInfo.tsconfigPath,
        skipAddingFilesFromTsConfig: false,
      })
      const value = { project, packageInfo }
      projectCache.set(packageInfo.name, value)
      return value
    })

  const listSymbols = (options: ListSymbolsOptions = {}): Effect.Effect<SymbolListResult, TypeLevelToolsError> =>
    Effect.gen(function* () {
      const { project, packageInfo } = yield* getProject(options.packageName)
      const pattern = options.pattern === undefined ? undefined : new RegExp(options.pattern, "i")
      const limit = options.limit ?? 100
      const symbols: SymbolInfo[] = []

      for (const sourceFile of project.getSourceFiles()) {
        if (sourceFile.isFromExternalLibrary()) continue
        const file = relative(absoluteRootDirectory, sourceFile.getFilePath())
        if (options.file !== undefined && !file.includes(options.file)) continue

        for (const declaration of getExportedDeclarations(sourceFile)) {
          const name = getDeclarationName(declaration)
          if (name === undefined) continue
          const kind = getDeclarationKind(declaration)
          if (options.kind !== undefined && kind !== options.kind) continue
          if (pattern !== undefined && !pattern.test(name)) continue

          symbols.push({
            name,
            kind,
            file,
            line: declaration.getStartLineNumber(),
            package: packageInfo.name,
          })
        }
      }

      symbols.sort((a, b) => a.name.localeCompare(b.name))
      return {
        symbols: symbols.slice(0, limit),
        total: symbols.length,
        truncated: symbols.length > limit,
        package: packageInfo.name,
      }
    })

  const getTypeInfo = (symbolName: string, packageName?: string): Effect.Effect<TypeInfo | null, TypeLevelToolsError> =>
    Effect.gen(function* () {
      const resolved = yield* findDeclaration(symbolName, packageName)
      if (resolved === null) return null

      const { declaration, sourceFile, packageInfo } = resolved
      const symbol = declaration.getSymbol()
      const type = declaration.getType()
      const signature = getSignatureText(declaration)

      return {
        name: getDeclarationName(declaration) ?? symbolName,
        kind: getDeclarationKind(declaration),
        type: type.getText(declaration, TypeFormatFlags.NoTruncation),
        ...(signature === undefined ? {} : { signature }),
        properties: getProperties(declaration),
        location: {
          file: relative(rootDirectory, sourceFile.getFilePath()),
          line: declaration.getStartLineNumber(),
        },
        package: packageInfo.name,
      }
    })

  const expandType = (symbolName: string, packageName?: string): Effect.Effect<ExpandedType | null, TypeLevelToolsError> =>
    Effect.gen(function* () {
      const info = yield* getTypeInfo(symbolName, packageName)
      if (info === null) return null
      return {
        original: symbolName,
        expanded: info.type,
        properties: info.properties ?? [],
      }
    })

  const searchTypes = (options: SearchTypesOptions): Effect.Effect<readonly TypeInfo[], TypeLevelToolsError> =>
    Effect.gen(function* () {
      const symbolOptions: Mutable<ListSymbolsOptions> = { limit: options.limit ?? 25 }
      if (options.query !== undefined) symbolOptions.pattern = options.query
      if (options.packageName !== undefined) symbolOptions.packageName = options.packageName
      const symbols = yield* listSymbols(symbolOptions)

      return yield* Effect.forEach(symbols.symbols, (symbol) => getTypeInfo(symbol.name, symbol.package), {
        concurrency: 4,
      }).pipe(Effect.map((items) => items.filter((item): item is TypeInfo => item !== null)))
    })

  const getDiagnostics = (packageName?: string): Effect.Effect<readonly DiagnosticInfo[], TypeLevelToolsError> =>
    Effect.gen(function* () {
      const { project } = yield* getProject(packageName)
      return project.getPreEmitDiagnostics().map(formatDiagnostic)
    })

  const getTypeAtPosition = (
    filePath: string,
    line: number,
    column: number,
    packageName?: string,
  ): Effect.Effect<TypeAtPositionResult | null, TypeLevelToolsError> =>
    Effect.gen(function* () {
      const { project } = yield* getProject(packageName)
      const sourceFile = resolveSourceFile(project, filePath)
      if (sourceFile === undefined) return null

      const position = sourceFile.compilerNode.getPositionOfLineAndCharacter(line - 1, column - 1)
      const node = sourceFile.getDescendantAtPos(position) ?? sourceFile
      const type = node.getType()

      return {
        type: type.getText(node, TypeFormatFlags.NoTruncation),
        expanded: type.getText(node, TypeFormatFlags.NoTruncation | TypeFormatFlags.UseFullyQualifiedType),
        nodeKind: SyntaxKind[node.getKind()] ?? "Unknown",
        nodeText: node.getText().slice(0, 300),
        location: {
          file: relative(rootDirectory, sourceFile.getFilePath()),
          line,
          column,
        },
      }
    })

  const findDeclaration = (
    symbolName: string,
    packageName?: string,
  ): Effect.Effect<
    { readonly declaration: Node; readonly sourceFile: SourceFile; readonly packageInfo: PackageInfo } | null,
    TypeLevelToolsError
  > =>
    Effect.gen(function* () {
      const { project, packageInfo } = yield* getProject(packageName)

      for (const sourceFile of project.getSourceFiles()) {
        if (sourceFile.isFromExternalLibrary()) continue
        for (const declaration of getExportedDeclarations(sourceFile)) {
          if (getDeclarationName(declaration) === symbolName) {
            return { declaration, sourceFile, packageInfo }
          }
        }
      }

      return null
    })

  return {
    getPackages: () => fromPromise(() => projectManager.getPackages()),
    listSymbols: (options = {}) => fromPromise(() => projectManager.listSymbols(options)),
    getTypeInfo: (symbolName, packageName) => fromPromise(() => projectManager.getTypeInfo(symbolName, packageName)),
    expandType: (symbolName, packageName) =>
      fromPromise(async () => {
        const expanded = await projectManager.expandType(symbolName, packageName)
        return expanded === null ? null : { ...expanded, properties: expanded.properties ?? [] }
      }),
    findRelated: (symbolName, packageName) => fromPromise(() => projectManager.findRelated(symbolName, packageName)),
    searchTypes,
    evalType: (expression, packageName) => fromPromise(() => projectManager.evalType(expression, packageName)),
    checkSnippet: (code, packageName) => fromPromise(() => projectManager.checkSnippet(code, packageName)),
    getFileDeclarations: (file, options = {}) =>
      fromPromise(() => projectManager.getFileDeclarations(file, options)),
    checkCompatibility: (from, to, packageName) =>
      fromPromise(() => projectManager.checkCompatibility(from, to, packageName)),
    generateGraph: (symbol, options = {}) => fromPromise(() => projectManager.generateGraph(symbol, options)),
    previewRefactor: (options) => fromPromise(() => projectManager.previewRefactor(options)),
    getDiagnostics: (packageNameOrOptions) =>
      fromPromise(() => {
        if (typeof packageNameOrOptions === "object" && packageNameOrOptions?.explain === true) {
          return projectManager.getPackageDiagnostics(packageNameOrOptions.packageName).then(async (diagnostics) => {
            const errors = await Promise.all(
              diagnostics.slice(0, 10).map(async (diagnostic) => ({
                ...diagnostic,
                explanation: await projectManager.explainError({
                  code: diagnostic.code,
                  message: diagnostic.message,
                  ...(packageNameOrOptions.packageName === undefined
                    ? {}
                    : { packageName: packageNameOrOptions.packageName }),
                }),
              })),
            )
            return {
              totalErrors: diagnostics.length,
              explained: errors.length,
              truncated: diagnostics.length > 10,
              errors,
            }
          })
        }
        return projectManager.getPackageDiagnostics(
          typeof packageNameOrOptions === "string" ? packageNameOrOptions : packageNameOrOptions?.packageName,
        )
      }),
    getTypeAtPosition: (filePath, line, column, packageName) =>
      fromPromise(() => projectManager.getTypeAtPosition(filePath, line, column, packageName)),
    explainError: (options) => fromPromise(() => projectManager.explainError(options)),
    explainType: (expression, packageName) => fromPromise(() => projectManager.explainType(expression, packageName)),
    transformSearch: (options) =>
      fromPromise(async () => {
        const pkg = await projectManager.resolvePackagePublic(options.packageName)
        const project = projectManager.getProjectPublic(pkg)
        const sourceFiles = projectManager.getSourceFilesPublic(project, pkg)
        const engine = new TransformSearchEngine(project, pkg.path, sourceFiles)
        const result = await engine.search(options)
        return formatResults(result)
      }),
    refresh: (packageName) =>
      fromPromise(async () => {
        if (packageName !== undefined) {
          await projectManager.refreshPackage(packageName)
          return `Refreshed TypeScript project for "${packageName}". Next type query will use fresh AST.`
        }
        projectManager.refreshAll()
        return "Refreshed all TypeScript projects. Next type queries will use fresh AST."
      }),
    markDirty: () => projectManager.markDirty(),
  }
}

const getExportedDeclarations = (sourceFile: SourceFile): readonly Node[] => {
  const declarations: Node[] = []
  for (const declarationGroup of sourceFile.getExportedDeclarations().values()) {
    declarations.push(...declarationGroup)
  }
  return declarations
}

const getDeclarationName = (declaration: Node): string | undefined => {
  const named = declaration.asKind(SyntaxKind.InterfaceDeclaration)
    ?? declaration.asKind(SyntaxKind.TypeAliasDeclaration)
    ?? declaration.asKind(SyntaxKind.ClassDeclaration)
    ?? declaration.asKind(SyntaxKind.FunctionDeclaration)
    ?? declaration.asKind(SyntaxKind.EnumDeclaration)
    ?? declaration.asKind(SyntaxKind.VariableDeclaration)

  return named?.getName()
}

const getDeclarationKind = (declaration: Node): string => {
  if (Node.isInterfaceDeclaration(declaration)) return "interface"
  if (Node.isTypeAliasDeclaration(declaration)) return "type"
  if (Node.isClassDeclaration(declaration)) return "class"
  if (Node.isFunctionDeclaration(declaration)) return "function"
  if (Node.isEnumDeclaration(declaration)) return "enum"
  if (Node.isVariableDeclaration(declaration)) return "variable"
  return SyntaxKind[declaration.getKind()] ?? "unknown"
}

const getProperties = (declaration: Node): readonly TypePropertyInfo[] =>
  declaration
    .getType()
    .getProperties()
    .map((property) => {
      const propertyDeclaration = property.getValueDeclaration() ?? property.getDeclarations()[0]
      const propertyType =
        propertyDeclaration === undefined
          ? property.getDeclaredType().getText()
          : property.getTypeAtLocation(propertyDeclaration).getText(propertyDeclaration, TypeFormatFlags.NoTruncation)

      return {
        name: property.getName(),
        type: propertyType,
        optional: property.isOptional(),
      }
    })

const getSignatureText = (declaration: Node): string | undefined => {
  const signatures = declaration.getType().getCallSignatures()
  const signature = signatures[0]
  if (signature === undefined) return undefined
  return signature.getDeclaration()?.getText()
}

const resolveSourceFile = (project: Project, filePath: string): SourceFile | undefined => {
  const absolutePath = isAbsolute(filePath) ? filePath : undefined
  if (absolutePath !== undefined && existsSync(absolutePath)) {
    return project.getSourceFile(absolutePath)
  }

  return project.getSourceFiles().find((sourceFile) => {
    const path = sourceFile.getFilePath()
    return path.endsWith(filePath) || path.includes(filePath)
  })
}

const formatDiagnostic = (diagnostic: Diagnostic): DiagnosticInfo => {
  const sourceFile = diagnostic.getSourceFile()
  const start = diagnostic.getStart()
  const lineAndColumn =
    sourceFile !== undefined && start !== undefined ? sourceFile.getLineAndColumnAtPos(start) : undefined

  return {
    message: diagnostic.getMessageText().toString(),
    code: diagnostic.getCode(),
    category: String(diagnostic.getCategory()),
    ...(sourceFile === undefined ? {} : { file: sourceFile.getFilePath() }),
    ...(lineAndColumn === undefined ? {} : { line: lineAndColumn.line, column: lineAndColumn.column }),
  }
}
