import { Effect } from "effect"
import type { TypeAnalyzer } from "../../analyzer"
import type { FileDeclarationInfo, FileExportMetadata } from "../../project-types"
import { discoverPackages } from "../../discovery"
import { QuartzError } from "../../errors"
import { NodeBuilderFlags, SignatureKind, type Project, type Type } from "typescript/unstable/sync"
import { SyntaxKind, type Node, type SourceFile } from "typescript/unstable/ast"
import {
  isClassDeclaration,
  isEnumDeclaration,
  isFunctionDeclaration,
  isIdentifier,
  isInterfaceDeclaration,
  isTypeAliasDeclaration,
  isVariableStatement,
} from "typescript/unstable/ast/is"
import type { NativeCommandContext } from "../context"
import { getNativeExportDeclarations, getNativeDeclarationName } from "../export-resolution"
import { getWorkspaceSourceFiles, kindToString, relativePath, resolvePackage, resolveSourceFile } from "../symbol-resolution"
import { typeForNode } from "./get-type-info"

const TYPE_FLAGS = NodeBuilderFlags.NoTruncation | NodeBuilderFlags.InTypeAlias

/**
 * Native `getFileDeclarations` — not yet implemented. Its owning builder replaces this
 * body; the delegator in `native/index.ts` stays frozen. Until then it returns
 * the engine-not-supported error so callers get a clean, actionable failure.
 */
export const getFileDeclarations =
  (ctx: NativeCommandContext): TypeAnalyzer["getFileDeclarations"] =>
  (filePath, options = {}) =>
    Effect.gen(function* () {
      const packages = yield* discoverPackages(ctx.rootDirectory)
      return yield* Effect.try({
        try: () => {
          const packageInfo = resolvePackage(packages, options.packageName)
          const project = ctx.engine.getProject(packageInfo.tsconfigPath)
          const sourceFiles = getWorkspaceSourceFiles(project.program, packageInfo)
          const sourceFile = resolveSourceFile(filePath, ctx.rootDirectory, sourceFiles)
          if (sourceFile === null) return null
          const filter = options.symbol === undefined ? null : new RegExp(options.symbol, "i")
          const metadata = getExportMetadata(sourceFile, project)
          const declarations = collectDeclarations(sourceFile).flatMap((node) => {
            const name = getNativeDeclarationName(node)
            if (name === undefined || (filter !== null && !filter.test(name))) return []
            const exported = metadata.exportedNames.has(name)
            if (!exported && options.includePrivate !== true) return []
            return [makeDeclaration(node, name, exported, metadata, project)]
          })
          declarations.sort((left, right) => {
            if (left.exported && !right.exported) return -1
            if (!left.exported && right.exported) return 1
            if (left.isDefaultExport && !right.isDefaultExport) return -1
            if (!left.isDefaultExport && right.isDefaultExport) return 1
            return left.name.localeCompare(right.name)
          })
          return {
            file: relativePath(ctx.rootDirectory, sourceFile.fileName),
            package: packageInfo.name,
            declarations,
            total: declarations.length,
          }
        },
        catch: (cause) => new QuartzError({ message: "Could not inspect file declarations", cause }),
      })
    })

const getExportMetadata = (sourceFile: SourceFile, project: Project): FileExportMetadata => {
  const metadata: FileExportMetadata = {
    exportedNames: new Set(),
    defaultExportNames: new Set(),
    exportAliases: new Map(),
  }
  for (const declaration of getNativeExportDeclarations(sourceFile, project)) {
    const name = declaration.declarationName
    if (name === undefined) continue
    metadata.exportedNames.add(name)
    if (declaration.exportName === "default") metadata.defaultExportNames.add(name)
    else if (declaration.exportName !== name) metadata.exportAliases.set(name, declaration.exportName)
  }
  return metadata
}

const collectDeclarations = (sourceFile: SourceFile): readonly Node[] => {
  const declarations: Node[] = []
  for (const statement of sourceFile.statements) {
    if (
      isClassDeclaration(statement) ||
      isInterfaceDeclaration(statement) ||
      isTypeAliasDeclaration(statement) ||
      isFunctionDeclaration(statement) ||
      isEnumDeclaration(statement)
    ) declarations.push(statement)
    else if (isVariableStatement(statement)) declarations.push(...statement.declarationList.declarations)
  }
  return declarations
}

const makeDeclaration = (
  node: Node,
  name: string,
  exported: boolean,
  metadata: FileExportMetadata,
  project: Project,
): FileDeclarationInfo => {
  const kind = kindToString(node.kind)
  const exportedAs = metadata.exportAliases.get(name)
  const info: FileDeclarationInfo = {
    name,
    kind,
    line: node.getSourceFile().getLineAndCharacterOfPosition(node.getStart()).line + 1,
    exported,
    isDefaultExport: metadata.defaultExportNames.has(name),
    ...(exportedAs === undefined ? {} : { exportedAs }),
  }
  const symbol = declarationSymbol(node, project)
  if (symbol === undefined) return info
  const type = typeForNode(node, symbol, project.checker)
  if (kind !== "class" && kind !== "interface" && kind !== "enum") {
    info.type = project.checker.typeToString(type, node, TYPE_FLAGS)
  }
  const signature = declarationSignature(node, name, kind, type, project)
  if (signature !== undefined) info.signature = signature
  return info
}

const declarationSymbol = (node: Node, project: Project) => {
  if (
    isClassDeclaration(node) ||
    isInterfaceDeclaration(node) ||
    isTypeAliasDeclaration(node) ||
    isFunctionDeclaration(node) ||
    isEnumDeclaration(node)
  ) return node.name === undefined ? undefined : project.checker.getSymbolAtLocation(node.name)
  if (node.kind === SyntaxKind.VariableDeclaration) {
    const name = (node as import("typescript/unstable/ast").VariableDeclaration).name
    return isIdentifier(name) ? project.checker.getSymbolAtLocation(name) : undefined
  }
  return undefined
}

const declarationSignature = (node: Node, name: string, kind: string, type: Type, project: Project): string | undefined => {
  if (kind === "function") {
    const signatures = project.checker.getSignaturesOfType(type, SignatureKind.Call)
    if (signatures.length === 0) return undefined
    return signatures.map((signature) => {
      const parameters = signature.getParameters().map((parameter) => {
        const parameterType = project.checker.getTypeOfSymbolAtLocation(parameter, node)
        return `${parameter.name}: ${project.checker.typeToString(parameterType, node, TYPE_FLAGS)}`
      }).join(", ")
      return `(${parameters}) => ${project.checker.typeToString(project.checker.getReturnTypeOfSignature(signature), node, TYPE_FLAGS)}`
    }).join(" | ")
  }
  if (kind !== "class") return undefined
  const properties = project.checker.getPropertiesOfType(type).slice(0, 20)
  const methods = properties.filter((property) => property.declarations.some((handle) => handle.resolve(project)?.kind === SyntaxKind.MethodDeclaration))
  const suffix = methods.length < properties.length ? ", ..." : ""
  return `class ${name} { ${methods.map((method) => `${method.name}()`).join(", ")}${suffix} }`
}
