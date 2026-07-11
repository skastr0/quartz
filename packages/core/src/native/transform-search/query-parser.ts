import type { TypeAliasDeclaration } from "typescript/unstable/ast"
import { isTypeAliasDeclaration } from "typescript/unstable/ast/is"
import type { PackageInfo } from "../../discovery"
import type { TransformSearchOptions } from "../../transform-search"
import type { NativeCommandContext } from "../context"
import {
  buildSnippetImportPlan,
  collectSnippetExportSources,
  loadSnippetProject,
  resolveSnippetDirectory,
  type NativeSnippetProject,
} from "../snippet-helpers"
import { extractTokensFromExpressionText } from "./tokens"
import type { NativeParsedQuery, NativeQueryType } from "./types"

export interface NativeQuerySession {
  readonly parsed: NativeParsedQuery
  readonly snippet: NativeSnippetProject
  readonly dispose: () => void
}

export const toSharedQuery = (query: NativeParsedQuery): import("../../transform-search").ParsedQuery => ({
  from: query.from === null ? null : { ...query.from, resolvedType: null },
  to: query.to === null ? null : { ...query.to, resolvedType: null },
  paramPosition: query.paramPosition,
  unwrapReturn: query.unwrapReturn,
  exportedOnly: query.exportedOnly,
  limit: query.limit,
  isValid: query.isValid,
  validationErrors: query.validationErrors,
})

const expressionKind = (expression: string): NativeQueryType["kind"] => {
  if (expression.startsWith("{") || expression.startsWith("(") || expression.startsWith("[") || expression.includes("=>")) return "expression"
  if ((expression.includes("|") || expression.includes("&")) && !expression.includes("<")) return "expression"
  return "symbol"
}

const findAlias = (snippet: NativeSnippetProject, name: string): TypeAliasDeclaration | undefined => {
  let found: TypeAliasDeclaration | undefined
  const visit = (node: import("typescript/unstable/ast").Node): void => {
    if (found !== undefined) return
    if (isTypeAliasDeclaration(node) && node.name.getText(snippet.snippetSourceFile) === name) {
      found = node
      return
    }
    node.forEachChild(visit)
  }
  visit(snippet.snippetSourceFile)
  return found
}

const queryType = (
  raw: string | undefined,
  aliasName: string,
  snippet: NativeSnippetProject,
  diagnostic: string | null,
): NativeQueryType | null => {
  if (raw === undefined) return null
  const trimmed = raw.trim()
  const extracted = extractTokensFromExpressionText(trimmed)
  const alias = findAlias(snippet, aliasName)
  return {
    kind: expressionKind(trimmed),
    raw: trimmed,
    resolvedType: alias === undefined || diagnostic !== null ? null : snippet.project.checker.getTypeFromTypeNode(alias.type),
    error: alias === undefined ? `Could not resolve ${trimmed}` : diagnostic,
    tokens: extracted.tokens,
    propKeys: extracted.propKeys,
  }
}

export const parseNativeQuery = (
  ctx: NativeCommandContext,
  pkg: PackageInfo,
  options: TransformSearchOptions,
): NativeQuerySession => {
  const layoutProgram = ctx.engine.getProgram(pkg.tsconfigPath)
  const layoutProject = ctx.engine.getProject(pkg.tsconfigPath)
  const importPlan = buildSnippetImportPlan(
    collectSnippetExportSources(layoutProgram, layoutProject, pkg),
    resolveSnippetDirectory(layoutProgram, pkg),
    true,
  )
  const aliases = [
    options.from === undefined ? "" : `type __QuartzFrom__ = ${options.from};`,
    options.to === undefined ? "" : `type __QuartzTo__ = ${options.to};`,
  ].filter((line) => line.length > 0).join("\n")
  const snippet = loadSnippetProject(ctx, pkg, `${importPlan.fileContent}${aliases}`)
  const diagnostics = [
    ...snippet.program.getSyntacticDiagnostics(snippet.snippetPath),
    ...snippet.program.getSemanticDiagnostics(snippet.snippetPath),
  ]
  const diagnostic = diagnostics.length === 0
    ? null
    : diagnostics.map((item) => item.text ?? `TS${item.code}`).join("; ")
  const errors: string[] = []
  if (options.from === undefined && options.to === undefined) errors.push("At least one of 'from' or 'to' is required")
  if (diagnostic !== null) errors.push(diagnostic)
  const from = queryType(options.from, "__QuartzFrom__", snippet, diagnostic)
  const to = queryType(options.to, "__QuartzTo__", snippet, diagnostic)
  const parsed: NativeParsedQuery = {
    from,
    to,
    paramPosition: options.paramPosition ?? 0,
    unwrapReturn: options.unwrapReturn ?? true,
    exportedOnly: options.exportedOnly ?? true,
    limit: options.limit ?? 25,
    isValid: errors.length === 0,
    validationErrors: errors,
  }
  return { parsed, snippet, dispose: snippet.dispose }
}
