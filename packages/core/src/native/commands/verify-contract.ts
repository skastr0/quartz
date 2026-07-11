import { Effect } from "effect"
import type { TypeAnalyzer } from "../../analyzer"
import { parsePackageRef, parseSymbolRef, parseTypeExpressionRef } from "../../boundary-refs"
import type {
  ErrorExplanationResult,
  VerifyContractCheck,
  VerifyContractDiagnostic,
  VerifyContractEvidence,
  VerifyContractOptions,
  VerifyContractResult,
} from "../../project-types"
import type { NativeCommandContext } from "../context"
import { QuartzError } from "../../errors"
import type { TransformSearchResponse } from "../../transform-search"
import { checkCompatibility } from "./check-compatibility"
import { checkSnippet } from "./check-snippet"
import { explainError } from "./explain-error"
import { getDiagnostics } from "./get-diagnostics"
import { resolvePackage } from "../snippet-helpers"
import { transformSearch } from "./transform-search"

export const verifyContract =
  (ctx: NativeCommandContext): TypeAnalyzer["verifyContract"] =>
  (options) =>
    Effect.gen(function* () {
      const input = yield* Effect.try({
        try: () => parseOptions(options),
        catch: (cause) => new QuartzError({ message: "Could not parse verify-contract refs", cause }),
      })
      const packageName = input.packageName === undefined || input.packageName.length === 0 ? undefined : input.packageName
      const resolvedPackage = (yield* resolvePackage(ctx, packageName)).name
      const state = createState(input)
      yield* runCompatibility(ctx, state, resolvedPackage)
      yield* runSnippet(ctx, state, resolvedPackage)
      yield* runDiagnostics(ctx, state, resolvedPackage)
      yield* runTransformEvidence(ctx, state, resolvedPackage)
      return finalize(input, resolvedPackage, state)
    })

interface VerificationState {
  readonly input: VerifyContractOptions
  readonly checks: Record<"compatibility" | "snippet" | "diagnostics" | "transform", VerifyContractCheck>
  readonly evidence: VerifyContractEvidence
  readonly gaps: string[]
  readonly nextSteps: Set<string>
  readonly explanations: ErrorExplanationResult[]
}

const createState = (input: VerifyContractOptions): VerificationState => ({
  input,
  checks: {
    compatibility: skipped("Skipped because both from and to were not provided."),
    snippet: skipped("Skipped because no snippet was provided."),
    diagnostics: skipped("Skipped because includeDiagnostics was false."),
    transform: skipped("Skipped because both from and to were not provided."),
  },
  evidence: {},
  gaps: [],
  nextSteps: new Set<string>(),
  explanations: [],
})

const runCompatibility = (ctx: NativeCommandContext, state: VerificationState, packageName: string) =>
  Effect.gen(function* () {
    const { from, to } = state.input
    if (from === undefined && to === undefined) return
    if (from === undefined || to === undefined) {
      state.gaps.push("Only one side of the from/to contract was provided.")
      state.nextSteps.add("Provide both from and to to run compatibility and transform verification.")
      return
    }
    const compatibility = yield* checkCompatibility(ctx)(from, to, packageName)
    state.evidence.compatibility = compatibility
    state.checks.compatibility = {
      ran: true,
      passed: compatibility.compatible,
      blocking: false,
      summary: compatibility.compatible
        ? `${from} is directly assignable to ${to}.`
        : `${from} is not directly assignable to ${to}; verified transform evidence can still satisfy a conversion contract.`,
      evidence: compatibility,
    }
    if (compatibility.compatible) return
    state.gaps.push("Direct assignability is not established for from -> to.")
    const explanation = yield* explainError(ctx)({
      packageName,
      code: 2322,
      message: compatibility.reason ?? `Type ${from} is not assignable to type ${to}.`,
    }).pipe(Effect.catchAll(() => Effect.succeed(null)))
    if (explanation !== null) state.explanations.push(explanation)
  })

const runSnippet = (ctx: NativeCommandContext, state: VerificationState, packageName: string) =>
  Effect.gen(function* () {
    const source = state.input.snippet
    if (source === undefined) {
      state.gaps.push("No snippet was supplied, so Quartz did not verify a concrete call site.")
      state.nextSteps.add("Add a minimal snippet that exercises the proposed contract at a call site.")
      return
    }
    const snippet = yield* checkSnippet(ctx)(source, packageName)
    state.evidence.snippet = snippet
    state.checks.snippet = {
      ran: true,
      passed: snippet.valid,
      blocking: true,
      summary: snippet.valid ? "Snippet compiles under the package TypeScript project." : "Snippet has TypeScript errors.",
      evidence: snippet,
    }
    if (snippet.valid) return
    state.gaps.push("The supplied snippet does not compile.")
    state.nextSteps.add("Repair the snippet until check-snippet returns valid: true.")
    const firstError = snippet.errors?.[0]
    if (firstError === undefined) return
    const explanation = yield* explainError(ctx)({
      packageName,
      message: firstError.message,
    }).pipe(Effect.catchAll(() => Effect.succeed(null)))
    if (explanation !== null) state.explanations.push(explanation)
  })

const runDiagnostics = (ctx: NativeCommandContext, state: VerificationState, packageName: string) =>
  Effect.gen(function* () {
    if (state.input.includeDiagnostics === false) return
    const diagnostics = yield* getDiagnostics(ctx)(packageName)
    const diagnosticEvidence = Array.isArray(diagnostics) ? diagnostics.map(toVerifyDiagnostic) : []
    state.evidence.diagnostics = diagnosticEvidence
    state.checks.diagnostics = {
      ran: true,
      passed: diagnosticEvidence.length === 0,
      blocking: true,
      summary: diagnosticEvidence.length === 0
        ? "Package diagnostics are clean."
        : `Package has ${diagnosticEvidence.length} TypeScript diagnostic(s).`,
      evidence: diagnosticEvidence,
    }
    if (diagnosticEvidence.length === 0) return
    state.gaps.push("The package has ambient TypeScript diagnostics.")
    state.nextSteps.add("Inspect diagnostics before trusting the contract in this project state.")
  })

const runTransformEvidence = (ctx: NativeCommandContext, state: VerificationState, packageName: string) =>
  Effect.gen(function* () {
    const { from, to } = state.input
    const hasFromTo = from !== undefined && to !== undefined
    if (!hasFromTo) return
    if (state.input.includeTransformEvidence === false) {
      state.gaps.push("Transform evidence was skipped by includeTransformEvidence: false.")
      if (state.input.symbol !== undefined) state.nextSteps.add("Enable transform evidence to verify that the requested symbol backs the contract.")
      return
    }
    const transformText = yield* transformSearch(ctx)({
      from,
      to,
      verifiedOnly: true,
      limit: state.input.transformLimit ?? 10,
      packageName,
    })
    const transformResponse = parseTransformResponse(transformText)
    state.evidence.transformSearch = transformResponse
    const verifiedResults = transformResponse.results.filter((result) => result.verification.status === "verified")
    const symbolMatched = state.input.symbol === undefined
      ? true
      : verifiedResults.some((result) => result.name === state.input.symbol || result.name.endsWith(`.${state.input.symbol}`))
    const passed = verifiedResults.length > 0 && symbolMatched
    state.checks.transform = {
      ran: true,
      passed,
      blocking: true,
      summary: passed
        ? "A compiler-verified transform satisfies the requested contract."
        : state.input.symbol === undefined
          ? "No compiler-verified transform candidate matched the requested contract."
          : `No compiler-verified transform candidate matched the requested symbol '${state.input.symbol}'.`,
      evidence: transformResponse,
    }
    if (passed) return
    state.gaps.push(state.input.symbol === undefined
      ? "No compiler-verified transform candidate matched the requested contract."
      : `No compiler-verified transform candidate matched the requested symbol '${state.input.symbol}'.`)
    state.nextSteps.add("Run transform-search with includeDiagnostics/includeSyntheticCode to inspect candidate verifier failures.")
  })

const finalize = (input: VerifyContractOptions, packageName: string, state: VerificationState): VerifyContractResult => {
  if (state.explanations.length > 0) state.evidence.explanations = state.explanations
  const directAssignable = state.checks.compatibility.passed === true
  const transformPassed = state.checks.transform.passed === true
  const snippetOk = state.checks.snippet.passed !== false
  const diagnosticsOk = state.checks.diagnostics.passed !== false
  const hasFromTo = input.from !== undefined && input.to !== undefined
  const contractEvidenceOk = hasFromTo ? directAssignable || transformPassed : true
  const hasPositiveEvidence = directAssignable || transformPassed || state.checks.snippet.passed === true
  const ok = snippetOk && diagnosticsOk && contractEvidenceOk && hasPositiveEvidence
  if (!ok) state.nextSteps.add("Treat this contract as untrusted until a blocking check passes.")

  return {
    schemaVersion: "verify-contract/v1",
    ok,
    contract: {
      ...(input.from === undefined ? {} : { from: input.from }),
      ...(input.to === undefined ? {} : { to: input.to }),
      ...(input.symbol === undefined ? {} : { symbol: input.symbol }),
      package: packageName,
    },
    checks: state.checks,
    evidence: state.evidence,
    gaps: state.gaps,
    next_steps: [...state.nextSteps],
  }
}

const parseOptions = (options: VerifyContractOptions): VerifyContractOptions => {
  const packageName = options.packageName?.trim()
  return {
    ...(options.from === undefined ? {} : { from: parseTypeExpressionRef("from", options.from) }),
    ...(options.to === undefined ? {} : { to: parseTypeExpressionRef("to", options.to) }),
    ...(options.symbol === undefined ? {} : { symbol: parseSymbolRef("symbol", options.symbol) }),
    ...(packageName === undefined || packageName.length === 0 ? {} : { packageName: parsePackageRef(packageName) }),
    ...(options.snippet === undefined ? {} : { snippet: options.snippet }),
    ...(options.includeDiagnostics === undefined ? {} : { includeDiagnostics: options.includeDiagnostics }),
    ...(options.includeTransformEvidence === undefined ? {} : { includeTransformEvidence: options.includeTransformEvidence }),
    ...(options.transformLimit === undefined ? {} : { transformLimit: options.transformLimit }),
  }
}

const skipped = (summary: string): VerifyContractCheck => ({ ran: false, passed: null, blocking: false, summary })

const toVerifyDiagnostic = (diagnostic: { readonly file?: string; readonly line?: number; readonly column?: number; readonly message: string; readonly code: number }): VerifyContractDiagnostic => ({
  file: diagnostic.file ?? "",
  line: diagnostic.line ?? 1,
  column: diagnostic.column ?? 1,
  message: diagnostic.message,
  code: diagnostic.code,
})

type NativeTransformResponse = TransformSearchResponse

const parseTransformResponse = (text: string): NativeTransformResponse => {
  const parsed = JSON.parse(text) as Partial<NativeTransformResponse>
  return {
    results: Array.isArray(parsed.results) ? parsed.results : [],
    query: parsed.query ?? { from: null, to: null, options: { paramPosition: "any", unwrapReturn: false, exportedOnly: true } },
    stats: parsed.stats ?? {
      totalCandidates: 0,
      assignableMatches: 0,
      verifiedMatches: 0,
      verification: { verified: 0, unverified: 0, unverifiable: 0 },
      returned: 0,
      timing: { indexLookupMs: 0, resolutionMs: 0, assignabilityMs: 0, syntheticMs: 0, totalMs: 0 },
    },
  } as NativeTransformResponse
}
