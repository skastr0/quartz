import { join, relative } from "node:path"
import {
  ModifierFlags,
  SignatureKind,
  TypeFlags,
  type Diagnostic,
  type Checker,
  type Project,
  type Type,
  type TypeReference,
} from "typescript/unstable/async"
import {
  SyntaxKind,
  type FunctionLikeBase,
  type Node,
  type SourceFile,
  type TypeNode,
} from "typescript/unstable/ast"
import {
  isArrowFunction,
  isCallSignatureDeclaration,
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
  isVariableDeclaration,
  isVariableStatement,
} from "typescript/unstable/ast/is"
import type { AnalyzerContext } from "../context"
import type {
  CallableKind,
  FromMatchDetails,
  MatchConfidence,
  TransformSearchOptions,
  TransformSearchResponse,
  TransformSearchResult,
  ToMatchDetails,
  VerificationMeta,
  VerificationStatus,
} from "../contracts"
import { resolveVirtualFileDirectory, synthesizePackageImports } from "../virtual-files"

type AsyncCallable = FunctionLikeBase & Node

interface Candidate {
  readonly id: number
  readonly sourceFile: SourceFile
  readonly callable: AsyncCallable
  readonly name: string
  readonly kind: CallableKind
  readonly exported: boolean
  readonly deprecated: boolean
  readonly containerName: string | null
  readonly params: readonly Node[]
  readonly returnNode: TypeNode | null
}

interface QueryType {
  readonly raw: string
  readonly type: Type | null
  readonly exactText: string | null
  readonly resolved: boolean
}
interface Match {
  readonly candidate: Candidate
  readonly from: FromMatchDetails | null
  readonly to: ToMatchDetails | null
  readonly fromAssignable: boolean
  readonly toAssignable: boolean
  readonly returnText: string
  readonly verification: VerificationMeta
  readonly score: number
  readonly confidence: MatchConfidence
}

const modifierFlagsOf = (node: Node): ModifierFlags =>
  (node as Node & { readonly modifierFlags?: ModifierFlags }).modifierFlags ?? ModifierFlags.None

const hasModifier = (node: Node, flag: ModifierFlags): boolean => (modifierFlagsOf(node) & flag) !== ModifierFlags.None

const textOfName = (node: Node & { readonly name?: Node }, sourceFile: SourceFile): string =>
  node.name?.getText(sourceFile).replace(/^["']|["']$/g, "") ?? "anonymous"

const variableStatement = (node: Node): Node | null => {
  let current: Node | undefined = node.parent
  while (current !== undefined && current.kind !== SyntaxKind.SourceFile) {
    if (isVariableStatement(current)) return current
    current = current.parent
  }
  return null
}

const exportedFrom = (node: Node): boolean => {
  let current: Node | undefined = node
  while (current !== undefined && current.kind !== SyntaxKind.SourceFile) {
    if (hasModifier(current, ModifierFlags.Export)) return true
    current = current.parent
  }
  const statement = variableStatement(node)
  return statement !== null && hasModifier(statement, ModifierFlags.Export)
}

const containerNameOf = (node: Node, sourceFile: SourceFile): string | null => {
  let current: Node | undefined = node.parent
  while (current !== undefined && current.kind !== SyntaxKind.SourceFile) {
    if (isClassDeclaration(current) || isInterfaceDeclaration(current) || isTypeAliasDeclaration(current)) {
      return textOfName(current as Node & { readonly name?: Node }, sourceFile)
    }
    if (isObjectLiteralExpression(current) && current.parent !== undefined && isVariableDeclaration(current.parent)) {
      return textOfName(current.parent as Node & { readonly name?: Node }, sourceFile)
    }
    current = current.parent
  }
  return null
}


const returnTypeNodeOf = (node: AsyncCallable): TypeNode | null =>
  ((node as AsyncCallable & { readonly type?: TypeNode }).type ?? null)

const nodeName = (node: Node, sourceFile: SourceFile): string => {
  const named = node as Node & { readonly name?: Node }
  return named.name === undefined ? "anonymous" : named.name.getText(sourceFile).replace(/^["']|["']$/g, "")
}

const enumerate = (sourceFiles: readonly SourceFile[]): Candidate[] => {
  const candidates: Candidate[] = []
  const append = (sourceFile: SourceFile, callable: AsyncCallable, kind: CallableKind, name: string): void => {
    const containerName = containerNameOf(callable, sourceFile)
    candidates.push({
      id: candidates.length,
      sourceFile,
      callable,
      name,
      kind,
      exported: exportedFrom(callable),
      deprecated: /@deprecated\b/.test(callable.getFullText(sourceFile)),
      containerName,
      params: callable.parameters,
      returnNode: returnTypeNodeOf(callable),
    })
  }
  const visit = (node: Node, sourceFile: SourceFile): void => {
    if (isFunctionDeclaration(node) && node.name !== undefined) {
      const implementationExists = sourceFile.statements.some(
        (statement) => isFunctionDeclaration(statement) && statement.name?.getText(sourceFile) === node.name?.getText(sourceFile) && statement.body !== undefined,
      )
      if (node.body !== undefined || !implementationExists) append(sourceFile, node, "Function", nodeName(node, sourceFile))
    } else if (isVariableDeclaration(node) && node.initializer !== undefined && (isArrowFunction(node.initializer) || isFunctionExpression(node.initializer))) {
      append(sourceFile, node.initializer, "VariableCallable", nodeName(node, sourceFile))
    } else if (isMethodDeclaration(node)) {
      const kind: CallableKind = isClassDeclaration(node.parent)
        ? (hasModifier(node, ModifierFlags.Static) ? "StaticMethod" : "ClassMethod")
        : "ObjectMethod"
      append(sourceFile, node, kind, nodeName(node, sourceFile))
    } else if (isConstructorDeclaration(node)) {
      append(sourceFile, node, "Constructor", "constructor")
    } else if (isMethodSignatureDeclaration(node) || isCallSignatureDeclaration(node)) {
      append(sourceFile, node as AsyncCallable, isMethodSignatureDeclaration(node) ? "InterfaceMethod" : "TypeLiteralMethod", nodeName(node, sourceFile))
    } else if (isPropertySignatureDeclaration(node) && node.type !== undefined && (node.type.kind === SyntaxKind.FunctionType || node.type.kind === SyntaxKind.ConstructorType)) {
      append(sourceFile, node.type as unknown as AsyncCallable, "CallableProperty", nodeName(node, sourceFile))
    } else if (isPropertyAssignment(node) && (isArrowFunction(node.initializer) || isFunctionExpression(node.initializer))) {
      append(sourceFile, node.initializer, "ObjectMethod", nodeName(node, sourceFile))
    }
    node.forEachChild((child) => visit(child, sourceFile))
  }
  for (const sourceFile of sourceFiles) visit(sourceFile, sourceFile)
  return candidates
}

const typeText = (node: Node | null, sourceFile: SourceFile): string => (node === null ? "unknown" : node.getText(sourceFile).trim())

const wrapperOf = (text: string): ToMatchDetails["wrapper"] => {
  const match = /^(Promise|PromiseLike|Effect|Observable|Task)\s*</.exec(text.replace(/\s/g, ""))
  return match === null ? null : match[1] as ToMatchDetails["wrapper"]
}

const unwrapText = (text: string, wrapper: ToMatchDetails["wrapper"]): string => {
  if (wrapper === null) return text
  const compact = text.replace(/\s/g, "")
  return compact.slice(wrapper.length + 1, compact.endsWith(">") ? -1 : undefined)
}

const erased = (type: Type | null): boolean => type !== null && (type.flags & TypeFlags.AnyOrUnknown) !== 0

const lineFor = (candidate: Candidate): number => candidate.sourceFile.getLineAndCharacterOfPosition(candidate.callable.getStart(candidate.sourceFile)).line + 1
const signatureFor = (candidate: Candidate, resolvedReturnText?: string): string => {
  const params = candidate.params.map((param) => param.getText(candidate.sourceFile).trim()).join(", ")
  const returnText = resolvedReturnText ?? (candidate.returnNode === null ? "unknown" : typeText(candidate.returnNode, candidate.sourceFile))
  return `${candidate.name}(${params}): ${returnText}`
}

const confidenceFor = (match: { readonly exactFrom: boolean; readonly exactTo: boolean; readonly verified: boolean; readonly partial: boolean }): MatchConfidence => {
  if (match.verified && (match.exactFrom || match.exactTo)) return "high"
  if (!match.partial && (match.exactFrom || match.exactTo)) return "medium"
  return "low"
}

const queryTypeFor = async (
  raw: string,
  sourceFiles: readonly SourceFile[],
  checker: Checker,
  availableTypes: ReadonlyMap<string, { readonly node: TypeNode; readonly type: Type }>,
): Promise<QueryType> => {
  const normalized = raw.trim()
  const exact = availableTypes.get(normalized)
  if (exact !== undefined) return { raw: normalized, type: exact.type, exactText: normalized, resolved: true }

  let declarationType: TypeNode | null = null
  let declarationName: Node | null = null
  const visit = (node: Node): void => {
    if (declarationType !== null) return
    if (isTypeAliasDeclaration(node) && node.name.getText(node.getSourceFile()) === normalized) {
      declarationType = node.type
      declarationName = node.name
    } else if ((node.kind === SyntaxKind.InterfaceDeclaration || node.kind === SyntaxKind.ClassDeclaration) && (node as Node & { readonly name?: Node }).name?.getText(node.getSourceFile()) === normalized) {
      declarationName = (node as Node & { readonly name: Node }).name
    }
    node.forEachChild(visit)
  }
  for (const sourceFile of sourceFiles) visit(sourceFile)
  if (declarationType !== null) {
    const type = (await checker.getTypeAtLocation(declarationType))
    return { raw: normalized, type, exactText: normalized, resolved: !type.isErrorType() }
  }
  if (declarationName !== null) {
    const symbol = await checker.getSymbolAtLocation(declarationName)
    if (symbol !== undefined) {
      const type = await checker.getDeclaredTypeOfSymbol(symbol)
      return { raw: normalized, type, exactText: normalized, resolved: !type.isErrorType() }
    }
  }
  return { raw: normalized, type: null, exactText: null, resolved: false }
}

const createExplanation = (match: Match): TransformSearchResult["explanation"] => {
  const from = match.from === null ? undefined : {
    description: `${match.from.paramName} accepts ${match.from.queryType}`,
    paramName: match.from.paramName,
    paramIndex: match.from.paramIndex,
    compatibility: match.from.exact ? "exact" as const : "assignable" as const,
  }
  const to = match.to === null ? undefined : {
    description: `returns ${match.to.queryType}`,
    compatibility: match.to.exact ? "exact" as const : "assignable" as const,
    ...(match.to.unwrapped && match.to.wrapper !== null ? { unwrapped: { wrapper: match.to.wrapper, originalType: match.to.returnType } } : {}),
  }
  return {
    summary: [from === undefined ? null : `accepts ${match.from?.queryType}`, to === undefined ? null : `returns ${match.to?.queryType}`].filter(Boolean).join(" and "),
    details: {
      ...(from === undefined ? {} : { fromMatch: from }),
      ...(to === undefined ? {} : { toMatch: to }),
      verification: { method: match.verification.method === "synthetic" ? "synthetic" : "assignability-only", passed: match.verification.status === "verified" },
    },
    confidence: match.confidence,
  }
}
let syntheticSequence = 0

const diagnosticText = (diagnostic: Diagnostic): string =>
  typeof diagnostic.text === "string" ? diagnostic.text : String(diagnostic.text)

const syntheticCall = (match: Match): string | null => {
  const candidate = match.candidate
  if (!candidate.exported || match.from === null || match.to === null) return null
  if (candidate.kind === "InterfaceMethod" || candidate.kind === "TypeLiteralMethod") return null
  const args = candidate.params
    .map((_, index) => index === match.from?.paramIndex ? "__input" : "undefined as never")
    .join(", ")
  if (candidate.kind === "Constructor") {
    return candidate.containerName === null ? null : `new ${candidate.containerName}(${args})`
  }
  if (candidate.containerName === null) return `${candidate.name}(${args})`
  if (candidate.kind === "StaticMethod" || candidate.kind === "ObjectMethod") {
    return `${candidate.containerName}.${candidate.name}(${args})`
  }
  return `(null as unknown as InstanceType<typeof ${candidate.containerName}>).${candidate.name}(${args})`
}

const verifySyntheticMatch = async (
  context: AnalyzerContext,
  project: Project,
  packageInfo: { readonly path: string; readonly tsconfigPath: string },
  match: Match,
  options: TransformSearchOptions,
): Promise<VerificationMeta> => {
  const call = syntheticCall(match)
  if (call === null || options.from === undefined || options.to === undefined) {
    return { status: "unverifiable", method: null, reason: "not_importable" }
  }
  const virtualFilePath = join(
    resolveVirtualFileDirectory(packageInfo.path),
    `__quartz_transform_verify_${(syntheticSequence++).toString(36)}.ts`,
  )
  const imports = await synthesizePackageImports(project, packageInfo.path, virtualFilePath)
  const assignment = match.to?.unwrapped && (match.to.wrapper === "Promise" || match.to.wrapper === "PromiseLike")
    ? `async function __quartzVerify() {\n  const __output: __QueryTo = await ${call}\n}`
    : `const __output: __QueryTo = ${call}`
  const syntheticCode = `${imports.content}type __QueryFrom = ${options.from}\ntype __QueryTo = ${options.to}\ndeclare const __input: __QueryFrom\n${assignment}\n`
  const diagnostics = await context.workspace.withVirtualFile(
    packageInfo.tsconfigPath,
    virtualFilePath,
    syntheticCode,
    async (syntheticProject, filePath) => (
      await Promise.all([
        syntheticProject.program.getSyntacticDiagnostics(filePath),
        syntheticProject.program.getBindDiagnostics(filePath),
        syntheticProject.program.getSemanticDiagnostics(filePath),
      ])
    ).flat(),
  )
  const failed = diagnostics.length > 0
  return {
    status: failed ? "unverified" : "verified",
    method: "synthetic",
    reason: failed ? "synthetic_check_failed" : "synthetic_check_passed",
    ...(failed && options.includeDiagnostics === true
      ? { diagnostics: diagnostics.map((diagnostic) => ({ code: diagnostic.code, message: diagnosticText(diagnostic) })) }
      : {}),
    ...(options.includeSyntheticCode === true ? { syntheticCode } : {}),
  }
}

export type TransformSearchOperation = (
  options: TransformSearchOptions & { readonly packageName?: string },
) => Promise<TransformSearchResponse>

interface TransformIndex {
  readonly sourceFiles: readonly SourceFile[]
  readonly allCandidates: readonly Candidate[]
  readonly availableTypes: Map<string, { readonly node: TypeNode; readonly type: Type }>
  readonly byNode: Map<Node, Type>
  readonly inferredReturnTypes: Map<Candidate, Type | null>
  readonly inferredReturnTexts: Map<Candidate, string>
}

const loadTransformIndex = async (project: Project): Promise<TransformIndex> => {
  const sourceNames = await project.program.getSourceFileNames()
  const sourceFiles = (await Promise.all(sourceNames.map((name) => project.program.getSourceFile(name))))
    .filter((sourceFile): sourceFile is SourceFile => sourceFile !== undefined && !sourceFile.isDeclarationFile && !sourceFile.fileName.includes("node_modules"))
  const allCandidates = enumerate(sourceFiles)
  const availableNodes: TypeNode[] = []
  for (const candidate of allCandidates) {
    for (const param of candidate.params) {
      const type = (param as Node & { readonly type?: TypeNode }).type
      if (type !== undefined) availableNodes.push(type)
    }
    if (candidate.returnNode !== null) availableNodes.push(candidate.returnNode)
  }
  const availableTypes = new Map<string, { readonly node: TypeNode; readonly type: Type }>()
  const byNode = new Map<Node, Type>()
  const checkerNodes: Node[] = [...availableNodes, ...allCandidates.map((candidate) => candidate.callable)]
  if (checkerNodes.length > 0) {
    const values = await project.checker.getTypeAtLocation(checkerNodes)
    for (let index = 0; index < checkerNodes.length; index += 1) {
      const node = checkerNodes[index]!
      const value = values[index]!
      byNode.set(node, value)
      if (index < availableNodes.length) {
        const typeNode = availableNodes[index]!
        if (!availableTypes.has(typeNode.getText(typeNode.getSourceFile()).trim())) {
          availableTypes.set(typeNode.getText(typeNode.getSourceFile()).trim(), { node: typeNode, type: value })
        }
      }
    }
  }
  const inferredReturnTypes = new Map<Candidate, Type | null>()
  const inferredReturnTexts = new Map<Candidate, string>()
  for (const candidate of allCandidates) {
    let returnType = candidate.returnNode === null ? null : byNode.get(candidate.returnNode) ?? null
    if (candidate.returnNode === null) {
      const callableType = byNode.get(candidate.callable)
      if (callableType !== undefined) {
        const signatures = await project.checker.getSignaturesOfType(callableType, SignatureKind.Call)
        const signature = signatures[0]
        if (signature !== undefined) returnType = await project.checker.getReturnTypeOfSignature(signature)
      }
      if (returnType !== null) inferredReturnTexts.set(candidate, await project.checker.typeToString(returnType, candidate.callable))
    }
    inferredReturnTypes.set(candidate, returnType)
  }
  return { sourceFiles, allCandidates, availableTypes, byNode, inferredReturnTypes, inferredReturnTexts }
}

/** Synthetic verification overscan: check this many extra candidates past the requested limit. */
const SYNTHETIC_OVERSCAN = 10

export const createTransformSearchOperation = (context: AnalyzerContext) => async (
  options: TransformSearchOptions & { readonly packageName?: string },
): Promise<TransformSearchResponse> => {
  const started = performance.now()
  const paramPosition = options.paramPosition ?? 0
  const unwrapReturn = options.unwrapReturn ?? true
  const exportedOnly = options.exportedOnly ?? true
  const limit = Math.max(0, options.limit ?? 25)
  if (options.from === undefined && options.to === undefined) throw new Error("At least one of 'from' or 'to' is required")
  return context.withProject(async (project, pkg, revision) => {
    // Revision is the sole invalidation authority; store the in-flight promise so
    // concurrent warm queries share one index build.
    const index = await context.cacheForRevision(`transform-index:${pkg.tsconfigPath}`, revision, () =>
      loadTransformIndex(project),
    )
    const { sourceFiles, availableTypes, byNode, inferredReturnTypes, inferredReturnTexts } = index
    const candidates = index.allCandidates.filter((candidate) => !exportedOnly || candidate.exported)
    const fromQuery = options.from === undefined ? null : await queryTypeFor(options.from, sourceFiles, project.checker, availableTypes)
    const toQuery = options.to === undefined ? null : await queryTypeFor(options.to, sourceFiles, project.checker, availableTypes)
    const matches: Match[] = []
    for (const candidate of candidates) {
      const positions = paramPosition === "any" ? candidate.params.map((_, index) => index) : [paramPosition]
      let fromMatch: FromMatchDetails | null = null
      let fromAssignable = options.from === undefined
      let fromErased = false
      let exactFrom = options.from === undefined
      if (fromQuery !== null) {
        for (const index of positions) {
          const param = candidate.params[index]
          if (param === undefined) continue
          const paramType = byNode.get((param as Node & { readonly type?: TypeNode }).type ?? param) ?? null
          const paramErased = erased(paramType)
          if (!options.allowTypeErasure && paramErased) continue
          const assignable = fromQuery.type !== null && paramType !== null ? await project.checker.isTypeAssignableTo(fromQuery.type, paramType) : typeText((param as Node & { readonly type?: TypeNode }).type ?? null, candidate.sourceFile) === fromQuery.raw
          if (!assignable) continue
          const paramName = (param as Node & { readonly name?: Node }).name?.getText(candidate.sourceFile) ?? `arg${index}`
          const paramText = typeText((param as Node & { readonly type?: TypeNode }).type ?? null, candidate.sourceFile)
          const exact = paramText.replace(/\s/g, "") === fromQuery.raw.replace(/\s/g, "")
          fromMatch = { matched: true, paramIndex: index, paramName, queryType: fromQuery.raw, paramType: paramText, exact, ...(paramErased ? { typeErasure: true } : {}) }
          fromAssignable = true
          fromErased = paramErased
          exactFrom = exact
          break
        }
      }
      if (fromQuery !== null && !fromAssignable) continue

      let toMatch: ToMatchDetails | null = null
      let toAssignable = options.to === undefined
      let toErased = false
      let exactTo = options.to === undefined
      let returnType: Type | null = inferredReturnTypes.get(candidate) ?? null
      let returnText = candidate.returnNode === null ? inferredReturnTexts.get(candidate) ?? "unknown" : typeText(candidate.returnNode, candidate.sourceFile)
      if (candidate.kind === "Constructor" && candidate.containerName !== null) returnText = candidate.containerName
      const wrapper = wrapperOf(returnText)
      let comparisonText = returnText
      let unwrapped = false
      if (unwrapReturn && wrapper !== null) {
        comparisonText = unwrapText(returnText, wrapper)
        if (returnType !== null && returnType.isTypeReference()) {
          const args = await project.checker.getTypeArguments(returnType as TypeReference)
          if (args[0] !== undefined) returnType = args[0]
        }
        unwrapped = true
      }
      if (toQuery !== null) {
        const returnErased = erased(returnType)
        if (!options.allowTypeErasure && returnErased) continue
        const constructorExact = candidate.kind === "Constructor" && candidate.containerName === toQuery.raw
        const assignable = constructorExact || (toQuery.type !== null && returnType !== null ? await project.checker.isTypeAssignableTo(returnType, toQuery.type) : comparisonText.replace(/\s/g, "") === toQuery.raw.replace(/\s/g, ""))
        if (!assignable) continue
        const exact = constructorExact || comparisonText.replace(/\s/g, "") === toQuery.raw.replace(/\s/g, "")
        toMatch = { matched: true, returnType: returnText, queryType: toQuery.raw, exact, unwrapped, wrapper, ...(returnErased ? { typeErasure: true } : {}) }
        toAssignable = true
        toErased = returnErased
        exactTo = exact
      }
      const partial = fromQuery === null || toQuery === null || !fromQuery.resolved || !toQuery?.resolved
      const verified = !partial && fromAssignable && toAssignable && !fromErased && !toErased
      const verification: VerificationMeta = verified
        ? { status: "verified", method: exactFrom && exactTo ? "exact_match" : "assignability_only", reason: "exact_type_match" }
        : { status: "unverified", method: "assignability_only", reason: partial ? "partial_query" : (fromErased || toErased ? "type_erasure" : "synthetic_check_failed") }
      const score = (exactFrom ? 40 : fromMatch === null ? 0 : 24) + (exactTo ? 40 : toMatch === null ? 0 : 24) + (verified ? 20 : 0) + (candidate.exported ? 8 : 0) - (candidate.deprecated ? 15 : 0) + (candidate.kind === "Function" ? 2 : 0) - (toMatch?.unwrapped ? 10 : 0)
      const confidence = confidenceFor({ exactFrom, exactTo, verified, partial })
      matches.push({ candidate, from: fromMatch, to: toMatch, fromAssignable, toAssignable, returnText, verification, score, confidence })
    }
    matches.sort((left, right) => right.score - left.score || left.candidate.name.localeCompare(right.candidate.name) || left.candidate.sourceFile.fileName.localeCompare(right.candidate.sourceFile.fileName) || lineFor(left.candidate) - lineFor(right.candidate))
    const assignabilityMs = performance.now() - started
    const syntheticStarted = performance.now()
    // Bound synthetic work to requested results + documented overscan — not max(50, limit).
    const syntheticLimit = limit + SYNTHETIC_OVERSCAN
    const rankedMatches = await Promise.all(matches.map(async (match, matchIndex) => {
      if (matchIndex >= syntheticLimit || match.verification.status !== "verified") return match
      const verification = await verifySyntheticMatch(context, project, pkg, match, options)
      return { ...match, verification }
    }))
    const syntheticMs = performance.now() - syntheticStarted
    const statusCounts: Record<VerificationStatus, number> = { verified: 0, unverified: 0, unverifiable: 0 }
    for (const match of rankedMatches) statusCounts[match.verification.status] += 1
    const filtered = rankedMatches.filter((match) => {
      if (match.verification.reason === "synthetic_check_failed" && options.includeFailedVerification !== true) return false
      if (options.verifiedOnly && match.verification.status !== "verified") return false
      if (options.minVerificationStatus !== undefined) {
        const order: Record<VerificationStatus, number> = { unverifiable: 0, unverified: 1, verified: 2 }
        if (order[match.verification.status] < order[options.minVerificationStatus]) return false
      }
      return true
    }).slice(0, limit)
    const results: TransformSearchResult[] = filtered.map((match) => ({
      name: match.candidate.containerName === null ? match.candidate.name : `${match.candidate.containerName}.${match.candidate.name}`,
      signature: signatureFor(match.candidate, match.returnText),
      kind: match.candidate.kind,
      file: relative(pkg.path, match.candidate.sourceFile.fileName).replaceAll("\\", "/"),
      line: lineFor(match.candidate),
      exported: match.candidate.exported,
      deprecated: match.candidate.deprecated,
      score: match.score,
      confidence: match.confidence,
      explanation: createExplanation(match),
      verification: match.verification,
      matchDetails: { fromMatch: match.from, toMatch: match.to },
    }))
    const totalMs = performance.now() - started
    return {
      results,
      query: {
        from: options.from?.trim() ?? null,
        to: options.to?.trim() ?? null,
        options: {
          paramPosition,
          unwrapReturn,
          exportedOnly,
          ...(options.verifiedOnly === undefined ? {} : { verifiedOnly: options.verifiedOnly }),
          ...(options.minVerificationStatus === undefined ? {} : { minVerificationStatus: options.minVerificationStatus }),
          ...(options.includeDiagnostics === undefined ? {} : { includeDiagnostics: options.includeDiagnostics }),
          ...(options.includeSyntheticCode === undefined ? {} : { includeSyntheticCode: options.includeSyntheticCode }),
          ...(options.includeFailedVerification === undefined ? {} : { includeFailedVerification: options.includeFailedVerification }),
        },
      },
      stats: {
        totalCandidates: candidates.length,
        assignableMatches: matches.length,
        verifiedMatches: statusCounts.verified,
        verification: statusCounts,
        returned: results.length,
        timing: { indexLookupMs: 0, resolutionMs: 0, assignabilityMs: Math.max(0, assignabilityMs), syntheticMs: Math.max(0, syntheticMs), totalMs },
      },
    }
  }, options.packageName)
}
