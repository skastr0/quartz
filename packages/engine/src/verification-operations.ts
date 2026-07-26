import { DiagnosticCategory, type Project } from "typescript/unstable/async"
import type { AnalyzerContext } from "./context"
import type {
  CompatibilityResult,
  DiagnosticInfo,
  ErrorExplanationIssue,
  ErrorExplanationOptions,
  ErrorExplanationResult,
  ExplainedDiagnosticsResult,
  SnippetCheckResult,
  SnippetDiagnostic,
  TransformSearchResponse,
  TypeAnalyzer,
  VerifyContractCheck,
  VerifyContractDiagnostic,
  VerifyContractEvidence,
  VerifyContractOptions,
  VerifyContractResult,
} from "./contracts"
import {
  createVirtualFileRegistry,
  resolveVirtualFileDirectory,
  synthesizePackageImports,
  withVirtualFile,
  type VirtualFileRegistry,
} from "./virtual-files"

export interface VirtualWorkspace {
  withVirtualFile<T>(
    tsconfigPath: string,
    filePath: string,
    content: string,
    operation: (project: Project, filePath: string) => Promise<T>,
  ): Promise<T>
}

export interface VerificationOperationDependencies {
  readonly compatibility: TypeAnalyzer["checkCompatibility"]
  readonly diagnostics: TypeAnalyzer["getDiagnostics"]
  readonly transformSearch: TypeAnalyzer["transformSearch"]
  readonly virtualFiles?: VirtualFileRegistry
}

export interface VerificationOperations {
  readonly checkSnippet: TypeAnalyzer["checkSnippet"]
  readonly explainError: TypeAnalyzer["explainError"]
  readonly verifyContract: TypeAnalyzer["verifyContract"]
}

const workspaceWithVirtualFile = (context: AnalyzerContext): VirtualWorkspace => {
  const workspace = context.workspace as unknown as Partial<VirtualWorkspace>
  if (typeof workspace.withVirtualFile !== "function") {
    throw new Error(
      "checkSnippet requires QuartzWorkspace.withVirtualFile(tsconfigPath, filePath, content, operation), which runs runWithTemporaryFileUpdate against the immutable base snapshot",
    )
  }
  return workspace as VirtualWorkspace
}

const lineAndColumn = (source: { getLineAndCharacterOfPosition(position: number): { line: number; character: number } }, position: number) => {
  const location = source.getLineAndCharacterOfPosition(Math.max(0, position))
  return { line: location.line + 1, column: location.character + 1 }
}

const snippetDiagnostics = async (project: Project, filePath: string, lineOffset = 0): Promise<readonly SnippetDiagnostic[]> => {
  const diagnostics = (
    await Promise.all([
      project.program.getSyntacticDiagnostics(filePath),
      project.program.getBindDiagnostics(filePath),
      project.program.getSemanticDiagnostics(filePath),
    ])
  ).flat()
  const sourceFile = await project.program.getSourceFile(filePath)
  const seen = new Set<string>()
  const result: SnippetDiagnostic[] = []
  for (const diagnostic of diagnostics) {
    const key = `${diagnostic.code}\u0000${diagnostic.pos}\u0000${diagnostic.end}\u0000${diagnostic.text}`
    if (seen.has(key)) continue
    seen.add(key)
    const location = sourceFile === undefined ? { line: 1, column: 1 } : lineAndColumn(sourceFile, diagnostic.pos)
    result.push({
      message: diagnostic.text,
      line: Math.max(1, location.line - lineOffset),
      column: location.column,
      severity: diagnostic.category === DiagnosticCategory.Error ? "error" : "warning",
    })
  }
  return result.sort((left, right) => left.line - right.line || left.column - right.column || left.message.localeCompare(right.message))
}

const typePatterns = [
  /Type '([^']+)' is not assignable to type '([^']+)'/,
  /Argument of type '([^']+)' is not assignable to parameter of type '([^']+)'/,
  /Type ([\w$]+(?:\.[\w$]+)*) is not assignable to type ([\w$]+(?:\.[\w$]+)*)/,
  /Argument of type ([\w$]+(?:\.[\w$]+)*) is not assignable to parameter of type ([\w$]+(?:\.[\w$]+)*)/,
  /Property '[^']+' does not exist on type '([^']+)'/,
  /Property '[^']+' is missing in type '([^']+)' but required in type '([^']+)'/,
  /Property ([\w$]+) is missing in type ([\w$]+(?:\.[\w$]+)*) but required in type ([\w$]+(?:\.[\w$]+)*)/,
  /Type '([^']+)' has no properties in common with type '([^']+)'/,
]
const propertyPatterns = [
  /Property '([^']+)' does not exist/,
  /Property '([^']+)' is missing/,
  /Property ([\w$]+) does not exist/,
  /Property ([\w$]+) is missing/,
  /Did you mean '([^']+)'\?/,
]

const extractErrorParts = (message: string): { readonly types: readonly string[]; readonly properties: readonly string[] } => {
  const types: string[] = []
  const properties: string[] = []
  for (const pattern of typePatterns) {
    const match = pattern.exec(message)
    if (match === null) continue
    for (const value of match.slice(1)) {
      if (value !== undefined && !(value.startsWith("{") && value.endsWith("}"))) types.push(value)
    }
    break
  }
  for (const pattern of propertyPatterns) {
    const match = pattern.exec(message)
    if (match?.[1] !== undefined) properties.push(match[1])
  }
  return { types, properties }
}

const asDiagnostics = (value: readonly DiagnosticInfo[] | ExplainedDiagnosticsResult): readonly DiagnosticInfo[] =>
  "errors" in value ? value.errors : value

interface MutableErrorExplanation {
  error: { code: number; message: string }
  explanation: string
  issues: ErrorExplanationIssue[]
  suggestions: string[]
}

interface MutableVerifyEvidence {
  compatibility?: CompatibilityResult
  snippet?: SnippetCheckResult
  diagnostics?: readonly VerifyContractDiagnostic[]
  transformSearch?: TransformSearchResponse
  explanations?: readonly ErrorExplanationResult[]
}

const skipped = (summary: string): VerifyContractCheck => ({ ran: false, passed: null, blocking: false, summary })

const toVerifyDiagnostic = (diagnostic: DiagnosticInfo): VerifyContractDiagnostic => ({
  file: diagnostic.file ?? "",
  line: diagnostic.line ?? 1,
  column: diagnostic.column ?? 1,
  message: diagnostic.message,
  code: diagnostic.code,
})

export const createVerificationOperations = (
  context: AnalyzerContext,
  dependencies: VerificationOperationDependencies,
): VerificationOperations => {
  const checkSnippet: TypeAnalyzer["checkSnippet"] = async (code, packageName) => {
    const pkg = context.package(packageName)
    const registry =
      dependencies.virtualFiles ?? createVirtualFileRegistry(resolveVirtualFileDirectory(pkg.path))
    const workspace = workspaceWithVirtualFile(context)
    return withVirtualFile(registry, code, async (lease) => {
      const imports =
        typeof context.withProject !== "function"
          ? { content: "", lineOffset: 0 }
          : await context.withProject(
              (project) => synthesizePackageImports(project, pkg.path, lease.path),
              packageName,
            )
      return workspace.withVirtualFile(pkg.tsconfigPath, lease.path, `${imports.content}${lease.content}`, async (project, filePath) => {
        const errors = await snippetDiagnostics(project, filePath, imports.lineOffset)
        return errors.length === 0 ? { valid: true } : { valid: false, errors }
      })
    })
  }

  const explainError: TypeAnalyzer["explainError"] = async (options: ErrorExplanationOptions): Promise<ErrorExplanationResult | null> => {
    let code = options.code ?? 0
    let message = options.message ?? ""
    if (message.length === 0 && (
      options.code !== undefined
      || (options.file !== undefined && options.line !== undefined)
    )) {
      const diagnostics = asDiagnostics(await dependencies.diagnostics(options.packageName))
      const match =
        options.file !== undefined && options.line !== undefined
          ? diagnostics.find((diagnostic) =>
              diagnostic.file?.endsWith(options.file!)
              && diagnostic.line === options.line
              && (options.code === undefined || diagnostic.code === options.code)
            )
          : diagnostics.find((diagnostic) => diagnostic.code === options.code)
      if (match !== undefined) {
        code = match.code
        message = match.message
      }
    }
    if (message.length === 0) return null

    const extracted = extractErrorParts(message)
    const explanationIssues: ErrorExplanationIssue[] = []
    const suggestions: string[] = []
    const result: MutableErrorExplanation = { error: { code, message }, explanation: message, issues: explanationIssues, suggestions }
    const firstType = extracted.types[0]
    const secondType = extracted.types[1]
    if ((code === 2322 || code === 2345) && firstType !== undefined && secondType !== undefined) {
      let compatibility: CompatibilityResult | undefined
      try {
        const packageOption = options.packageName === undefined ? {} : { packageName: options.packageName }
        compatibility = await dependencies.compatibility(firstType, secondType, packageOption.packageName)
      } catch {
        compatibility = undefined
      }
      const issues = compatibility?.issues ?? []
      explanationIssues.push(...issues)
      if (!compatibility?.compatible) {
        result.explanation = `You're trying to use a value of type '${firstType}' where a value of type '${secondType}' is expected. These types are not compatible.`
      }
      suggestions.push(`Add missing properties: ${secondType}`)
      suggestions.push(`Use Partial<${secondType}> if properties should be optional`)
    } else if (code === 2339 && firstType !== undefined && extracted.properties[0] !== undefined) {
      const property = extracted.properties[0]
      explanationIssues.push({ kind: "missing_property", property, message: `Property '${property}' does not exist on type '${firstType}'` })
      result.explanation = `You're trying to access property '${property}' on type '${firstType}', but this property doesn't exist.`
      suggestions.push(`Check for typos in the property name`)
      suggestions.push(`Add property '${property}' to the type`)
    } else if (code === 2741 && extracted.properties[0] !== undefined && secondType !== undefined) {
      const property = extracted.properties[0]
      explanationIssues.push({ kind: "missing_property", property, message: `Property '${property}' is required but missing` })
      result.explanation = `Type '${firstType ?? "the source"}' is missing required property '${property}' that '${secondType}' expects.`
      suggestions.push(`Add '${property}' to your object`)
      suggestions.push(`Make '${property}' optional in ${secondType} using '${property}?:'`)
    } else {
      explanationIssues.push({ kind: "other", message })
      suggestions.push("Review the types involved using type_expand")
      suggestions.push("Check type compatibility using type_compatible")
    }
    return result
  }

  const verifyContract: TypeAnalyzer["verifyContract"] = async (options: VerifyContractOptions): Promise<VerifyContractResult> => {
    const from = options.from?.trim() || undefined
    const to = options.to?.trim() || undefined
    const symbol = options.symbol?.trim() || undefined
    const packageName = options.packageName?.trim() || undefined
    const checks: Record<"compatibility" | "snippet" | "diagnostics" | "transform", VerifyContractCheck> = {
      compatibility: skipped("Skipped because both from and to were not provided."),
      snippet: skipped("Skipped because no snippet was provided."),
      diagnostics: skipped("Skipped because includeDiagnostics was false."),
      transform: skipped("Skipped because both from and to were not provided."),
    }
    const evidence: MutableVerifyEvidence = {}
    const gaps: string[] = []
    const nextSteps = new Set<string>()
    const explanations: ErrorExplanationResult[] = []

    if ((from === undefined) !== (to === undefined)) {
      gaps.push("Only one side of the from/to contract was provided.")
      nextSteps.add("Provide both from and to to run compatibility and transform verification.")
    } else if (from !== undefined && to !== undefined) {
      const compatibility = await dependencies.compatibility(from, to, packageName)
      evidence.compatibility = compatibility
      checks.compatibility = {
        ran: true,
        passed: compatibility.compatible,
        blocking: false,
        summary: compatibility.compatible ? `${from} is directly assignable to ${to}.` : `${from} is not directly assignable to ${to}; verified transform evidence can still satisfy a conversion contract.`,
        evidence: compatibility,
      }
      if (!compatibility.compatible) {
        gaps.push("Direct assignability is not established for from -> to.")
        const explanationOptions: ErrorExplanationOptions = {
          code: 2322,
          message: compatibility.reason ?? `Type ${from} is not assignable to type ${to}.`,
          ...(packageName === undefined ? {} : { packageName }),
        }
        const explanation = await explainError(explanationOptions)
        if (explanation !== null) explanations.push(explanation)
      }
    }

    if (options.snippet === undefined) {
      gaps.push("No snippet was supplied, so Quartz did not verify a concrete call site.")
      nextSteps.add("Add a minimal snippet that exercises the proposed contract at a call site.")
    } else {
      const snippet = await checkSnippet(options.snippet, packageName)
      evidence.snippet = snippet
      checks.snippet = {
        ran: true,
        passed: snippet.valid,
        blocking: true,
        summary: snippet.valid ? "Snippet compiles under the package TypeScript project." : "Snippet has TypeScript errors.",
        evidence: snippet,
      }
      if (!snippet.valid) {
        gaps.push("The supplied snippet does not compile.")
        nextSteps.add("Repair the snippet until check-snippet returns valid: true.")
        const firstError = snippet.errors?.[0]
        if (firstError !== undefined) {
          const explanationOptions: ErrorExplanationOptions = {
            message: firstError.message,
            ...(packageName === undefined ? {} : { packageName }),
          }
          const explanation = await explainError(explanationOptions)
          if (explanation !== null) explanations.push(explanation)
        }
      }
    }

    if (options.includeDiagnostics !== false) {
      const diagnostics = asDiagnostics(await dependencies.diagnostics(packageName))
      const diagnosticEvidence = diagnostics.map(toVerifyDiagnostic)
      evidence.diagnostics = diagnosticEvidence
      checks.diagnostics = {
        ran: true,
        passed: diagnosticEvidence.length === 0,
        blocking: true,
        summary: diagnosticEvidence.length === 0 ? "Package diagnostics are clean." : `Package has ${diagnosticEvidence.length} TypeScript diagnostic(s).`,
        evidence: diagnosticEvidence,
      }
      if (diagnosticEvidence.length > 0) {
        gaps.push("The package has ambient TypeScript diagnostics.")
        nextSteps.add("Inspect diagnostics before trusting the contract in this project state.")
      }
    }

    if (from !== undefined && to !== undefined) {
      if (options.includeTransformEvidence === false) {
        gaps.push("Transform evidence was skipped by includeTransformEvidence: false.")
        if (symbol !== undefined) nextSteps.add("Enable transform evidence to verify that the requested symbol backs the contract.")
      } else {
        const transformOptions = {
          from,
          to,
          verifiedOnly: true as const,
          limit: options.transformLimit ?? 10,
          ...(packageName === undefined ? {} : { packageName }),
        }
        const transformSearch = await dependencies.transformSearch(transformOptions)
        evidence.transformSearch = transformSearch
        const verifiedResults = transformSearch.results.filter((result) => result.verification.status === "verified")
        const symbolMatched = symbol === undefined || verifiedResults.some((result) => result.name === symbol || result.name.endsWith(`.${symbol}`))
        const passed = verifiedResults.length > 0 && symbolMatched
        checks.transform = {
          ran: true,
          passed,
          blocking: true,
          summary: passed ? "A compiler-verified transform satisfies the requested contract." : symbol === undefined ? "No compiler-verified transform candidate matched the requested contract." : `No compiler-verified transform candidate matched the requested symbol '${symbol}'.`,
          evidence: transformSearch,
        }
        if (!passed) {
          gaps.push(symbol === undefined ? "No compiler-verified transform candidate matched the requested contract." : `No compiler-verified transform candidate matched the requested symbol '${symbol}'.`)
          nextSteps.add("Run transform-search with includeDiagnostics/includeSyntheticCode to inspect candidate verifier failures.")
        }
      }
    }

    if (explanations.length > 0) evidence.explanations = explanations
    const directAssignable = checks.compatibility.passed === true
    const transformPassed = checks.transform.passed === true
    const snippetOk = checks.snippet.passed !== false
    const diagnosticsOk = checks.diagnostics.passed !== false
    const hasFromTo = from !== undefined && to !== undefined
    const contractEvidenceOk = hasFromTo ? directAssignable || transformPassed : true
    const hasPositiveEvidence = directAssignable || transformPassed || checks.snippet.passed === true
    const blockingChecksPassed = Object.values(checks).every((check) => !check.blocking || check.passed === true)
    const ok = snippetOk && diagnosticsOk && contractEvidenceOk && hasPositiveEvidence && blockingChecksPassed
    if (!ok) nextSteps.add("Treat this contract as untrusted until a blocking check passes.")

    return {
      schemaVersion: "verify-contract/v1",
      ok,
      contract: { ...(from === undefined ? {} : { from }), ...(to === undefined ? {} : { to }), ...(symbol === undefined ? {} : { symbol }), package: context.package(packageName).name },
      checks,
      evidence,
      gaps,
      next_steps: [...nextSteps],
    }
  }

  return { checkSnippet, explainError, verifyContract }
}
