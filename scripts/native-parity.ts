/**
 * Native ↔ ts-morph parity harness.
 *
 * Runs every implemented analysis command through BOTH engines over the fixture
 * project and the `payloads/` inputs, then classifies each comparison as:
 *
 *   - identical    normalized envelopes match (the expected outcome)
 *   - improvement  native legitimately diverges by being more correct than
 *                  ts-morph (a documented behavior; see the allowlist below)
 *   - regression   any other divergence — fails closed
 *   - unsupported  native intentionally returns engine-not-supported (a stub
 *                  or infeasible sub-mode); documented, not a regression
 *
 * parityPassed is true iff zero regressions.
 *
 * Normalization matches the repo's native test suite (see
 * test/native-info-expand.test.ts / test/native-symbols-search.test.ts): union
 * members are order-insensitive, object keys are sorted, and commands whose
 * envelopes carry compiler prose that legitimately differs across the two
 * TypeScript versions (ts-morph's bundled compiler vs the 7.1 native nightly)
 * are compared on their load-bearing structure, exactly as those tests do.
 *
 * RUNTIME: the native engine spawns a `tsgo` child and reads Node-only child
 * fds, and its `typescript/unstable/sync` client must load UNBUNDLED so it can
 * resolve the tsgo binary from node_modules. That means this harness must run
 * under Node with the workspace resolved from source (the repo's Vitest/Vite
 * host) — not under Bun (native falls back to morph) and not against the bundled
 * dist (tsgo binary resolution fails). `runParity` is exported for that host.
 */
import { resolve } from "node:path"
import { readFileSync, existsSync, readdirSync } from "node:fs"
import { pathToFileURL } from "node:url"
import { Cause, Effect, Exit } from "effect"
import {
  createAnalyzerRuntime,
  createNativeTypeAnalyzer,
  isNativeRuntimeSupported,
  nativeAnalysisTypescriptVersion,
  analysisTypescriptVersionFor,
  type QuartzError,
  type TypeAnalyzer,
  type TypeInfo,
} from "@skastr0/quartz-core"

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export type Classification = "identical" | "improvement" | "difference" | "regression" | "unsupported"

export interface CaseReport {
  readonly id: string
  readonly command: string
  readonly source: "fixtures" | "payloads"
  readonly classification: Classification
  readonly morphOk: boolean
  readonly nativeOk: boolean
  readonly detail: string
}

export interface ParityReport {
  readonly root: string
  readonly morphAnalysisTypescriptVersion: string
  readonly nativeAnalysisTypescriptVersion: string
  readonly counts: Record<Classification, number> & { readonly total: number }
  readonly parityPassed: boolean
  readonly notes: readonly string[]
  readonly cases: readonly CaseReport[]
}

// ---------------------------------------------------------------------------
// Normalization (mirrors the native test suite)
// ---------------------------------------------------------------------------

/** Union members are order-insensitive across the two compilers. */
const sortUnion = (value: string): string =>
  value.includes(" | ") ? value.split(" | ").map((part) => part.trim()).sort().join(" | ") : value

const normalize = (value: unknown): unknown => {
  if (typeof value === "string") return sortUnion(value)
  if (Array.isArray(value)) return value.map(normalize)
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, nested]) => [key, normalize(nested)]))
  }
  return value
}

/** Stable, key-sorted serialization so object key order never causes a false diff. */
const stable = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stable)
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, nested]) => [key, stable(nested)]),
    )
  }
  return value
}

const canonical = (value: unknown): string => JSON.stringify(stable(normalize(value)))
const deepEqual = (a: unknown, b: unknown): boolean => canonical(a) === canonical(b)

// ---------------------------------------------------------------------------
// Command execution capture
// ---------------------------------------------------------------------------

type Outcome =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: string; readonly cause: unknown }

const runOutcome = async (
  analyzer: TypeAnalyzer,
  run: (a: TypeAnalyzer) => Effect.Effect<unknown, QuartzError>,
): Promise<Outcome> => {
  const exit = await Effect.runPromiseExit(run(analyzer))
  if (Exit.isSuccess(exit)) return { ok: true, value: exit.value }
  const squashed = Cause.squash(exit.cause) as { message?: string; cause?: unknown }
  return {
    ok: false,
    error: typeof squashed?.message === "string" ? squashed.message : String(squashed),
    cause: squashed?.cause,
  }
}

/** Stable native cause discriminant (packages/core/src/native/errors.ts: ENGINE_NOT_SUPPORTED). */
const ENGINE_NOT_SUPPORTED = "engine-not-supported"

const isEngineNotSupported = (outcome: Outcome): boolean =>
  !outcome.ok &&
  typeof outcome.cause === "object" &&
  outcome.cause !== null &&
  (outcome.cause as { kind?: unknown }).kind === ENGINE_NOT_SUPPORTED

// ---------------------------------------------------------------------------
// Per-command parity projections (the load-bearing structure to compare)
// ---------------------------------------------------------------------------

const asRecord = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {}

const searchSemantics = (value: unknown): unknown =>
  (Array.isArray(value) ? (value as TypeInfo[]) : []).map((result) => ({
    name: result.name,
    kind: result.kind,
    location: result.location,
    package: result.package,
    properties: result.properties
      ?.map((property) => ({ name: property.name, optional: property.optional ?? false }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  }))

const transformShape = (value: unknown): unknown => {
  const parsed = typeof value === "string" ? (JSON.parse(value) as unknown) : value
  const results = Array.isArray(asRecord(parsed)["results"]) ? (asRecord(parsed)["results"] as unknown[]) : []
  const names = results.map((r) => String(asRecord(r)["name"])).sort()
  const statuses = [
    ...new Set(results.map((r) => String(asRecord(asRecord(r)["verification"])["status"]))),
  ].sort()
  return { names, statuses }
}

const verifyContractShape = (value: unknown): unknown => {
  const record = asRecord(value)
  const checks = asRecord(record["checks"])
  const flag = (key: string): unknown => {
    const check = asRecord(checks[key])
    return { ran: check["ran"] ?? false, passed: check["passed"] ?? null, blocking: check["blocking"] ?? false }
  }
  return {
    ok: record["ok"] ?? null,
    contract: record["contract"] ?? null,
    checks: {
      compatibility: flag("compatibility"),
      snippet: flag("snippet"),
      diagnostics: flag("diagnostics"),
      transform: flag("transform"),
    },
  }
}

const explainErrorShape = (value: unknown): unknown => {
  const record = asRecord(value)
  const issues = Array.isArray(record["issues"]) ? (record["issues"] as unknown[]) : []
  return {
    code: asRecord(record["error"])["code"] ?? null,
    issueKinds: issues.map((issue) => String(asRecord(issue)["kind"])).sort(),
    hasSuggestions: Array.isArray(record["suggestions"]) && record["suggestions"].length > 0,
  }
}

const explainTypeShape = (value: unknown): unknown => {
  const record = asRecord(value)
  return {
    expression: record["expression"] ?? null,
    final: typeof record["final"] === "string" ? sortUnion(record["final"]) : record["final"],
    hasSteps: Array.isArray(record["steps"]) && record["steps"].length > 0,
  }
}

const graphShape = (value: unknown): unknown => {
  const record = asRecord(value)
  const edges = Array.isArray(record["edges"]) ? (record["edges"] as unknown[]) : []
  return {
    root: record["root"] ?? null,
    format: record["format"] ?? null,
    depth: record["depth"] ?? null,
    edges: edges
      .map((edge) => `${String(asRecord(edge)["from"])}|${String(asRecord(edge)["to"])}|${String(asRecord(edge)["label"] ?? "")}`)
      .sort(),
  }
}

const refactorShape = (value: unknown): unknown => {
  const record = asRecord(value)
  return {
    action: record["action"] ?? null,
    from: record["from"] ?? null,
    to: record["to"] ?? null,
    totalLocations: record["totalLocations"] ?? null,
  }
}

const relatedShape = (value: unknown): unknown => {
  const record = asRecord(value)
  const names = (key: string): string[] =>
    (Array.isArray(record[key]) ? (record[key] as unknown[]) : []).map((entry) => String(asRecord(entry)["symbol"])).sort()
  return { symbol: record["symbol"] ?? null, referencedBy: names("referencedBy"), references: names("references") }
}

/** Cross-compiler diagnostic wording/positions differ; compare validity + count. */
const snippetShape = (value: unknown): unknown => {
  const record = asRecord(value)
  return { valid: record["valid"] ?? null, errorCount: Array.isArray(record["errors"]) ? record["errors"].length : 0 }
}

/** Compatibility `reason` prose differs across compilers; the verdict is load-bearing. */
const compatibilityShape = (value: unknown): unknown => {
  const record = asRecord(value)
  return { compatible: record["compatible"] ?? null, from: record["from"] ?? null, to: record["to"] ?? null }
}

// ---------------------------------------------------------------------------
// Case definitions
// ---------------------------------------------------------------------------

interface ParityCase {
  readonly id: string
  readonly command: string
  readonly source: "fixtures" | "payloads"
  readonly run: (a: TypeAnalyzer) => Effect.Effect<unknown, QuartzError>
  readonly project?: (value: unknown) => unknown
}

/**
 * Documented native improvements over ts-morph. Keyed by case id; the value is
 * the citation. A divergence not on this list fails closed as a regression.
 */
const IMPROVEMENTS: Readonly<Record<string, string>> = {
  "eval:InternalConfig":
    "Native surfaces the semantic diagnostic as an error where ts-morph returns unresolved type text (documented in test/native-engine.test.ts:213-221).",
}

/**
 * Documented benign differences: native diverges symmetrically (neither clearly
 * better nor worse) with the load-bearing output preserved. Non-blocking — they
 * do not fail parity, but they are recorded so a reviewer sees them.
 */
const DIFFERENCES: Readonly<Record<string, string>> = {
  "eval:PickUser":
    'Native returns the alias in `result` (Pick<User, "id" | "name">) and the resolved literal in `expanded`; ts-morph resolves both fields. The evaluated type (`expanded`) is byte-identical — only the `result` echo differs.',
}

const fixtureCases: readonly ParityCase[] = [
  { id: "packages", command: "getPackages", source: "fixtures", run: (a) => a.getPackages() },
  { id: "symbols", command: "listSymbols", source: "fixtures", run: (a) => a.listSymbols({ pattern: "^User", limit: 25 }) },
  { id: "info:User", command: "getTypeInfo", source: "fixtures", run: (a) => a.getTypeInfo("User") },
  { id: "expand:User", command: "expandType", source: "fixtures", run: (a) => a.expandType("User") },
  { id: "related:ExtendedUser", command: "findRelated", source: "fixtures", run: (a) => a.findRelated("ExtendedUser"), project: relatedShape },
  { id: "search:Role", command: "searchTypes", source: "fixtures", run: (a) => a.searchTypes({ query: "Role", limit: 10 }), project: searchSemantics },
  { id: "eval:PickUser", command: "evalType", source: "fixtures", run: (a) => a.evalType('Pick<User, "id" | "name">') },
  { id: "eval:InternalConfig", command: "evalType", source: "fixtures", run: (a) => a.evalType("InternalConfig") },
  { id: "check-snippet:invalid", command: "checkSnippet", source: "fixtures", run: (a) => a.checkSnippet("const x: string = 42;"), project: snippetShape },
  { id: "check-snippet:valid", command: "checkSnippet", source: "fixtures", run: (a) => a.checkSnippet("const x: string = 'ok';"), project: snippetShape },
  { id: "file:basic", command: "getFileDeclarations", source: "fixtures", run: (a) => a.getFileDeclarations("types/basic.ts", { includePrivate: false }) },
  { id: "compatible:ExtendedUser-User", command: "checkCompatibility", source: "fixtures", run: (a) => a.checkCompatibility("ExtendedUser", "User"), project: compatibilityShape },
  { id: "diagnostics", command: "getDiagnostics", source: "fixtures", run: (a) => a.getDiagnostics() },
  { id: "at-position:basic", command: "getTypeAtPosition", source: "fixtures", run: (a) => a.getTypeAtPosition("types/basic.ts", 9, 3) },
  { id: "graph:ExtendedUser", command: "generateGraph", source: "fixtures", run: (a) => a.generateGraph("ExtendedUser", { depth: 2, format: "mermaid" }), project: graphShape },
  { id: "refactor:RefactorUser", command: "previewRefactor", source: "fixtures", run: (a) => a.previewRefactor({ action: "rename", symbol: "RefactorUser", to: "RenamedUser" }), project: refactorShape },
  {
    id: "why-error:2322",
    command: "explainError",
    source: "fixtures",
    run: (a) => a.explainError({ code: 2322, message: "Type 'UserInput' is not assignable to type 'User'. Property 'id' is missing in type 'UserInput' but required in type 'User'." }),
    project: explainErrorShape,
  },
  { id: "explain:PickUser", command: "explainType", source: "fixtures", run: (a) => a.explainType('Pick<User, "id" | "name">'), project: explainTypeShape },
  { id: "transform-search:User-UserDTO", command: "transformSearch", source: "fixtures", run: (a) => a.transformSearch({ from: "User", to: "UserDTO", limit: 5 }), project: transformShape },
  {
    id: "verify-contract:User-UserDTO",
    command: "verifyContract",
    source: "fixtures",
    run: (a) =>
      a.verifyContract({
        from: "User",
        to: "UserDTO",
        symbol: "toDTO",
        snippet: "const user: User = { id: '1', name: 'Ada', email: 'ada@example.com' }; const dto: UserDTO = toDTO(user);",
      }),
    project: verifyContractShape,
  },
]

/** Native stubs / infeasible sub-modes: documented gaps, verified to refuse cleanly. */
interface UnsupportedCase {
  readonly id: string
  readonly command: string
  readonly run: (a: TypeAnalyzer) => Effect.Effect<unknown, QuartzError>
}
const unsupportedCases: readonly UnsupportedCase[] = [
  { id: "refresh", command: "refresh", run: (a) => a.refresh() },
  { id: "markDirty", command: "markDirty", run: (a) => a.markDirty() },
  { id: "diagnostics:explain", command: "getDiagnostics(explain)", run: (a) => a.getDiagnostics({ explain: true }) },
]

// ---------------------------------------------------------------------------
// payloads/ ingestion — route each payload file to its analyzer method
// ---------------------------------------------------------------------------

const payloadCases = (payloadsDir: string): readonly ParityCase[] => {
  if (!existsSync(payloadsDir)) return []
  const cases: ParityCase[] = []
  for (const fileName of readdirSync(payloadsDir).filter((name) => name.endsWith(".json")).sort()) {
    const parsed = JSON.parse(readFileSync(resolve(payloadsDir, fileName), "utf8")) as unknown
    const id = `payload:${fileName}`
    if (Array.isArray(parsed)) {
      parsed.forEach((item, index) => {
        const symbol = asRecord(item)["symbol"]
        if (typeof symbol === "string") {
          cases.push({ id: `${id}[${index}]`, command: "getTypeInfo", source: "payloads", run: (a) => a.getTypeInfo(symbol) })
        }
      })
      continue
    }
    const record = asRecord(parsed)
    const from = record["from"]
    const to = record["to"]
    const symbol = record["symbol"]
    if (typeof from === "string" && typeof to === "string") {
      cases.push({
        id,
        command: "transformSearch",
        source: "payloads",
        run: (a) => a.transformSearch({ from, to, limit: typeof record["limit"] === "number" ? record["limit"] : 5 }),
        project: transformShape,
      })
    } else if (typeof symbol === "string" && (record["depth"] !== undefined || record["format"] !== undefined)) {
      cases.push({
        id,
        command: "generateGraph",
        source: "payloads",
        run: (a) =>
          a.generateGraph(symbol, {
            depth: typeof record["depth"] === "number" ? record["depth"] : 2,
            format: record["format"] === "dot" ? "dot" : "mermaid",
          }),
        project: graphShape,
      })
    } else if (typeof symbol === "string") {
      cases.push({ id, command: "getTypeInfo", source: "payloads", run: (a) => a.getTypeInfo(symbol) })
    }
  }
  return cases
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

const classify = (
  caseId: string,
  morph: Outcome,
  native: Outcome,
  project: (value: unknown) => unknown,
): { classification: Classification; detail: string } => {
  const improvement = IMPROVEMENTS[caseId]
  const difference = DIFFERENCES[caseId]

  const classifyDivergence = (base: string): { classification: Classification; detail: string } => {
    if (improvement !== undefined) return { classification: "improvement", detail: improvement }
    if (difference !== undefined) return { classification: "difference", detail: difference }
    return { classification: "regression", detail: `${base}; not a documented improvement or difference` }
  }

  if (morph.ok && native.ok) {
    if (deepEqual(project(morph.value), project(native.value))) {
      return { classification: "identical", detail: "normalized envelopes match" }
    }
    return classifyDivergence("envelopes diverge")
  }

  if (!morph.ok && !native.ok) {
    return { classification: "identical", detail: `both refuse (morph: ${morph.error}; native: ${native.error})` }
  }

  // Exactly one side succeeded.
  const which = morph.ok ? `native errored: ${(native as { error: string }).error}` : `morph errored: ${(morph as { error: string }).error}`
  return classifyDivergence(`only one engine succeeded (${which})`)
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

export const runParity = async (rootDirectory: string): Promise<ParityReport> => {
  const root = resolve(rootDirectory)
  if (!isNativeRuntimeSupported()) {
    throw new Error(
      "Native runtime is unavailable here (native requires Node with an unbundled typescript/unstable client). " +
        "Run this harness under the repo's Vitest/Vite host, not under Bun.",
    )
  }

  const payloadsDir = resolve(root, "..", "..", "payloads")
  const cases = [...fixtureCases, ...payloadCases(payloadsDir)]

  const morph = createAnalyzerRuntime(root, { QUARTZ_ENGINE: "morph" })
  const native = createNativeTypeAnalyzer(root)

  const reports: CaseReport[] = []
  const notes: string[] = []
  try {
    for (const parityCase of cases) {
      const morphOutcome = await runOutcome(morph.analyzer, parityCase.run)
      const nativeOutcome = await runOutcome(native.analyzer, parityCase.run)
      const project = parityCase.project ?? ((value: unknown) => value)
      const { classification, detail } = classify(parityCase.id, morphOutcome, nativeOutcome, project)
      reports.push({
        id: parityCase.id,
        command: parityCase.command,
        source: parityCase.source,
        classification,
        morphOk: morphOutcome.ok,
        nativeOk: nativeOutcome.ok,
        detail,
      })
      if (classification === "improvement") notes.push(`improvement @ ${parityCase.id} (${parityCase.command}): ${detail}`)
      if (classification === "difference") notes.push(`difference @ ${parityCase.id} (${parityCase.command}): ${detail}`)
      if (classification === "regression") notes.push(`REGRESSION @ ${parityCase.id} (${parityCase.command}): ${detail}`)
    }

    for (const unsupported of unsupportedCases) {
      const outcome = await runOutcome(native.analyzer, unsupported.run)
      const refused = isEngineNotSupported(outcome)
      reports.push({
        id: unsupported.id,
        command: unsupported.command,
        source: "fixtures",
        classification: refused ? "unsupported" : "regression",
        morphOk: true,
        nativeOk: outcome.ok,
        detail: refused
          ? "native returns engine-not-supported (documented stub/sub-mode)"
          : `expected engine-not-supported but native ${outcome.ok ? "succeeded" : `failed differently: ${(outcome as { error: string }).error}`}`,
      })
      if (refused) notes.push(`unsupported @ ${unsupported.id}: native returns engine-not-supported (documented)`)
      else notes.push(`REGRESSION @ ${unsupported.id}: expected a clean engine-not-supported refusal`)
    }
  } finally {
    await morph.dispose()
    await native.dispose()
  }

  const counts = reports.reduce(
    (acc, report) => ({ ...acc, [report.classification]: acc[report.classification] + 1 }),
    { identical: 0, improvement: 0, difference: 0, regression: 0, unsupported: 0 } as Record<Classification, number>,
  )
  const parityPassed = counts.regression === 0

  return {
    root,
    morphAnalysisTypescriptVersion: analysisTypescriptVersionFor("morph"),
    nativeAnalysisTypescriptVersion: nativeAnalysisTypescriptVersion(),
    counts: { ...counts, total: reports.length },
    parityPassed,
    notes,
    cases: reports,
  }
}

// ---------------------------------------------------------------------------
// Direct execution (in a compatible Node host)
// ---------------------------------------------------------------------------

const isEntrypoint = (): boolean => {
  const invoked = process.argv[1]
  return invoked !== undefined && import.meta.url === pathToFileURL(invoked).href
}

if (isEntrypoint()) {
  const root = process.argv[2] ?? resolve("test/fixtures")
  runParity(root)
    .then((report) => {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
      process.exitCode = report.parityPassed ? 0 : 1
    })
    .catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
      process.exitCode = 2
    })
}
