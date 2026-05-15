import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, relative, resolve } from "node:path"
import { spawnSync } from "node:child_process"

type Classification = "pass" | "quartz-bug" | "repo-precondition" | "timeout" | "matrix-harness"

interface SelectedSymbol {
  readonly name: string
  readonly file?: string
  readonly line?: number
  readonly column?: number
  readonly kind?: string
  readonly packageName?: string
  readonly sourceLine?: string
}

interface AssertionResult {
  readonly ok: boolean
  readonly expectation: string
  readonly observed: string
}

interface MatrixCommandResult {
  readonly command: string
  readonly payload: unknown
  readonly flags: string[]
  readonly status: number | null
  readonly elapsedMs: number
  readonly ok: boolean
  readonly timedOut: boolean
  readonly classification: Classification
  readonly summary: string
  readonly assertions: readonly AssertionResult[]
}

interface MatrixRepoResult {
  readonly root: string
  readonly exists: boolean
  readonly selectedSymbol?: SelectedSymbol
  readonly sourceEvidence?: {
    readonly file: string
    readonly line: number
    readonly column: number
    readonly text: string
  }
  readonly results: readonly MatrixCommandResult[]
}

interface CommandInput {
  readonly command: string
  readonly payload: unknown
}

const repoRoot = process.cwd()
const cliEntry = "apps/cli/src/main.ts"
const envPath = (name: string): string | undefined => {
  const value = process.env[name]
  return value === undefined || value.trim() === "" ? undefined : value
}
const quartzHome = resolve(envPath("QUARTZ_HOME") ?? join(homedir(), ".config", "quartz"))
const artifactDir = resolve(envPath("QUARTZ_MATRIX_ARTIFACT_DIR") ?? join(quartzHome, "artifacts", "external-feature-matrix"))
const outputPath = join(artifactDir, "external-feature-matrix-results.json")
const summaryPath = join(artifactDir, "external-feature-matrix-summary.md")
const commandTimeoutMs = 20_000

const preferredRoots = [
  "/Users/guilhermecastro/Projects/typefully-cli",
  "/Users/guilhermecastro/Projects/firecrawl-cli",
  "/Users/guilhermecastro/Projects/agentic-cli-template",
  "/Users/guilhermecastro/Projects/Voyager/playground/convex-helpers",
]
const matrixRoots = process.env.QUARTZ_MATRIX_ROOTS?.split(":").filter(Boolean) ?? preferredRoots

const globalCommands: readonly CommandInput[] = [
  { command: "capabilities", payload: undefined },
  { command: "schema list", payload: undefined },
  { command: "schema show", payload: "file" },
  { command: "examples list", payload: undefined },
  { command: "examples show", payload: "file" },
]

const artifactEligibleCommands = new Set([
  "expand",
  "diagnostics",
  "file",
  "graph",
  "refactor-preview",
  "why-error",
  "explain",
  "transform-search",
])

const runCli = (command: string, payload?: unknown, selected?: SelectedSymbol): MatrixCommandResult => {
  console.error(`[matrix] ${command}`)
  const args = ["run", cliEntry, ...command.split(" ")]
  if (payload !== undefined) {
    args.push(command === "schema show" || command === "examples show" ? String(payload) : JSON.stringify(payload))
  }
  const flags = artifactEligibleCommands.has(command) ? ["--output", "auto"] : []
  args.push(...flags)

  const start = performance.now()
  const result = spawnSync("bun", args, {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: commandTimeoutMs,
    maxBuffer: 1024 * 1024 * 16,
  })
  const elapsedMs = Math.round(performance.now() - start)
  const output = result.stdout || result.stderr || ""
  const parsed = parseJson(output)
  const timedOut = isSpawnTimeout(result.error)
  const assertions = assertCommand(command, parsed, selected)
  const statusOk = result.status === 0
  const assertionOk = assertions.every((assertion) => assertion.ok)

  return {
    command,
    payload: payload ?? null,
    flags,
    status: result.status,
    elapsedMs,
    ok: statusOk && assertionOk && !timedOut,
    timedOut,
    classification: classifyResult({ statusOk, assertionOk, timedOut, parsed, command }),
    summary: summarizeOutput(parsed, output, result.error?.message),
    assertions,
  }
}

const classifyResult = (input: {
  readonly statusOk: boolean
  readonly assertionOk: boolean
  readonly timedOut: boolean
  readonly parsed: unknown
  readonly command: string
}): Classification => {
  if (input.timedOut) return "timeout"
  if (!input.statusOk) return "quartz-bug"
  if (input.command === "check-snippet" && isSnippetPrecondition(input.parsed)) return "repo-precondition"
  if (input.command === "transform-search" && resultCount(input.parsed) === 0) return "repo-precondition"
  if (!input.assertionOk) return "quartz-bug"
  return "pass"
}

const isSpawnTimeout = (error: unknown): boolean => {
  if (!error || typeof error !== "object") return false
  const record = error as Record<string, unknown>
  return record.code === "ETIMEDOUT" || /timed out|ETIMEDOUT/i.test(String(record.message ?? ""))
}

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

const parseNestedJson = (value: unknown): unknown => {
  if (typeof value !== "string") return value
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

const envelopeData = (parsed: unknown): unknown =>
  parsed && typeof parsed === "object" ? parseNestedJson((parsed as Record<string, unknown>).data) : null

const resultCount = (parsed: unknown): number => {
  const data = envelopeData(parsed)
  if (!data || typeof data !== "object") return 0
  const results = (data as Record<string, unknown>).results
  if (Array.isArray(results)) return results.length
  const stats = (data as Record<string, unknown>).stats
  const returned = stats && typeof stats === "object" ? (stats as Record<string, unknown>).returned : undefined
  return typeof returned === "number" ? returned : 0
}

const isSnippetPrecondition = (parsed: unknown): boolean => {
  const data = envelopeData(parsed)
  if (!data || typeof data !== "object") return false
  const object = data as Record<string, unknown>
  if (object.valid !== false || !Array.isArray(object.errors)) return false
  return object.errors.some((error) => {
    if (!error || typeof error !== "object") return false
    const message = String((error as Record<string, unknown>).message ?? "")
    return /Cannot find type definition file|Cannot find module/i.test(message)
  })
}

const summarizeOutput = (parsed: unknown, raw: string, error?: string): string => {
  if (error) return error
  if (parsed && typeof parsed === "object") {
    const value = parsed as Record<string, unknown>
    if (value.ok === false && value.error && typeof value.error === "object") {
      const err = value.error as Record<string, unknown>
      return `${String(err.type ?? "Error")}: ${String(err.message ?? "")}`.trim()
    }
    if (value.ok === true && typeof value.command === "string") return summarizeEnvelope(value)
    return "json"
  }
  return raw.slice(0, 240).replace(/\s+/g, " ").trim()
}

const summarizeEnvelope = (envelope: Record<string, unknown>): string => {
  const data = parseNestedJson(envelope.data)
  if (Array.isArray(data)) return `ok array(${data.length})`
  if (data && typeof data === "object") {
    const object = data as Record<string, unknown>
    if (Array.isArray(object.symbols)) return `ok symbols(${object.symbols.length})`
    if (Array.isArray(object.results)) return `ok results(${object.results.length})`
    if (Array.isArray(object.declarations)) return `ok declarations(${object.declarations.length})`
    if (typeof object.name === "string") return `ok ${object.name}`
    if (typeof object.valid === "boolean") return `ok valid=${object.valid}`
    if (typeof object.compatible === "boolean") return `ok compatible=${object.compatible}`
    if (typeof object.package_count === "number") return `ok packages=${object.package_count}`
    if (typeof object.kind === "string") return `ok ${object.kind}`
  }
  return "ok"
}

const assertCommand = (command: string, parsed: unknown, selected?: SelectedSymbol): readonly AssertionResult[] => {
  const envelope = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null
  const data = parseNestedJson(envelope?.data)
  const base = [{
    ok: envelope?.ok === true,
    expectation: "command returns success envelope",
    observed: envelope === null ? "non-json output" : `ok=${String(envelope.ok)}`,
  }]
  if (envelope?.ok !== true) return base

  switch (command) {
    case "capabilities":
      return [...base, assertPath(data, ["protocol"], "agentic-cli/v1")]
    case "schema list":
      return [...base, assertArrayPath(data, ["schemas"], "schemas are listed")]
    case "schema show":
      return [...base, assertPath(data, ["name"], "file")]
    case "examples list":
      return [...base, assertArrayPath(data, ["examples"], "examples are listed")]
    case "examples show":
      return [...base, assertPath(data, ["name"], "file")]
    case "packages":
      return [...base, assertArray(data, "package list is non-empty")]
    case "symbols":
      return [...base, assertArrayPath(data, ["symbols"], "symbol list is non-empty")]
    case "info":
      return selected === undefined ? base : [...base, assertPath(data, ["name"], selected.name), assertLocation(data, selected)]
    case "expand":
      return selected === undefined ? base : [...base, assertSymbolPath(data, ["original"], selected.name)]
    case "search":
      return selected === undefined ? base : [...base, assertSearchContains(data, selected.name)]
    case "diagnostics":
      return [...base, assertDiagnosticsShape(data)]
    case "at-position":
      return selected === undefined ? base : [...base, assertAtPosition(data, selected)]
    case "related":
      return selected === undefined ? base : [...base, assertPath(data, ["symbol"], selected.name)]
    case "eval":
      return [...base, assertObjectHasAny(data, ["result", "error"], "type evaluation returns result or error")]
    case "check-snippet":
      return [...base, assertPath(data, ["valid"], true)]
    case "file":
      return selected === undefined ? base : [...base, assertDeclarationsContain(data, selected.name)]
    case "compatible":
      return [...base, assertPath(data, ["compatible"], true)]
    case "graph":
      return selected === undefined ? base : [...base, assertPath(data, ["root"], selected.name)]
    case "refactor-preview":
      return [...base, assertObjectHasAny(data, ["changes", "edits", "files", "predictedErrors"], "refactor preview has structured output")]
    case "why-error":
      return [...base, assertObjectHasAny(data, ["explanation", "issues", "suggestions"], "why-error returns explanation structure")]
    case "explain":
      return [...base, assertObjectHasAny(data, ["final", "steps"], "type explanation returns final or steps")]
    case "transform-search":
      return [...base, assertObjectHasAny(data, ["results", "stats", "query", "message"], "transform search returns search structure")]
    case "doctor":
      return [...base, assertPath(data, ["ok"], true)]
    default:
      return base
  }
}

const valueAt = (value: unknown, path: readonly string[]): unknown =>
  path.reduce<unknown>((current, key) => current && typeof current === "object" ? (current as Record<string, unknown>)[key] : undefined, value)

const assertPath = (value: unknown, path: readonly string[], expected: unknown): AssertionResult => {
  const observed = valueAt(value, path)
  return {
    ok: observed === expected,
    expectation: `${path.join(".")} equals ${String(expected)}`,
    observed: String(observed),
  }
}

const assertSymbolPath = (value: unknown, path: readonly string[], expected: string): AssertionResult => {
  const observed = valueAt(value, path)
  const observedText = String(observed)
  return {
    ok: observedText === expected || observedText.startsWith(`${expected}<`),
    expectation: `${path.join(".")} names ${expected}`,
    observed: observedText,
  }
}

const assertArray = (value: unknown, expectation: string): AssertionResult => ({
  ok: Array.isArray(value) && value.length > 0,
  expectation,
  observed: Array.isArray(value) ? `array(${value.length})` : typeof value,
})

const assertArrayPath = (value: unknown, path: readonly string[], expectation: string): AssertionResult => {
  const observed = valueAt(value, path)
  return {
    ok: Array.isArray(observed) && observed.length > 0,
    expectation,
    observed: Array.isArray(observed) ? `array(${observed.length})` : typeof observed,
  }
}

const assertObjectHasAny = (value: unknown, keys: readonly string[], expectation: string): AssertionResult => {
  const object = value && typeof value === "object" ? value as Record<string, unknown> : null
  const present = object === null ? [] : keys.filter((key) => object[key] !== undefined)
  return {
    ok: present.length > 0,
    expectation,
    observed: present.length > 0 ? `keys=${present.join(",")}` : "missing expected keys",
  }
}

const assertLocation = (value: unknown, selected: SelectedSymbol): AssertionResult => {
  const location = valueAt(value, ["location"])
  const file = valueAt(location, ["file"])
  const line = valueAt(location, ["line"])
  return {
    ok: selected.file === undefined || (file === selected.file && line === selected.line),
    expectation: `info location matches source evidence ${selected.file ?? "unknown"}:${selected.line ?? "unknown"}`,
    observed: `${String(file)}:${String(line)}`,
  }
}

const assertSearchContains = (value: unknown, name: string): AssertionResult => {
  const items = Array.isArray(value) ? value : []
  const names = items.map((item) => item && typeof item === "object" ? String((item as Record<string, unknown>).name ?? "") : "")
  return {
    ok: names.includes(name),
    expectation: `search results include ${name}`,
    observed: names.slice(0, 5).join(", "),
  }
}

const assertDiagnosticsShape = (value: unknown): AssertionResult => ({
  ok: Array.isArray(value) || (value !== null && typeof value === "object" && typeof (value as Record<string, unknown>).totalErrors === "number"),
  expectation: "diagnostics returns raw array or explained diagnostic object",
  observed: Array.isArray(value) ? `array(${value.length})` : typeof value,
})

const assertAtPosition = (value: unknown, selected: SelectedSymbol): AssertionResult => {
  const text = JSON.stringify(value)
  return {
    ok: text.includes(selected.name) || text.includes(String(selected.kind ?? "")),
    expectation: `at-position near source evidence mentions ${selected.name} or ${selected.kind ?? "kind"}`,
    observed: text.slice(0, 160),
  }
}

const assertDeclarationsContain = (value: unknown, name: string): AssertionResult => {
  const declarations = valueAt(value, ["declarations"])
  const names = Array.isArray(declarations)
    ? declarations.map((item) => item && typeof item === "object" ? String((item as Record<string, unknown>).name ?? "") : "")
    : []
  return {
    ok: names.includes(name),
    expectation: `file declarations include ${name}`,
    observed: names.slice(0, 8).join(", "),
  }
}

const parseEnvelopeData = (command: string, payload?: unknown): unknown => {
  console.error(`[matrix] ${command} ${JSON.stringify(payload ?? {})}`)
  const args = ["run", cliEntry, ...command.split(" ")]
  if (payload !== undefined) args.push(JSON.stringify(payload))
  const result = spawnSync("bun", args, {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: commandTimeoutMs,
    maxBuffer: 1024 * 1024 * 16,
  })
  const parsed = parseJson(result.stdout)
  return envelopeData(parsed)
}

const chooseSymbol = (root: string): SelectedSymbol | undefined => {
  const data = parseEnvelopeData("symbols", { root, kind: "interface", limit: 100 })
    ?? parseEnvelopeData("symbols", { root, kind: "type", limit: 100 })
    ?? parseEnvelopeData("symbols", { root, kind: "class", limit: 100 })
    ?? parseEnvelopeData("symbols", { root, limit: 100 })
  if (!data || typeof data !== "object") return undefined
  const symbols = (data as Record<string, unknown>).symbols
  if (!Array.isArray(symbols)) return undefined

  for (const item of symbols) {
    if (!item || typeof item !== "object") continue
    const symbol = item as Record<string, unknown>
    const name = String(symbol.name ?? "")
    const file = typeof symbol.file === "string" ? symbol.file : undefined
    const line = typeof symbol.line === "number" ? symbol.line : undefined
    if (!name || file === undefined || line === undefined) continue
    const evidence = sourceEvidence(root, file, line, name)
    if (evidence === undefined) continue
    return {
      name,
      file,
      line,
      column: evidence.column,
      sourceLine: evidence.text,
      ...(typeof symbol.kind === "string" ? { kind: symbol.kind } : {}),
      ...(typeof symbol.package === "string" ? { packageName: symbol.package } : {}),
    }
  }

  return undefined
}

const sourceEvidence = (
  root: string,
  file: string,
  line: number,
  symbolName: string,
): { readonly column: number; readonly text: string } | undefined => {
  const path = join(root, file)
  if (!existsSync(path)) return undefined
  const text = readFileSync(path, "utf8").split(/\r?\n/)[line - 1]
  if (text === undefined) return undefined
  const index = text.indexOf(symbolName)
  return {
    column: index >= 0 ? index + 1 : 1,
    text: text.trim(),
  }
}

const repoCommands = (root: string, symbol: SelectedSymbol): readonly CommandInput[] => [
  { command: "packages", payload: { root } },
  { command: "symbols", payload: { root, limit: 25 } },
  { command: "info", payload: { root, symbol: symbol.name } },
  { command: "expand", payload: { root, symbol: symbol.name } },
  { command: "search", payload: { root, query: symbol.name.slice(0, Math.min(8, symbol.name.length)), limit: 10 } },
  { command: "diagnostics", payload: { root, explain: true } },
  { command: "at-position", payload: { root, file: symbol.file, line: symbol.line, column: symbol.column ?? 1 } },
  { command: "related", payload: { root, symbol: symbol.name } },
  { command: "eval", payload: { root, expression: `Partial<${symbol.name}>` } },
  { command: "check-snippet", payload: { root, code: "const value = 1 satisfies number;" } },
  { command: "file", payload: { root, file: symbol.file, includePrivate: false } },
  { command: "compatible", payload: { root, from: symbol.name, to: symbol.name } },
  { command: "graph", payload: { root, symbol: symbol.name, depth: 1, format: "mermaid" } },
  { command: "refactor-preview", payload: { root, symbol: symbol.name, to: `${symbol.name}RenamedForMatrix` } },
  {
    command: "why-error",
    payload: { root, code: 2322, message: `Type '${symbol.name}' is not assignable to type '${symbol.name}'.` },
  },
  { command: "explain", payload: { root, expression: `Partial<${symbol.name}>` } },
  {
    command: "transform-search",
    payload: {
      root,
      from: symbol.name,
      to: symbol.name,
      paramPosition: "any",
      unwrapReturn: true,
      exportedOnly: false,
      allowTypeErasure: true,
      limit: 5,
    },
  },
  { command: "doctor", payload: { root } },
]

const results = {
  generatedAt: new Date().toISOString(),
  repoRoot,
  commandTimeoutMs,
  rootsConsidered: matrixRoots,
  global: globalCommands.map(({ command, payload }) => runCli(command, payload)),
  repositories: [] as MatrixRepoResult[],
}

for (const root of matrixRoots) {
  console.error(`[matrix] repo ${root}`)
  if (!existsSync(root)) {
    results.repositories.push({
      root,
      exists: false,
      results: [{
        command: "repo-exists",
        payload: { root },
        flags: [],
        status: 1,
        elapsedMs: 0,
        ok: false,
        timedOut: false,
        classification: "matrix-harness",
        summary: "Configured external matrix root does not exist",
        assertions: [{
          ok: false,
          expectation: "configured external matrix root exists",
          observed: "missing",
        }],
      }],
    })
    continue
  }

  const symbol = chooseSymbol(root)
  if (symbol === undefined || symbol.file === undefined || symbol.line === undefined) {
    results.repositories.push({
      root,
      exists: true,
      results: [{
        command: "select-symbol",
        payload: { root },
        flags: [],
        status: 1,
        elapsedMs: 0,
        ok: false,
        timedOut: false,
        classification: "repo-precondition",
        summary: "Could not select a source-backed symbol for accuracy checks",
        assertions: [{
          ok: false,
          expectation: "repo has at least one source-backed exported symbol",
          observed: "none",
        }],
      }],
    })
    continue
  }

  const evidence = sourceEvidence(root, symbol.file, symbol.line, symbol.name)
  results.repositories.push({
    root,
    exists: true,
    selectedSymbol: symbol,
    ...(evidence === undefined ? {} : {
      sourceEvidence: {
        file: symbol.file,
        line: symbol.line,
        column: evidence.column,
        text: evidence.text,
      },
    }),
    results: repoCommands(root, symbol).map(({ command, payload }) => runCli(command, payload, symbol)),
  })
}

const hasPositiveTransformSearch = results.repositories.some((repo) =>
  repo.results.some((result) => result.command === "transform-search" && result.classification === "pass"),
)
if (!hasPositiveTransformSearch) {
  results.global.push({
    command: "matrix-transform-search-coverage",
    payload: { roots: matrixRoots },
    flags: [],
    status: 1,
    elapsedMs: 0,
    ok: false,
    timedOut: false,
    classification: "matrix-harness",
    summary: "External matrix did not produce any positive transform-search result",
    assertions: [{
      ok: false,
      expectation: "at least one external repository returns transform-search results",
      observed: "none",
    }],
  })
}

mkdirSync(artifactDir, { recursive: true })
writeFileSync(outputPath, JSON.stringify(results, null, 2) + "\n", "utf8")
writeFileSync(summaryPath, renderSummary(results), "utf8")

const actionableFailures = [
  ...results.global.filter((result) => ["quartz-bug", "timeout", "matrix-harness"].includes(result.classification)),
  ...results.repositories.flatMap((repo) =>
    repo.results.filter((result) => ["quartz-bug", "timeout", "matrix-harness"].includes(result.classification)),
  ),
]

console.log(JSON.stringify({
  output: displayPath(outputPath),
  summary: displayPath(summaryPath),
  repositories: results.repositories.length,
  commands: results.global.length + results.repositories.reduce((sum, repo) => sum + repo.results.length, 0),
  actionableFailures: actionableFailures.length,
}, null, 2))

if (actionableFailures.length > 0) {
  process.exitCode = 1
}

function displayPath(path: string): string {
  const fromRepo = relative(repoRoot, path)
  return fromRepo.startsWith("..") ? path : fromRepo
}

function renderSummary(matrix: typeof results): string {
  const commandResults = [
    ...matrix.global,
    ...matrix.repositories.flatMap((repo) => repo.results),
  ]
  const counts = commandResults.reduce<Record<Classification, number>>(
    (acc, result) => {
      acc[result.classification] += 1
      return acc
    },
    { pass: 0, "quartz-bug": 0, "repo-precondition": 0, timeout: 0, "matrix-harness": 0 },
  )
  const lines = [
    "# External Feature Matrix",
    "",
    `Generated: ${matrix.generatedAt}`,
    `Command timeout: ${matrix.commandTimeoutMs}ms`,
    `Repositories: ${matrix.repositories.length}`,
    `Commands: ${commandResults.length}`,
    "",
    "## Classification Counts",
    "",
    ...Object.entries(counts).map(([key, value]) => `- ${key}: ${value}`),
    "",
    "## Repositories",
    "",
  ]

  for (const repo of matrix.repositories) {
    lines.push(`### ${repo.root}`, "")
    if (repo.sourceEvidence) {
      lines.push(
        `- Selected symbol: ${repo.selectedSymbol?.name} (${repo.selectedSymbol?.kind ?? "unknown"})`,
        `- Source evidence: ${repo.sourceEvidence.file}:${repo.sourceEvidence.line}:${repo.sourceEvidence.column} \`${repo.sourceEvidence.text}\``,
      )
    }
    for (const result of repo.results) {
      lines.push(`- ${result.classification}: ${result.command} (${result.elapsedMs}ms) - ${result.summary}`)
      for (const assertion of result.assertions.filter((item) => !item.ok)) {
        lines.push(`  - failed: ${assertion.expectation}; observed ${assertion.observed}`)
      }
    }
    lines.push("")
  }

  lines.push("## Global Commands", "")
  for (const result of matrix.global) {
    lines.push(`- ${result.classification}: ${result.command} (${result.elapsedMs}ms) - ${result.summary}`)
  }
  lines.push("")
  return `${lines.join("\n")}\n`
}
