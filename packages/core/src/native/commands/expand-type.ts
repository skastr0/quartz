import { Effect } from "effect"
import type { TypeAnalyzer } from "../../analyzer"
import type { ExpandedType } from "../../analyzer"
import { discoverPackages } from "../../discovery"
import type { NativeCommandContext } from "../context"
import { QuartzError } from "../../errors"
import { NodeBuilderFlags, type Type, type Symbol } from "typescript/unstable/sync"
import type { Node } from "typescript/unstable/ast"
import {
  findNativeSymbol,
  getWorkspaceSourceFiles,
  relativePath,
  resolvePackage,
} from "../symbol-resolution"
import { typeForNode } from "./get-type-info"

const EXPAND_FLAGS =
  NodeBuilderFlags.NoTruncation |
  NodeBuilderFlags.WriteArrayAsGenericType |
  NodeBuilderFlags.UseStructuralFallback |
  NodeBuilderFlags.WriteTypeArgumentsOfSignature |
  NodeBuilderFlags.InTypeAlias |
  NodeBuilderFlags.UseAliasDefinedOutsideCurrentScope

const MAX_DECLARED_PROPERTIES = 50

/**
 * Native `expandType`, backed by the native checker and AST handles.
 */
export const expandType =
  (ctx: NativeCommandContext): TypeAnalyzer["expandType"] =>
  (symbolName, packageName) =>
    Effect.gen(function* () {
      const packages = yield* discoverPackages(ctx.rootDirectory)
      const packageInfo = resolvePackage(packages, packageName)
      const project = ctx.engine.getProject(packageInfo.tsconfigPath)
      const sourceFiles = getWorkspaceSourceFiles(project.program, packageInfo)
      const found = findNativeSymbol(symbolName, project, packageInfo, ctx.rootDirectory, sourceFiles)
      if (found === null) return null
      return yield* Effect.try({
        try: () => makeExpandedType(found.node, found.symbol, ctx.rootDirectory, project),
        catch: (cause) => new QuartzError({ message: "Could not expand type", cause }),
      })
    })

const makeExpandedType = (
  node: Node,
  symbol: Symbol,
  rootDirectory: string,
  project: ReturnType<NativeCommandContext["engine"]["getProject"]>,
): ExpandedType => {
  const checker = project.checker
  const type = typeForNode(node, symbol, checker)
  const properties = checker.getPropertiesOfType(type)
  return {
    original: checker.typeToString(type, node, EXPAND_FLAGS),
    expanded: checker.typeToString(type, node, EXPAND_FLAGS),
    properties:
      properties.length === 0 || properties.length > MAX_DECLARED_PROPERTIES
        ? []
        : properties
            .filter((property) => property.declarations.some((declaration) => {
              const sourceFile = declaration.resolve(project)?.getSourceFile()
              return sourceFile !== undefined && !sourceFile.fileName.includes("/node_modules/")
            }))
            .map((property) => {
              const declaration = property.declarations[0]?.resolve(project)
              const propertyType = declaration === undefined
                ? checker.getTypeOfSymbol(property)
                : checker.getTypeAtLocation(declaration)
              const from = declaration === undefined || declaration.getSourceFile().fileName.includes("/node_modules/")
                ? undefined
                : relativePath(rootDirectory, declaration.getSourceFile().fileName)
              return {
                name: property.name,
                type: checker.typeToString(propertyType, declaration ?? node, EXPAND_FLAGS),
                ...(from === undefined ? {} : { from }),
              }
            }),
  }
}
