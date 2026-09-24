import { join, relative } from "node:path"
import {
  ModifierFlags,
  SignatureKind,
  TypeFlags,
  type Diagnostic,
  type Checker,
  type Project,
  type Signature,
  type Symbol as CompilerSymbol,
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
  isCallExpression,
  isCallSignatureDeclaration,
  isClassDeclaration,
  isConstructorDeclaration,
  isFunctionDeclaration,
  isFunctionExpression,
  isInterfaceDeclaration,
  isMethodDeclaration,
  isMethodSignatureDeclaration,
  isNewExpression,
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
import { QuartzEngineError } from "../errors"
import { modulePathFor, resolveVirtualFileDirectory, synthesizePackageImports } from "../virtual-files"

type AsyncCallable = FunctionLikeBase & Node

interface Candidate {
  readonly callableId: string
  readonly signatureKey: string | null
  readonly compilerSignature: Signature | null
  readonly symbolNode: Node | null
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

interface SyntheticVerification {
  readonly verification: VerificationMeta
  readonly selectedSignatureKey: string | null
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

const enclosingNameNode = (node: Node): Node | null => {
  let current: Node | undefined = node.parent
  while (current !== undefined && current.kind !== SyntaxKind.SourceFile) {
    const name = (current as Node & { readonly name?: Node }).name
    if (name !== undefined) return name
    current = current.parent
  }
  return null
}

const enumerate = (sourceFiles: readonly SourceFile[]): Candidate[] => {
  const candidates: Candidate[] = []
  const append = (
    sourceFile: SourceFile,
    callable: AsyncCallable,
    kind: CallableKind,
    name: string,
    symbolNode: Node | null,
  ): void => {
    const containerName = containerNameOf(callable, sourceFile)
    candidates.push({
      callableId: `declaration:${candidates.length}`,
      signatureKey: null,
      compilerSignature: null,
      symbolNode,
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
      if (node.body !== undefined || !implementationExists) append(sourceFile, node, "Function", nodeName(node, sourceFile), node.name)
    } else if (isVariableDeclaration(node) && node.initializer !== undefined && (isArrowFunction(node.initializer) || isFunctionExpression(node.initializer))) {
      append(sourceFile, node.initializer, "VariableCallable", nodeName(node, sourceFile), node.name)
    } else if (isMethodDeclaration(node)) {
      const kind: CallableKind = isClassDeclaration(node.parent)
        ? (hasModifier(node, ModifierFlags.Static) ? "StaticMethod" : "ClassMethod")
        : "ObjectMethod"
      append(sourceFile, node, kind, nodeName(node, sourceFile), node.name)
    } else if (isConstructorDeclaration(node)) {
      const className = isClassDeclaration(node.parent) ? node.parent.name ?? null : null
      append(sourceFile, node, "Constructor", "constructor", className)
    } else if (isMethodSignatureDeclaration(node) || isCallSignatureDeclaration(node)) {
      const symbolNode = isMethodSignatureDeclaration(node) ? node.name : enclosingNameNode(node)
      append(
        sourceFile,
        node as AsyncCallable,
        isMethodSignatureDeclaration(node) ? "InterfaceMethod" : "TypeLiteralMethod",
        nodeName(node, sourceFile),
        symbolNode,
      )
    } else if (isPropertySignatureDeclaration(node) && node.type !== undefined && (node.type.kind === SyntaxKind.FunctionType || node.type.kind === SyntaxKind.ConstructorType)) {
      append(sourceFile, node.type as unknown as AsyncCallable, "CallableProperty", nodeName(node, sourceFile), node.name)
    } else if (isPropertyAssignment(node) && (isArrowFunction(node.initializer) || isFunctionExpression(node.initializer))) {
      append(sourceFile, node.initializer, "ObjectMethod", nodeName(node, sourceFile), node.name)
    }
    node.forEachChild((child) => visit(child, sourceFile))
  }
  for (const sourceFile of sourceFiles) visit(sourceFile, sourceFile)
  return candidates
}

const signatureKeyForNode = (node: Node): string => {
  const sourceFile = node.getSourceFile()
  return `${sourceFile.fileName}:${node.getStart(sourceFile)}:${node.getEnd()}:${node.kind}`
}

interface CandidateGroup {
  readonly seed: Candidate
  readonly symbol: CompilerSymbol | null
  readonly seedCount: number
}

const needsSignatureExpansion = (group: CandidateGroup): boolean =>
  group.seedCount > 1 || (group.symbol?.declarations.length ?? 0) > 1

const symbolsForSeeds = async (
  project: Project,
  seeds: readonly Candidate[],
): Promise<ReadonlyMap<number, { readonly symbol: CompilerSymbol; readonly identity: string }>> => {
  const indexes: number[] = []
  const nodes: Node[] = []
  for (let index = 0; index < seeds.length; index += 1) {
    const node = seeds[index]!.symbolNode
    if (node === null) continue
    indexes.push(index)
    nodes.push(node)
  }
  const symbols = nodes.length === 0 ? [] : await project.checker.getSymbolAtLocation(nodes)
  const canonical = await Promise.all(symbols.map(async (symbol) => {
    if (symbol === undefined) return undefined
    const target = await project.checker.getTargetSymbol(symbol)
    return {
      symbol: target,
      identity: await project.checker.getFullyQualifiedName(target),
    }
  }))
  const bySeed = new Map<number, { readonly symbol: CompilerSymbol; readonly identity: string }>()
  for (let index = 0; index < symbols.length; index += 1) {
    const symbol = canonical[index]
    if (symbol !== undefined) bySeed.set(indexes[index]!, symbol)
  }
  return bySeed
}

const groupCandidateSeeds = (
  seeds: readonly Candidate[],
  symbols: ReadonlyMap<number, { readonly symbol: CompilerSymbol; readonly identity: string }>,
): ReadonlyMap<string, CandidateGroup> => {
  const groups = new Map<string, CandidateGroup>()
  for (let index = 0; index < seeds.length; index += 1) {
    const seed = seeds[index]!
    const symbolInfo = symbols.get(index)
    const symbol = symbolInfo?.symbol ?? null
    const symbolIdentity = symbolInfo?.identity ?? null
    const callableId = symbolIdentity === null ? seed.callableId : `${symbolIdentity}:${seed.kind}`
    const existing = groups.get(callableId)
    groups.set(callableId, existing === undefined
      ? { seed, symbol, seedCount: 1 }
      : { ...existing, seedCount: existing.seedCount + 1 })
  }
  return groups
}

const valueTypesForGroups = async (
  project: Project,
  groups: ReadonlyMap<string, CandidateGroup>,
): Promise<ReadonlyMap<string, Type>> => {
  const entries = [...groups.entries()].filter(
    (entry): entry is [string, CandidateGroup & { readonly symbol: CompilerSymbol }] =>
      entry[1].symbol !== null &&
      entry[1].seed.kind !== "TypeLiteralMethod" &&
      needsSignatureExpansion(entry[1]),
  )
  const types = entries.length === 0
    ? []
    : await project.checker.getTypeOfSymbol(entries.map(([, group]) => group.symbol))
  return new Map(entries.map(([callableId], index) => [callableId, types[index]!]))
}

const expandCandidateGroup = async (
  project: Project,
  callableId: string,
  group: CandidateGroup,
  valueTypes: ReadonlyMap<string, Type>,
): Promise<readonly Candidate[]> => {
  if (group.symbol === null || !needsSignatureExpansion(group)) {
    return [{ ...group.seed, callableId, signatureKey: signatureKeyForNode(group.seed.callable) }]
  }
  const type = group.seed.kind === "TypeLiteralMethod"
    ? await project.checker.getDeclaredTypeOfSymbol(group.symbol)
    : valueTypes.get(callableId)!
  const signatureKind =
    group.seed.kind === "Constructor" || group.seed.callable.kind === SyntaxKind.ConstructorType
      ? SignatureKind.Construct
      : SignatureKind.Call
  const signatures = type.isErrorType() ? [] : await project.checker.getSignaturesOfType(type, signatureKind)
  const candidates: Candidate[] = []
  for (const signature of signatures) {
    const declaration = await signature.declaration?.resolve(project)
    const callable = declaration as AsyncCallable | undefined
    if (callable === undefined || callable.parameters === undefined) continue
    const sourceFile = callable.getSourceFile()
    candidates.push({
      ...group.seed,
      callableId,
      signatureKey: signatureKeyForNode(callable),
      compilerSignature: signature,
      sourceFile,
      callable,
      deprecated: /@deprecated\b/.test(callable.getFullText(sourceFile)),
      params: callable.parameters,
      returnNode: returnTypeNodeOf(callable),
    })
  }
  return candidates.length === 0
    ? [{ ...group.seed, callableId, signatureKey: null, compilerSignature: null }]
    : candidates
}

const compilerCandidates = async (
  project: Project,
  seeds: readonly Candidate[],
): Promise<Candidate[]> => {
  const groups = groupCandidateSeeds(seeds, await symbolsForSeeds(project, seeds))
  const valueTypes = await valueTypesForGroups(project, groups)
  const candidates: Candidate[] = []
  for (const [callableId, group] of groups) {
    candidates.push(...await expandCandidateGroup(project, callableId, group, valueTypes))
  }
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

const compareMatches = (left: Match, right: Match): number =>
  right.score - left.score ||
  left.candidate.name.localeCompare(right.candidate.name) ||
  left.candidate.sourceFile.fileName.localeCompare(right.candidate.sourceFile.fileName) ||
  lineFor(left.candidate) - lineFor(right.candidate)

const groupMatchesByCallable = (matches: readonly Match[]): readonly (readonly Match[])[] => {
  const byCallable = new Map<string, Match[]>()
  const groups: Match[][] = []
  for (const match of matches) {
    const existing = byCallable.get(match.candidate.callableId)
    if (existing === undefined) {
      const group = [match]
      byCallable.set(match.candidate.callableId, group)
      groups.push(group)
    } else {
      existing.push(match)
    }
  }
  return groups
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
  if (exact !== undefined) {
    return { raw: normalized, type: exact.type, exactText: normalized, resolved: !exact.type.isErrorType() }
  }

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

const findSyntheticCall = (sourceFile: SourceFile): Node | null => {
  let found: Node | null = null
  const visit = (node: Node): void => {
    if (found !== null) return
    if (isCallExpression(node) || isNewExpression(node)) {
      found = node
      return
    }
    node.forEachChild(visit)
  }
  sourceFile.forEachChild(visit)
  return found
}

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
  return `(null as unknown as (typeof ${candidate.containerName})["prototype"]).${candidate.name}(${args})`
}

const namedDeclarationKinds = new Set([
  SyntaxKind.InterfaceDeclaration,
  SyntaxKind.ClassDeclaration,
  SyntaxKind.TypeAliasDeclaration,
  SyntaxKind.EnumDeclaration,
])

/** The source file with a top-level exported type declaration named `name`. */
const exportingFileFor = (name: string, sourceFiles: readonly SourceFile[]): SourceFile | null => {
  for (const sourceFile of sourceFiles) {
    for (const statement of sourceFile.statements) {
      if (!namedDeclarationKinds.has(statement.kind) || !hasModifier(statement, ModifierFlags.Export)) continue
      if ((statement as Node & { readonly name?: Node }).name?.getText(sourceFile) === name) return sourceFile
    }
  }
  return null
}

/**
 * Import the candidate and bare-name query types from the modules that declare
 * them. Candidates are any exported callable, not only what the package entry
 * re-exports, so the entry's imports alone cannot name them.
 */
const declaringModuleImports = (
  match: Match,
  options: TransformSearchOptions,
  sourceFiles: readonly SourceFile[],
  virtualFilePath: string,
): { readonly content: string; readonly names: ReadonlySet<string> } => {
  const names = new Set<string>()
  const lines: string[] = []
  const candidateName = match.candidate.containerName ?? match.candidate.name
  names.add(candidateName)
  lines.push(`import { ${candidateName} } from ${JSON.stringify(modulePathFor(virtualFilePath, match.candidate.sourceFile.fileName))}`)
  for (const query of [options.from, options.to]) {
    const name = query?.trim()
    if (name === undefined || names.has(name) || !/^[A-Za-z_$][\w$]*$/.test(name)) continue
    const sourceFile = exportingFileFor(name, sourceFiles)
    if (sourceFile === null) continue
    names.add(name)
    lines.push(`import type { ${name} } from ${JSON.stringify(modulePathFor(virtualFilePath, sourceFile.fileName))}`)
  }
  return { content: `${lines.join("\n")}\n`, names }
}

const verifySyntheticMatch = async (
  context: AnalyzerContext,
  project: Project,
  packageInfo: { readonly path: string; readonly tsconfigPath: string },
  sourceFiles: readonly SourceFile[],
  match: Match,
  options: TransformSearchOptions,
): Promise<SyntheticVerification> => {
  const call = syntheticCall(match)
  if (call === null || options.from === undefined || options.to === undefined) {
    return {
      verification: { status: "unverifiable", method: null, reason: "not_importable" },
      selectedSignatureKey: null,
    }
  }
  const virtualFilePath = join(
    resolveVirtualFileDirectory(packageInfo.path),
    `__quartz_transform_verify_${(syntheticSequence++).toString(36)}.ts`,
  )
  const declaring = declaringModuleImports(match, options, sourceFiles, virtualFilePath)
  const imports = await synthesizePackageImports(project, packageInfo.path, virtualFilePath, declaring.names)
  const assignment = match.to?.unwrapped && (match.to.wrapper === "Promise" || match.to.wrapper === "PromiseLike")
    ? `async function __quartzVerify() {\n  const __output: __QueryTo = await ${call}\n}`
    : `const __output: __QueryTo = ${call}`
  const syntheticCode = `${declaring.content}${imports.content}type __QueryFrom = ${options.from}\ntype __QueryTo = ${options.to}\ndeclare const __input: __QueryFrom\n${assignment}\n`
  const syntheticResult = await context.workspace.withVirtualFile(
    packageInfo.tsconfigPath,
    virtualFilePath,
    syntheticCode,
    async (syntheticProject, filePath) => {
      const diagnostics = (
        await Promise.all([
        syntheticProject.program.getSyntacticDiagnostics(filePath),
        syntheticProject.program.getBindDiagnostics(filePath),
        syntheticProject.program.getSemanticDiagnostics(filePath),
      ])
      ).flat()
      if (diagnostics.length > 0) return { diagnostics, selectedSignatureKey: null }
      const sourceFile = await syntheticProject.program.getSourceFile(filePath)
      const callNode = sourceFile === undefined ? null : findSyntheticCall(sourceFile)
      if (callNode === null) return { diagnostics, selectedSignatureKey: null }
      const signature = await syntheticProject.checker.getResolvedSignature(callNode)
      if (await syntheticProject.checker.isUnknownSignature(signature)) {
        return { diagnostics, selectedSignatureKey: null }
      }
      const declaration = await signature.declaration?.resolve(syntheticProject)
      return {
        diagnostics,
        selectedSignatureKey: declaration === undefined ? null : signatureKeyForNode(declaration),
      }
    },
  )
  const failed = syntheticResult.diagnostics.length > 0 || syntheticResult.selectedSignatureKey === null
  return {
    verification: {
      status: failed ? "unverified" : "verified",
      method: "synthetic",
      reason: failed ? "synthetic_check_failed" : "synthetic_check_passed",
      ...(syntheticResult.diagnostics.length > 0 && options.includeDiagnostics === true
        ? { diagnostics: syntheticResult.diagnostics.map((diagnostic) => ({ code: diagnostic.code, message: diagnosticText(diagnostic) })) }
        : {}),
      ...(options.includeSyntheticCode === true ? { syntheticCode } : {}),
    },
    selectedSignatureKey: syntheticResult.selectedSignatureKey,
  }
}

export type TransformSearchOperation = (
  options: TransformSearchOptions & { readonly packageName?: string },
) => Promise<TransformSearchResponse>

/** Preserve a bounded non-trust-filter path while surfacing nearby failures. */
const SYNTHETIC_OVERSCAN = 10
/** Keep virtual-project verification parallel without saturating the compiler service. */
const SYNTHETIC_VERIFICATION_BATCH_SIZE = 8
/** Bound source-file transport fan-out on large projects while retaining parallel reads. */
const SOURCE_FILE_BATCH_SIZE = 32

type VerifyMatchGroup = (group: readonly Match[]) => Promise<Match>

const verifyUnfilteredGroups = async (
  groups: readonly (readonly Match[])[],
  limit: number,
  verify: VerifyMatchGroup,
): Promise<Match[]> => {
  const prefixLength = Math.min(groups.length, limit + SYNTHETIC_OVERSCAN)
  const verifiedPrefix = await Promise.all(groups.slice(0, prefixLength).map(verify))
  return [...verifiedPrefix, ...groups.slice(prefixLength).map((group) => group[0]!)].sort(compareMatches)
}

const verifyTrustedGroups = async (
  groups: readonly (readonly Match[])[],
  limit: number,
  verify: VerifyMatchGroup,
): Promise<Match[]> => {
  if (limit === 0) return []
  const matches: Match[] = []
  let verifiedCount = 0
  let start = 0
  while (start < groups.length) {
    if (verifiedCount >= limit) {
      const threshold = matches
        .filter((match) => match.verification.status === "verified")
        .sort(compareMatches)[limit - 1]
      const nextUpperBound = groups[start]?.[0]
      if (
        threshold === undefined ||
        nextUpperBound === undefined ||
        compareMatches(nextUpperBound, threshold) >= 0
      ) {
        break
      }
    }
    const batchSize = verifiedCount < limit
      ? Math.min(SYNTHETIC_VERIFICATION_BATCH_SIZE, limit - verifiedCount)
      : 1
    const batch = await Promise.all(groups.slice(start, start + batchSize).map(verify))
    matches.push(...batch)
    verifiedCount += batch.filter((match) => match.verification.status === "verified").length
    start += batchSize
  }
  return matches.sort(compareMatches)
}

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
  const sourceFiles: SourceFile[] = []
  for (let start = 0; start < sourceNames.length; start += SOURCE_FILE_BATCH_SIZE) {
    const batch = await Promise.all(
      sourceNames.slice(start, start + SOURCE_FILE_BATCH_SIZE).map((name) => project.program.getSourceFile(name)),
    )
    const eligible = await Promise.all(batch.map(async (sourceFile) => {
      if (sourceFile === undefined || sourceFile.isDeclarationFile) return undefined
      const [external, defaultLibrary] = await Promise.all([
        project.program.isSourceFileFromExternalLibrary(sourceFile),
        project.program.isSourceFileDefaultLibrary(sourceFile),
      ])
      return external || defaultLibrary ? undefined : sourceFile
    }))
    sourceFiles.push(...eligible.filter((sourceFile): sourceFile is SourceFile => sourceFile !== undefined))
  }
  const allCandidates = await compilerCandidates(project, enumerate(sourceFiles))
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
      if (candidate.compilerSignature !== null) {
        returnType = await project.checker.getReturnTypeOfSignature(candidate.compilerSignature)
      } else {
        const callableType = byNode.get(candidate.callable)
        if (callableType !== undefined) {
          const signatures = await project.checker.getSignaturesOfType(callableType, SignatureKind.Call)
          const signature = signatures[0]
          if (signature !== undefined) returnType = await project.checker.getReturnTypeOfSignature(signature)
        }
      }
      if (returnType !== null) {
        inferredReturnTexts.set(candidate, await project.checker.typeToString(returnType, candidate.callable))
      }
    }
    inferredReturnTypes.set(candidate, returnType)
  }
  return { sourceFiles, allCandidates, availableTypes, byNode, inferredReturnTypes, inferredReturnTexts }
}

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
    const unresolved = fromQuery?.resolved === false
      ? { field: "from", query: fromQuery }
      : toQuery?.resolved === false
        ? { field: "to", query: toQuery }
        : null
    if (unresolved !== null) {
      throw new QuartzEngineError(
        "TRANSFORM_QUERY_UNRESOLVED",
        `Could not resolve transform-search ${unresolved.field} type ${JSON.stringify(unresolved.query.raw)}. Declare an exported named type or alias and retry.`,
      )
    }
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
      // Assignability alone never ships as `verified` — synthetic is the only promotion path
      // for full from+to matches. Pre-synthetic "verified" would silently backfill past the
      // synthetic overscan bound under verifiedOnly / minVerificationStatus filters.
      const assignabilityOk = !partial && fromAssignable && toAssignable && !fromErased && !toErased
      const verification: VerificationMeta = assignabilityOk
        ? {
            status: "unverified",
            method: exactFrom && exactTo ? "exact_match" : "assignability_only",
            reason: "assignability_pending_synthetic",
          }
        : {
            status: "unverified",
            method: "assignability_only",
            reason: partial ? "partial_query" : (fromErased || toErased ? "type_erasure" : "synthetic_check_failed"),
          }
      const score = (exactFrom ? 40 : fromMatch === null ? 0 : 24) + (exactTo ? 40 : toMatch === null ? 0 : 24) + (assignabilityOk ? 20 : 0) + (candidate.exported ? 8 : 0) - (candidate.deprecated ? 15 : 0) + (candidate.kind === "Function" ? 2 : 0) - (toMatch?.unwrapped ? 10 : 0)
      const confidence = confidenceFor({ exactFrom, exactTo, verified: false, partial })
      matches.push({ candidate, from: fromMatch, to: toMatch, fromAssignable, toAssignable, returnText, verification, score, confidence })
    }
    matches.sort(compareMatches)
    const matchGroups = groupMatchesByCallable(matches)
    const assignabilityMs = performance.now() - started
    const syntheticStarted = performance.now()
    const trustFiltered = options.verifiedOnly === true || options.minVerificationStatus === "verified"
    const finalizeVerification = (match: Match, verification: VerificationMeta): Match => {
      const verified = verification.status === "verified"
      return {
        ...match,
        verification,
        confidence: verification.reason === "synthetic_check_failed"
          ? "low"
          : confidenceFor({
              exactFrom: match.from?.exact === true,
              exactTo: match.to?.exact === true,
              verified,
              partial: match.from === null || match.to === null || !fromQuery?.resolved || !toQuery?.resolved,
            }),
      }
    }
    const verifyPending = async (group: readonly Match[]): Promise<Match> => {
      const provisional = group[0]!
      if (provisional.verification.reason !== "assignability_pending_synthetic") {
        return finalizeVerification(provisional, provisional.verification)
      }
      const synthetic = await verifySyntheticMatch(context, project, pkg, sourceFiles, provisional, options)
      const selected = synthetic.selectedSignatureKey === null
        ? undefined
        : group.find((match) => match.candidate.signatureKey === synthetic.selectedSignatureKey)
      if (synthetic.verification.status === "verified" && selected === undefined) {
        return finalizeVerification(provisional, {
          ...synthetic.verification,
          status: "unverified",
          reason: "synthetic_check_failed",
        })
      }
      return finalizeVerification(selected ?? provisional, synthetic.verification)
    }
    const rankedMatches = trustFiltered
      ? await verifyTrustedGroups(matchGroups, limit, verifyPending)
      : await verifyUnfilteredGroups(matchGroups, limit, verifyPending)
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
        totalCandidates: new Set(candidates.map((candidate) => candidate.callableId)).size,
        assignableMatches: matchGroups.length,
        verifiedMatches: statusCounts.verified,
        verification: statusCounts,
        returned: results.length,
        timing: { indexLookupMs: 0, resolutionMs: 0, assignabilityMs: Math.max(0, assignabilityMs), syntheticMs: Math.max(0, syntheticMs), totalMs },
      },
    }
  }, options.packageName)
}
