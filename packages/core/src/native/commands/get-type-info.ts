import { Effect } from "effect"
import type { TypeAnalyzer } from "../../analyzer"
import type { TypeInfo } from "../../project-types"
import { discoverPackages } from "../../discovery"
import type { NativeCommandContext } from "../context"
import { QuartzError } from "../../errors"
import { NodeBuilderFlags, SignatureKind, SymbolFlags, type Symbol, type Type } from "typescript/unstable/sync"
import { SyntaxKind, type Node } from "typescript/unstable/ast"
import {
  findNativeSymbol,
  getWorkspaceSourceFiles,
  kindToString,
  relativePath,
  resolvePackage,
} from "../symbol-resolution"

const TYPE_FLAGS =
  NodeBuilderFlags.NoTruncation |
  NodeBuilderFlags.UseStructuralFallback |
  NodeBuilderFlags.WriteTypeArgumentsOfSignature |
  NodeBuilderFlags.InTypeAlias |
  NodeBuilderFlags.UseAliasDefinedOutsideCurrentScope

const MAX_DECLARED_PROPERTIES = 50

/**
 * Native `getTypeInfo`, backed by the native checker and AST handles.
 */
export const getTypeInfo =
  (ctx: NativeCommandContext): TypeAnalyzer["getTypeInfo"] =>
  (symbolName, packageName) =>
    Effect.gen(function* () {
      const packages = yield* discoverPackages(ctx.rootDirectory)
      const packageInfo = resolvePackage(packages, packageName)
      const project = ctx.engine.getProject(packageInfo.tsconfigPath)
      const sourceFiles = getWorkspaceSourceFiles(project.program, packageInfo)
      const found = findNativeSymbol(symbolName, project, packageInfo, ctx.rootDirectory, sourceFiles)
      if (found === null) return null
      return yield* Effect.try({
        try: () => makeTypeInfo(found.node, found.symbol, packageInfo.name, ctx.rootDirectory, project),
        catch: (cause) => new QuartzError({ message: "Could not get type info", cause }),
      })
    })

const makeTypeInfo = (
  node: Node,
  symbol: Symbol,
  packageName: string,
  rootDirectory: string,
  project: ReturnType<NativeCommandContext["engine"]["getProject"]>,
): TypeInfo => {
  const checker = project.checker
  const type = typeForNode(node, symbol, checker)
  const sourceFile = node.getSourceFile()
  const info: TypeInfo = {
    name: symbol.name,
    kind: kindToString(node.kind),
    type: checker.typeToString(type, node, TYPE_FLAGS),
    location: {
      file: relativePath(rootDirectory, sourceFile.fileName),
      line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
    },
    package: packageName,
  }

  if (node.kind === SyntaxKind.ClassDeclaration) info.signature = `class ${symbol.name}`
  else if (node.kind === SyntaxKind.InterfaceDeclaration) info.signature = `interface ${symbol.name}`
  else if (node.kind === SyntaxKind.TypeAliasDeclaration) info.signature = `type ${symbol.name}`
  else if (node.kind === SyntaxKind.FunctionDeclaration) {
    const signatures = checker.getSignaturesOfType(type, SignatureKind.Call)
    if (signatures.length > 0) {
      info.signature = signatures
        .map((signature) => signature.declaration?.resolve(project)?.getText())
        .filter((signature): signature is string => signature !== undefined)
        .join("\n")
    }
  }

  const properties = displayProperties(type, node, rootDirectory, project)
  if (properties.length > 0) info.properties = properties.map(({ name, type: propertyType, optional }) => ({ name, type: propertyType, optional }))

  return info
}

export const typeForNode = (node: Node, symbol: Symbol, checker: ReturnType<NativeCommandContext["engine"]["getProject"]>["checker"]): Type => {
  switch (node.kind) {
    case SyntaxKind.TypeAliasDeclaration:
      return checker.getTypeAtLocation(node)
    case SyntaxKind.ClassDeclaration:
    case SyntaxKind.InterfaceDeclaration:
    case SyntaxKind.EnumDeclaration:
      return checker.getDeclaredTypeOfSymbol(symbol)
    default:
      return checker.getTypeOfSymbol(symbol)
  }
}

const displayProperties = (
  type: Type,
  node: Node,
  rootDirectory: string,
  project: ReturnType<NativeCommandContext["engine"]["getProject"]>,
): ReadonlyArray<{ name: string; type: string; optional: boolean }> => {
  const checker = project.checker
  const properties = checker.getPropertiesOfType(type)
  if (properties.length === 0 || properties.length > MAX_DECLARED_PROPERTIES) return []
  return properties
    .filter((property) => property.declarations.some((declaration) => declaration.resolve(project)?.getSourceFile().fileName.startsWith(resolveRoot(rootDirectory))))
    .map((property) => {
      const declaration = property.declarations[0]?.resolve(project)
      const propertyType = declaration === undefined
        ? checker.getTypeOfSymbol(property)
        : checker.getTypeAtLocation(declaration)
      return {
        name: property.name,
        type: checker.typeToString(propertyType, declaration ?? node, TYPE_FLAGS),
        optional: (property.flags & SymbolFlags.Optional) !== SymbolFlags.None,
      }
    })
}

const resolveRoot = (rootDirectory: string): string => {
  const normalized = rootDirectory.replaceAll("\\", "/").replace(/\/$/, "")
  return normalized.startsWith("/") ? normalized : `${process.cwd()}/${normalized}`
}
