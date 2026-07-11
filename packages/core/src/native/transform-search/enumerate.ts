import { relative } from "node:path"
import {
  SyntaxKind,
  type ConstructorTypeNode,
  type FunctionTypeNode,
  type FunctionLikeBase,
  type Node,
  type SourceFile,
  type TypeNode,
} from "typescript/unstable/ast"
import {
  isArrowFunction,
  isClassDeclaration,
  isConstructorDeclaration,
  isFunctionDeclaration,
  isFunctionExpression,
  isInterfaceDeclaration,
  isMethodDeclaration,
  isMethodSignatureDeclaration,
  isObjectLiteralExpression,
  isPropertyAssignment,
  isPropertySignatureDeclaration,
  isTypeAliasDeclaration,
  isTypeLiteralNode,
  isVariableDeclaration,
  isVariableStatement,
} from "typescript/unstable/ast/is"
import { ModifierFlags, type Project } from "typescript/unstable/sync"
import type { CallableKind, EnumerationResult, EnumerationStats, ExportState } from "../../transform-search/types"
import { extractTokensFromTypeNode } from "./tokens"
import type { NativeCallableEntry } from "./types"

const emptyStats = (): EnumerationStats => ({
  functions: 0,
  variableCallables: 0,
  classMethods: 0,
  staticMethods: 0,
  constructors: 0,
  objectMethods: 0,
  interfaceMethods: 0,
  typeLiteralMethods: 0,
  callableProperties: 0,
  total: 0,
})

interface ContainerInfo {
  readonly name: string
  readonly exported: boolean
}

const modifierFlags = (node: Node): ModifierFlags =>
  (node as Node & { readonly modifierFlags?: ModifierFlags }).modifierFlags ?? ModifierFlags.None

const hasModifier = (node: Node, flag: ModifierFlags): boolean => (modifierFlags(node) & flag) !== ModifierFlags.None

const nodeName = (node: Node): string | null => {
  const named = node as Node & { readonly name?: Node }
  return named.name?.getText(named.name.getSourceFile()).replace(/^['"]|['"]$/g, "") ?? null
}

const variableStatementFor = (node: Node): Node | null => {
  let current: Node | undefined = node.parent
  while (current !== undefined && current.kind !== SyntaxKind.SourceFile) {
    if (isVariableStatement(current)) return current
    current = current.parent
  }
  return null
}

const containerFor = (node: Node): ContainerInfo | null => {
  let current: Node | undefined = node.parent
  while (current !== undefined && current.kind !== SyntaxKind.SourceFile) {
    if (isClassDeclaration(current) || isInterfaceDeclaration(current) || isTypeAliasDeclaration(current)) {
      return { name: nodeName(current) ?? "anonymous", exported: hasModifier(current, ModifierFlags.Export) }
    }
    if (isObjectLiteralExpression(current)) {
      const variable = current.parent !== undefined && isVariableDeclaration(current.parent) ? current.parent : undefined
      if (variable !== undefined) {
        return {
          name: nodeName(variable) ?? "anonymous",
          exported: variableStatementFor(variable) !== null && hasModifier(variableStatementFor(variable)!, ModifierFlags.Export),
        }
      }
    }
    current = current.parent
  }
  return null
}

const exportState = (sourceFile: SourceFile, node: Node, container: ContainerInfo | null): ExportState => {
  if (sourceFile.isDeclarationFile) return "ambient"
  if (hasModifier(node, ModifierFlags.Export) || container?.exported === true) return "exported"
  const variableStatement = variableStatementFor(node)
  return variableStatement !== null && hasModifier(variableStatement, ModifierFlags.Export) ? "exported" : "internal"
}

const functionShape = (node: FunctionLikeBase) => {
  let minArity = 0
  let hasRest = false
  for (const parameter of node.parameters) {
    if (parameter.dotDotDotToken !== undefined) hasRest = true
    if (parameter.questionToken === undefined && parameter.initializer === undefined && parameter.dotDotDotToken === undefined) minArity++
  }
  return {
    minArity,
    maxArity: hasRest ? Number.POSITIVE_INFINITY : node.parameters.length,
    hasRest,
    hasTypeAnnotations: node.parameters.some((parameter) => parameter.type !== undefined) || node.type !== undefined,
  }
}

const tokenShape = (node: FunctionLikeBase) => {
  const paramTokens: string[] = []
  const paramPropKeys: string[] = []
  for (const parameter of node.parameters) {
    const extracted = extractTokensFromTypeNode(parameter.type)
    for (const token of extracted.tokens) if (!paramTokens.includes(token)) paramTokens.push(token)
    for (const key of extracted.propKeys) if (!paramPropKeys.includes(key)) paramPropKeys.push(key)
  }
  const returns = extractTokensFromTypeNode(node.type)
  return {
    paramTokens,
    paramPropKeys,
    returnTokens: returns.tokens,
    returnPropKeys: returns.propKeys,
  }
}

const callableType = (type: TypeNode | undefined): type is FunctionTypeNode | ConstructorTypeNode =>
  type !== undefined && (type.kind === SyntaxKind.FunctionType || type.kind === SyntaxKind.ConstructorType)

type AppendCallable = (
  sourceFile: SourceFile,
  node: FunctionLikeBase,
  kind: CallableKind,
  name: string,
  container: ContainerInfo | null,
  stat: keyof Omit<EnumerationStats, "total">,
) => void

const appendFunction = (node: Node, sourceFile: SourceFile, append: AppendCallable): boolean => {
  if (!isFunctionDeclaration(node) || node.name === undefined) return false
  const name = node.name.getText(sourceFile)
  const implementationExists = sourceFile.statements.some(
    (statement) => isFunctionDeclaration(statement) && nodeName(statement) === name && statement.body !== undefined,
  )
  if (node.body !== undefined || !implementationExists) append(sourceFile, node, "Function", name, null, "functions")
  return true
}

const appendVariable = (node: Node, sourceFile: SourceFile, append: AppendCallable): boolean => {
  if (!isVariableDeclaration(node) || node.initializer === undefined) return false
  if (!isArrowFunction(node.initializer) && !isFunctionExpression(node.initializer)) return false
  append(sourceFile, node.initializer, "VariableCallable", node.name.getText(sourceFile), null, "variableCallables")
  return true
}

const appendMethod = (node: Node, sourceFile: SourceFile, append: AppendCallable): boolean => {
  if (!isMethodDeclaration(node)) return false
  const container = containerFor(node)
  const kind: CallableKind = container !== null && isClassDeclaration(node.parent)
    ? (hasModifier(node, ModifierFlags.Static) ? "StaticMethod" : "ClassMethod")
    : "ObjectMethod"
  const stat = kind === "StaticMethod" ? "staticMethods" : kind === "ClassMethod" ? "classMethods" : "objectMethods"
  append(sourceFile, node, kind, nodeName(node) ?? "anonymous", container, stat)
  return true
}

const appendSignature = (node: Node, sourceFile: SourceFile, append: AppendCallable): boolean => {
  if (!isMethodSignatureDeclaration(node)) return false
  const kind: CallableKind = isTypeLiteralNode(node.parent) ? "TypeLiteralMethod" : "InterfaceMethod"
  append(
    sourceFile,
    node,
    kind,
    nodeName(node) ?? "anonymous",
    containerFor(node),
    kind === "TypeLiteralMethod" ? "typeLiteralMethods" : "interfaceMethods",
  )
  return true
}

const appendProperty = (node: Node, sourceFile: SourceFile, append: AppendCallable): boolean => {
  if (isPropertySignatureDeclaration(node) && callableType(node.type)) {
    append(sourceFile, node.type, "CallableProperty", nodeName(node) ?? "anonymous", containerFor(node), "callableProperties")
    return true
  }
  if (!isPropertyAssignment(node) || (!isArrowFunction(node.initializer) && !isFunctionExpression(node.initializer))) return false
  append(sourceFile, node.initializer, "ObjectMethod", nodeName(node) ?? "anonymous", containerFor(node), "objectMethods")
  return true
}

const appendClassConstructor = (node: Node, sourceFile: SourceFile, append: AppendCallable): boolean => {
  if (!isConstructorDeclaration(node)) return false
  append(sourceFile, node, "Constructor", "constructor", containerFor(node), "constructors")
  return true
}

const classifyCallable = (node: Node, sourceFile: SourceFile, append: AppendCallable): void => {
  if (appendFunction(node, sourceFile, append)) return
  if (appendVariable(node, sourceFile, append)) return
  if (appendMethod(node, sourceFile, append)) return
  if (appendClassConstructor(node, sourceFile, append)) return
  if (appendSignature(node, sourceFile, append)) return
  appendProperty(node, sourceFile, append)
}

const makeEntry = (
  project: Project,
  sourceFile: SourceFile,
  packagePath: string,
  id: number,
  node: FunctionLikeBase,
  kind: CallableKind,
  name: string,
  container: ContainerInfo | null,
  overloadCount: number,
): NativeCallableEntry => {
  const symbol = project.checker.getSymbolAtLocation((node as FunctionLikeBase & { readonly name?: Node }).name ?? node)
  const jsDocTags = symbol === undefined ? [] : project.checker.getJsDocTagsOfSymbol(symbol).map((tag) => tag.name)
  return {
    id,
    kind,
    qualifiedName: container === null ? name : `${container.name}.${name}`,
    exportState: exportState(sourceFile, node, container),
    filePath: relative(packagePath, sourceFile.fileName).replaceAll("\\", "/"),
    pos: node.getStart(sourceFile),
    end: node.getEnd(),
    ...functionShape(node),
    isAsyncSyntax: hasModifier(node, ModifierFlags.Async),
    syntacticOverloadCount: overloadCount,
    ...tokenShape(node),
    jsDocTags,
    isDeprecated: jsDocTags.includes("deprecated"),
    node,
    sourceFile,
  }
}

export const enumerateNativeCallables = (
  sourceFiles: readonly SourceFile[],
  packagePath: string,
  project: Project,
): EnumerationResult & { entries: NativeCallableEntry[] } => {
  const entries: NativeCallableEntry[] = []
  const stats = emptyStats()

  const append: AppendCallable = (
    sourceFile: SourceFile,
    node: FunctionLikeBase,
    kind: CallableKind,
    name: string,
    container: ContainerInfo | null,
    stat: keyof Omit<EnumerationStats, "total">,
  ): void => {
    const overloadCount = sourceFile.statements.filter((statement) => isFunctionDeclaration(statement) && nodeName(statement) === name && statement.body === undefined).length
    entries.push(makeEntry(project, sourceFile, packagePath, entries.length, node, kind, name, container, overloadCount))
    stats[stat]++
  }

  for (const sourceFile of sourceFiles) {
    const visit = (node: Node): void => {
      classifyCallable(node, sourceFile, append)
      node.forEachChild(visit)
    }
    visit(sourceFile)
  }
  stats.total = entries.length
  return { entries, stats }
}
