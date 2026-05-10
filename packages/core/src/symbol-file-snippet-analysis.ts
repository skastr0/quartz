import { isAbsolute, join } from "node:path"
import { Node, type Project, type SourceFile, type Symbol, SyntaxKind, TypeFormatFlags } from "ts-morph"
import type { ExpandedType, TypeAtPositionResult } from "./analyzer"
import type { PackageInfo } from "./discovery"
import { getDisplayPropertySymbols } from "./display-properties"
import type { TypeInfo } from "./project-types"

export interface SymbolAnalysisContext {
  readonly rootDirectory: string
  readonly kindToString: (kind: SyntaxKind) => string
  readonly relativePath: (absolutePath: string) => string
}

export interface FoundSymbol {
  readonly node: Node
  readonly symbol: Symbol
}

export const getTypeInfoForSymbol = (
  found: FoundSymbol,
  pkg: PackageInfo,
  context: SymbolAnalysisContext,
): TypeInfo => {
  const { node, symbol } = found
  const type = node.getType()
  const sourceFile = node.getSourceFile()

  const info: TypeInfo = {
    name: symbol.getName(),
    kind: context.kindToString(node.getKind()),
    type: type.getText(node),
    location: {
      file: context.relativePath(sourceFile.getFilePath()),
      line: node.getStartLineNumber(),
    },
    package: pkg.name,
  }

  if (node.getKind() === SyntaxKind.ClassDeclaration) {
    info.signature = `class ${symbol.getName()}`
  } else if (node.getKind() === SyntaxKind.InterfaceDeclaration) {
    info.signature = `interface ${symbol.getName()}`
  } else if (node.getKind() === SyntaxKind.TypeAliasDeclaration) {
    info.signature = `type ${symbol.getName()}`
  } else if (node.getKind() === SyntaxKind.FunctionDeclaration) {
    const callSignatures = type.getCallSignatures()
    if (callSignatures.length > 0) {
      info.signature = callSignatures.map((signature) => signature.getDeclaration().getText()).join("\n")
    }
  }

  const properties = getDisplayPropertySymbols(type, context.rootDirectory)
  if (properties.length > 0) {
    info.properties = properties.map((property) => {
      const declaration = property.getDeclarations()[0]
      const propertyType = declaration ? declaration.getType() : property.getTypeAtLocation(node)
      return {
        name: property.getName(),
        type: propertyType.getText(declaration ?? node),
        optional: property.isOptional(),
      }
    })
  }

  if (node.getKind() === SyntaxKind.ClassDeclaration) {
    const constructSignatures = type.getConstructSignatures()
    if (constructSignatures.length > 0) {
      info.constructors = constructSignatures.map((signature) => {
        const params = signature
          .getParameters()
          .map((parameter) => {
            const parameterType = parameter.getTypeAtLocation(node)
            return `${parameter.getName()}: ${parameterType.getText(node)}`
          })
          .join(", ")
        const returnType = signature.getReturnType().getText(node)
        return `new (${params}) => ${returnType}`
      })
    }
  }

  return info
}

export const expandTypeForSymbol = (
  found: FoundSymbol,
  project: Project,
  context: SymbolAnalysisContext,
): ExpandedType => {
  const { node } = found
  const type = node.getType()
  const checker = project.getTypeChecker()
  const original = type.getText(node)
  const expanded = checker.compilerObject.typeToString(
    type.compilerType,
    node.compilerNode,
    expandTypeFormatFlags as unknown as number,
  )

  return {
    original,
    expanded,
    properties: getDisplayPropertySymbols(type, context.rootDirectory).map((property) => {
      const declaration = property.getDeclarations()[0]
      const propertyType = declaration ? declaration.getType() : property.getTypeAtLocation(node)
      let from: string | undefined
      if (declaration !== undefined) {
        const propertySourceFile = declaration.getSourceFile()
        if (!propertySourceFile.isInNodeModules()) {
          from = context.relativePath(propertySourceFile.getFilePath())
        }
      }

      return {
        name: property.getName(),
        type: propertyType.getText(declaration ?? node),
        ...(from === undefined ? {} : { from }),
      }
    }),
  }
}

export const resolveSourceFile = (
  filePath: string,
  rootDirectory: string,
  project: Project,
  sourceFiles: readonly SourceFile[],
): SourceFile | null => {
  const targetPath = isAbsolute(filePath) ? filePath : join(rootDirectory, filePath)
  const sourceFile = project.getSourceFile(targetPath)
  if (sourceFile !== undefined) return sourceFile

  return (
    sourceFiles.find((candidate) => {
      const candidatePath = candidate.getFilePath()
      return candidatePath.endsWith(filePath) || candidatePath.includes(filePath)
    }) ?? null
  )
}

export const getTypeAtPositionInFile = (
  sourceFile: SourceFile,
  project: Project,
  line: number,
  column: number,
  context: SymbolAnalysisContext,
): TypeAtPositionResult | null => {
  const position = sourceFile.compilerNode.getPositionOfLineAndCharacter(line - 1, column - 1)
  const node = getDescendantAtPos(sourceFile, position)
  if (node === null) return null

  const type = node.getType()
  const checker = project.getTypeChecker()
  const nodeText = node.getText()
  const expanded = checker.compilerObject.typeToString(
    type.compilerType,
    node.compilerNode,
    expandTypeAtPositionFormatFlags as unknown as number,
  )

  return {
    type: type.getText(node),
    expanded,
    nodeKind: context.kindToString(node.getKind()),
    nodeText: nodeText.length > 100 ? `${nodeText.slice(0, 100)}...` : nodeText,
    location: {
      file: context.relativePath(sourceFile.getFilePath()),
      line: node.getStartLineNumber(),
      column: node.getStartLineNumber() === line ? column : 1,
    },
  }
}

const expandTypeFormatFlags =
  TypeFormatFlags.NoTruncation |
  TypeFormatFlags.WriteArrayAsGenericType |
  TypeFormatFlags.UseStructuralFallback |
  TypeFormatFlags.WriteTypeArgumentsOfSignature |
  TypeFormatFlags.InTypeAlias |
  TypeFormatFlags.UseAliasDefinedOutsideCurrentScope

const expandTypeAtPositionFormatFlags =
  TypeFormatFlags.NoTruncation |
  TypeFormatFlags.WriteArrayAsGenericType |
  TypeFormatFlags.UseStructuralFallback |
  TypeFormatFlags.WriteTypeArgumentsOfSignature |
  TypeFormatFlags.InTypeAlias

const getDescendantAtPos = (sourceFile: SourceFile, position: number): Node | null => {
  let result: Node | null = null

  const visit = (node: Node): void => {
    const start = node.getStart()
    const end = node.getEnd()

    if (position >= start && position <= end) {
      result = node
      node.forEachChild(visit)
    }
  }

  sourceFile.forEachChild(visit)
  return result
}
