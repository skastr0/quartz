#!/usr/bin/env bun
import { mkdir, writeFile } from "node:fs/promises"
import { isAbsolute, join, relative, resolve } from "node:path"
import { Either, Effect, JSONSchema, ParseResult, Schema } from "effect"
import {
  analysisTypeScriptVersion,
  createTypeAnalyzer,
  QuartzEngineError,
} from "@skastr0/quartz-engine"
import type {
  ListSymbolsOptions,
  QuartzAnalyzer,
  SearchTypesOptions,
  VerifyContractOptions,
} from "@skastr0/quartz-engine"
import { defaultArtifactDirectory, quartzHome, QUARTZ_HOME_ENV } from "./runtime-storage"

const VERSION = "0.2.0-next.0"
const DEFAULT_CONCURRENCY = 5
const AUTO_ARTIFACT_THRESHOLD_BYTES = 8_000

const fitnessChecks = [
  {
    name: "Native engine behavior",
    command: "bun run verify:native-engine",
    protects: [
      "persistent workspace lifecycle and refresh semantics",
      "compiler-native analysis, references, transforms, and verification",
      "package selection, virtual files, and disposal",
    ],
  },
  {
    name: "Package boundaries",
    command: "bun run verify:package-boundaries",
    protects: [
      "published package export maps stay coherent",
      "packed package contents include required dist, README, and LICENSE files",
      "CLI and plugin build boundaries stay explicit",
    ],
  },
  {
    name: "Docs examples",
    command: "bun run verify:docs-examples",
    protects: [
      "public command examples remain executable",
      "schemas, input modes, artifacts, and batch semantics stay fresh",
      "transform verification and verify-contract examples keep their evidence shape",
    ],
  },
  {
    name: "Regression guard",
    command: "bun run verify:regression-guard",
    protects: [
      "native engine, docs examples, CLI/plugin wrappers, and property-style invariants run together",
      "agent-facing behavior remains covered by a single guard command",
    ],
  },
] as const

const ProjectRoot = Schema.NonEmptyString.pipe(Schema.brand("ProjectRoot"))
const PackageRef = Schema.NonEmptyString.pipe(Schema.brand("PackageRef"))
const SymbolName = Schema.NonEmptyString.pipe(Schema.brand("SymbolName"))
const FilePath = Schema.NonEmptyString.pipe(Schema.brand("FilePath"))
const TypeExpression = Schema.NonEmptyString.pipe(Schema.brand("TypeExpression"))
const PositiveInteger = Schema.Number.pipe(Schema.int(), Schema.positive())
const GraphFormat = Schema.Literal("mermaid", "dot")
const OutputPolicy = Schema.Literal("inline", "artifact", "auto")
const VerificationStatus = Schema.Literal("verified", "unverified", "unverifiable")

const baseFields = {
  root: Schema.optional(ProjectRoot),
  package: Schema.optional(PackageRef),
}

const PackagesPayload = Schema.Struct({
  root: Schema.optional(ProjectRoot),
})

const SymbolsPayload = Schema.Struct({
  ...baseFields,
  pattern: Schema.optional(Schema.NonEmptyString),
  kind: Schema.optional(Schema.NonEmptyString),
  file: Schema.optional(FilePath),
  limit: Schema.optional(PositiveInteger),
})

const SymbolPayload = Schema.Struct({
  ...baseFields,
  symbol: SymbolName,
})

const SearchPayload = Schema.Struct({
  ...baseFields,
  query: Schema.NonEmptyString,
  pattern: Schema.optional(Schema.NonEmptyString),
  hasProperty: Schema.optional(Schema.NonEmptyString),
  extends: Schema.optional(Schema.NonEmptyString),
  limit: Schema.optional(PositiveInteger),
})

const DiagnosticsPayload = Schema.Struct({
  ...baseFields,
  explain: Schema.optional(Schema.Boolean),
})

const AtPositionPayload = Schema.Struct({
  ...baseFields,
  file: FilePath,
  line: PositiveInteger,
  column: PositiveInteger,
})

const EvalPayload = Schema.Struct({
  ...baseFields,
  expression: TypeExpression,
})

const CheckSnippetPayload = Schema.Struct({
  ...baseFields,
  code: Schema.NonEmptyString,
})

const FilePayload = Schema.Struct({
  ...baseFields,
  file: FilePath,
  symbol: Schema.optional(SymbolName),
  includePrivate: Schema.optional(Schema.Boolean),
})

const CompatiblePayload = Schema.Struct({
  ...baseFields,
  from: TypeExpression,
  to: TypeExpression,
})

const GraphPayload = Schema.Struct({
  ...baseFields,
  symbol: SymbolName,
  depth: Schema.optional(PositiveInteger),
  format: Schema.optional(GraphFormat),
})

const RefactorPreviewPayload = Schema.Struct({
  ...baseFields,
  symbol: SymbolName,
  to: SymbolName,
})

const WhyErrorPayload = Schema.Struct({
  ...baseFields,
  code: Schema.optional(PositiveInteger),
  message: Schema.optional(Schema.NonEmptyString),
  file: Schema.optional(FilePath),
  line: Schema.optional(PositiveInteger),
})

const TransformSearchPayload = Schema.Struct({
  ...baseFields,
  from: Schema.optional(TypeExpression),
  to: Schema.optional(TypeExpression),
  paramPosition: Schema.optional(Schema.Union(PositiveInteger, Schema.Literal("any"))),
  unwrapReturn: Schema.optional(Schema.Boolean),
  exportedOnly: Schema.optional(Schema.Boolean),
  allowTypeErasure: Schema.optional(Schema.Boolean),
  verifiedOnly: Schema.optional(Schema.Boolean),
  minVerificationStatus: Schema.optional(VerificationStatus),
  includeDiagnostics: Schema.optional(Schema.Boolean),
  includeSyntheticCode: Schema.optional(Schema.Boolean),
  includeFailedVerification: Schema.optional(Schema.Boolean),
  limit: Schema.optional(PositiveInteger),
})

const VerifyContractPayload = Schema.Struct({
  ...baseFields,
  from: Schema.optional(TypeExpression),
  to: Schema.optional(TypeExpression),
  symbol: Schema.optional(SymbolName),
  snippet: Schema.optional(Schema.NonEmptyString),
  includeDiagnostics: Schema.optional(Schema.Boolean),
  includeTransformEvidence: Schema.optional(Schema.Boolean),
  transformLimit: Schema.optional(PositiveInteger),
})

const DoctorPayload = Schema.Struct({
  root: Schema.optional(ProjectRoot),
})

type CommandSchema<A> = Schema.Schema<A, any, never>
type AnyCommandSpec = CommandSpec<any>
type PackagesPayload = Schema.Schema.Type<typeof PackagesPayload>
type SymbolsPayload = Schema.Schema.Type<typeof SymbolsPayload>
type SymbolPayload = Schema.Schema.Type<typeof SymbolPayload>
type SearchPayload = Schema.Schema.Type<typeof SearchPayload>
type DiagnosticsPayload = Schema.Schema.Type<typeof DiagnosticsPayload>
type AtPositionPayload = Schema.Schema.Type<typeof AtPositionPayload>
type EvalPayload = Schema.Schema.Type<typeof EvalPayload>
type CheckSnippetPayload = Schema.Schema.Type<typeof CheckSnippetPayload>
type FilePayload = Schema.Schema.Type<typeof FilePayload>
type CompatiblePayload = Schema.Schema.Type<typeof CompatiblePayload>
type GraphPayload = Schema.Schema.Type<typeof GraphPayload>
type RefactorPreviewPayload = Schema.Schema.Type<typeof RefactorPreviewPayload>
type WhyErrorPayload = Schema.Schema.Type<typeof WhyErrorPayload>
type TransformSearchPayload = Schema.Schema.Type<typeof TransformSearchPayload>
type VerifyContractPayload = Schema.Schema.Type<typeof VerifyContractPayload>
type DoctorPayload = Schema.Schema.Type<typeof DoctorPayload>

class CommandInputError extends Schema.TaggedError<CommandInputError>()("CommandInputError", {
  message: Schema.String,
  details: Schema.optional(Schema.Unknown),
}) {}

class CommandExecutionError extends Schema.TaggedError<CommandExecutionError>()("CommandExecutionError", {
  message: Schema.String,
  details: Schema.optional(Schema.Unknown),
}) {}

class CommandTimeoutError extends Schema.TaggedError<CommandTimeoutError>()("CommandTimeoutError", {
  message: Schema.String,
  details: Schema.optional(Schema.Unknown),
}) {}

class NotFoundError extends Schema.TaggedError<NotFoundError>()("NotFoundError", {
  message: Schema.String,
  details: Schema.optional(Schema.Unknown),
}) {}

type CliError = CommandInputError | CommandExecutionError | CommandTimeoutError | NotFoundError | QuartzEngineError

interface ProtocolError {
  readonly type: string
  readonly message: string
  readonly details?: unknown
}

interface SuccessEnvelope<T> {
  readonly ok: true
  readonly command: string
  readonly data: T
}

interface FailureEnvelope {
  readonly ok: false
  readonly command?: string
  readonly error: ProtocolError
}

interface ArtifactRecord {
  readonly key: string
  readonly label: string
  readonly kind: "json"
  readonly absolute_path: string
  readonly relative_path: string
  readonly size_bytes: number
  readonly created_at: string
}

interface ArtifactResult {
  readonly kind: "summary+artifact"
  readonly summary: string
  readonly artifact: ArtifactRecord
}

type BatchOutcome = "succeeded" | "partial_failure" | "failed"

type BatchItem =
  | {
      readonly index: number
      readonly ok: true
      readonly target?: unknown
      readonly data: unknown
    }
  | {
      readonly index: number
      readonly ok: false
      readonly target?: unknown
      readonly error: ProtocolError
    }

interface BatchResult {
  readonly outcome: BatchOutcome
  readonly total: number
  readonly success_count: number
  readonly error_count: number
  readonly concurrency: number
  readonly results: readonly BatchItem[]
}

type FormatMode = "json" | "pretty"
type OutputPolicy = Schema.Schema.Type<typeof OutputPolicy>

interface ExecutionOptions {
  readonly output: OutputPolicy
  readonly format: FormatMode
  readonly concurrency: number
  readonly timeoutMs?: number
  readonly artifactDir?: string
}

interface ParsedCommand {
  readonly command: string
  readonly payloadSource?: string
  readonly selector?: string
  readonly options: ExecutionOptions
}

interface ResolvedCommandTokens {
  readonly command: string
  readonly rest: readonly string[]
}

interface ParsedExecutionInput {
  readonly options: ExecutionOptions
  readonly positionals: readonly string[]
}

interface CommandResult {
  readonly data: unknown
  readonly exitCode: number
}

interface CommandSpec<A> {
  readonly name: string
  readonly description: string
  readonly schema: CommandSchema<A>
  readonly batch: boolean
  readonly artifactEligible: boolean
  readonly example: unknown
  readonly execute: (payload: A) => Effect.Effect<unknown, CliError>
  readonly target: (payload: A) => unknown
}

interface PayloadWithRoot {
  readonly root?: string | undefined
}

interface PayloadWithPackage {
  readonly package?: string | undefined
}

const packageNameOf = (payload: PayloadWithPackage): string | undefined => payload.package
const rootOf = (payload: PayloadWithRoot): string => payload.root ?? process.cwd()
const cacheRootOf = (payload: PayloadWithRoot): string => resolve(rootOf(payload))
interface CachedAnalyzer {
  readonly analyzer: Promise<QuartzAnalyzer>
  readonly dispose: () => Promise<void>
}

const createCliAnalyzerRuntime = (root: string): CachedAnalyzer => {
  // Batch mode reuses this analyzer across items in one process (warm path).
  // One-shot CLI still pays cold open+exit cost when the process ends.
  const analyzer = createTypeAnalyzer(root, { collectTiming: process.env.QUARTZ_TIMING === "1" })
  return {
    analyzer,
    dispose: async () => {
      await (await analyzer).dispose()
    },
  }
}

const analyzersByRoot = new Map<string, CachedAnalyzer>()

const runtimeFor = (payload: PayloadWithRoot): CachedAnalyzer => {
  const root = cacheRootOf(payload)
  const cached = analyzersByRoot.get(root)
  if (cached !== undefined) return cached

  const runtime = createCliAnalyzerRuntime(root)
  analyzersByRoot.set(root, runtime)
  return runtime
}

const analyzerFor = (payload: PayloadWithRoot): Promise<QuartzAnalyzer> => runtimeFor(payload).analyzer

const callAnalyzer = <A>(
  payload: PayloadWithRoot,
  operation: (analyzer: QuartzAnalyzer) => Promise<A>,
): Effect.Effect<A, QuartzEngineError | CommandExecutionError> =>
  Effect.tryPromise({
    try: async () => operation(await analyzerFor(payload)),
    catch: (cause) =>
      cause instanceof QuartzEngineError
        ? cause
        : new CommandExecutionError({
            message: "Quartz engine operation failed",
            details: { cause: cause instanceof Error ? cause.message : String(cause), retryable: true },
          }),
  })

export const __testing = {
  analyzerFor,
  cacheRootOf,
  clearAnalyzerCache: async () => {
    await Promise.all([...analyzersByRoot.values()].map((runtime) => runtime.dispose()))
    analyzersByRoot.clear()
  },
  analyzerCacheSize: () => analyzersByRoot.size,
}

const packageField = (payload: PayloadWithPackage): { readonly packageName?: string } => {
  const packageName = packageNameOf(payload)
  return packageName === undefined ? {} : { packageName }
}

const requireFound = <A>(
  value: A | null,
  message: string,
  details: unknown,
): Effect.Effect<A, NotFoundError> =>
  value === null
    ? Effect.fail(
        new NotFoundError({
          message,
          details: {
            ...asRecord(details),
            retryable: false,
            next_step: "Check the target name and rerun the command.",
          },
        }),
      )
    : Effect.succeed(value)

const requireAnyField = <A extends Record<string, unknown>>(
  payload: A,
  fields: readonly (keyof A & string)[],
  hint: string,
): Effect.Effect<void, CommandInputError> => {
  if (fields.some((field) => payload[field] !== undefined)) return Effect.void
  return Effect.fail(
    new CommandInputError({
      message: `At least one of ${fields.join(", ")} is required`,
      details: {
        expected: fields,
        received: payload,
        hint,
        retryable: false,
      },
    }),
  )
}

const commandSpecs = {
  packages: {
    name: "packages",
    description: "List TypeScript packages discovered from tsconfig.json files.",
    schema: PackagesPayload,
    batch: false,
    artifactEligible: false,
    example: { root: "test/fixtures" },
    execute: (payload: PackagesPayload) => callAnalyzer(payload, (analyzer) => analyzer.getPackages()),
    target: (payload: PackagesPayload) => ({ root: rootOf(payload) }),
  } satisfies CommandSpec<PackagesPayload>,
  symbols: {
    name: "symbols",
    description: "List exported symbols with optional package, pattern, kind, file, and limit filters.",
    schema: SymbolsPayload,
    batch: true,
    artifactEligible: false,
    example: { root: "test/fixtures", pattern: "^User", limit: 25 },
    execute: (payload: SymbolsPayload) => {
      const options: Mutable<ListSymbolsOptions> = {}
      if (payload.pattern !== undefined) options.pattern = payload.pattern
      if (payload.kind !== undefined) options.kind = payload.kind
      if (payload.file !== undefined) options.file = payload.file
      if (payload.limit !== undefined) options.limit = payload.limit
      if (payload.package !== undefined) options.packageName = payload.package
      return callAnalyzer(payload, (analyzer) => analyzer.listSymbols(options))
    },
    target: (payload: SymbolsPayload) => ({ pattern: payload.pattern, kind: payload.kind, file: payload.file }),
  } satisfies CommandSpec<SymbolsPayload>,
  info: {
    name: "info",
    description: "Show type information for an exported symbol.",
    schema: SymbolPayload,
    batch: true,
    artifactEligible: false,
    example: { root: "test/fixtures", symbol: "User" },
    execute: (payload: SymbolPayload) =>
      callAnalyzer(payload, (analyzer) => analyzer.getTypeInfo(payload.symbol, packageNameOf(payload)))
        .pipe(Effect.flatMap((value) => requireFound(value, `Symbol not found: ${payload.symbol}`, { symbol: payload.symbol }))),
    target: (payload: SymbolPayload) => ({ symbol: payload.symbol }),
  } satisfies CommandSpec<SymbolPayload>,
  expand: {
    name: "expand",
    description: "Expand an exported symbol type.",
    schema: SymbolPayload,
    batch: true,
    artifactEligible: true,
    example: { root: "test/fixtures", symbol: "User" },
    execute: (payload: SymbolPayload) =>
      callAnalyzer(payload, (analyzer) => analyzer.expandType(payload.symbol, packageNameOf(payload)))
        .pipe(Effect.flatMap((value) => requireFound(value, `Symbol not found: ${payload.symbol}`, { symbol: payload.symbol }))),
    target: (payload: SymbolPayload) => ({ symbol: payload.symbol }),
  } satisfies CommandSpec<SymbolPayload>,
  search: {
    name: "search",
    description: "Search exported types by name.",
    schema: SearchPayload,
    batch: true,
    artifactEligible: false,
    example: { root: "test/fixtures", query: "Role", limit: 10 },
    execute: (payload: SearchPayload) => {
      const options: Mutable<SearchTypesOptions> = { query: payload.query }
      if (payload.pattern !== undefined) options.pattern = payload.pattern
      if (payload.hasProperty !== undefined) options.hasProperty = payload.hasProperty
      if (payload.extends !== undefined) options.extends = payload.extends
      if (payload.limit !== undefined) options.limit = payload.limit
      if (payload.package !== undefined) options.packageName = payload.package
      return callAnalyzer(payload, (analyzer) => analyzer.searchTypes(options))
    },
    target: (payload: SearchPayload) => ({
      query: payload.query,
      pattern: payload.pattern,
      hasProperty: payload.hasProperty,
      extends: payload.extends,
    }),
  } satisfies CommandSpec<SearchPayload>,
  diagnostics: {
    name: "diagnostics",
    description: "Show TypeScript diagnostics, optionally with explanations.",
    schema: DiagnosticsPayload,
    batch: true,
    artifactEligible: true,
    example: { root: "test/fixtures", explain: true },
    execute: (payload: DiagnosticsPayload) =>
      callAnalyzer(payload, (analyzer) => analyzer.getDiagnostics({
        ...packageField(payload),
        explain: payload.explain ?? false,
      })),
    target: (payload: DiagnosticsPayload) => ({ root: rootOf(payload), package: payload.package }),
  } satisfies CommandSpec<DiagnosticsPayload>,
  "at-position": {
    name: "at-position",
    description: "Show the type at a source position.",
    schema: AtPositionPayload,
    batch: true,
    artifactEligible: false,
    example: { root: "test/fixtures", file: "types/basic.ts", line: 9, column: 3 },
    execute: (payload: AtPositionPayload) =>
      callAnalyzer(payload, (analyzer) => analyzer.getTypeAtPosition(payload.file, payload.line, payload.column, packageNameOf(payload)))
        .pipe(
          Effect.flatMap((value) =>
            requireFound(value, `No source node found at ${payload.file}:${payload.line}:${payload.column}`, {
              file: payload.file,
              line: payload.line,
              column: payload.column,
            }),
          ),
        ),
    target: (payload: AtPositionPayload) => ({ file: payload.file, line: payload.line, column: payload.column }),
  } satisfies CommandSpec<AtPositionPayload>,
  related: {
    name: "related",
    description: "Find types that reference or are referenced by a symbol.",
    schema: SymbolPayload,
    batch: true,
    artifactEligible: false,
    example: { root: "test/fixtures", symbol: "User" },
    execute: (payload: SymbolPayload) =>
      callAnalyzer(payload, (analyzer) => analyzer.findRelated(payload.symbol, packageNameOf(payload)))
        .pipe(Effect.flatMap((value) => requireFound(value, `Symbol not found: ${payload.symbol}`, { symbol: payload.symbol }))),
    target: (payload: SymbolPayload) => ({ symbol: payload.symbol }),
  } satisfies CommandSpec<SymbolPayload>,
  eval: {
    name: "eval",
    description: "Evaluate a TypeScript type expression.",
    schema: EvalPayload,
    batch: true,
    artifactEligible: false,
    example: { root: "test/fixtures", expression: "Pick<User, \"id\" | \"name\">" },
    execute: (payload: EvalPayload) => callAnalyzer(payload, (analyzer) => analyzer.evalType(payload.expression, packageNameOf(payload))),
    target: (payload: EvalPayload) => ({ expression: payload.expression }),
  } satisfies CommandSpec<EvalPayload>,
  "check-snippet": {
    name: "check-snippet",
    description: "Type-check a code snippet without writing it to disk.",
    schema: CheckSnippetPayload,
    batch: true,
    artifactEligible: false,
    example: { root: "test/fixtures", code: "const x: string = 42;" },
    execute: (payload: CheckSnippetPayload) => callAnalyzer(payload, (analyzer) => analyzer.checkSnippet(payload.code, packageNameOf(payload))),
    target: () => ({ kind: "snippet" }),
  } satisfies CommandSpec<CheckSnippetPayload>,
  file: {
    name: "file",
    description: "Inspect declarations in a TypeScript file.",
    schema: FilePayload,
    batch: true,
    artifactEligible: true,
    example: { root: "test/fixtures", file: "types/basic.ts", includePrivate: false },
    execute: (payload: FilePayload) =>
      callAnalyzer(payload, (analyzer) => analyzer.getFileDeclarations(payload.file, {
        ...packageField(payload),
        ...(payload.symbol === undefined ? {} : { symbol: payload.symbol }),
        includePrivate: payload.includePrivate ?? false,
      }))
        .pipe(Effect.flatMap((value) => requireFound(value, `File not found: ${payload.file}`, { file: payload.file }))),
    target: (payload: FilePayload) => ({ file: payload.file }),
  } satisfies CommandSpec<FilePayload>,
  compatible: {
    name: "compatible",
    description: "Check whether one type is assignable to another.",
    schema: CompatiblePayload,
    batch: true,
    artifactEligible: false,
    example: { root: "test/fixtures", from: "ExtendedUser", to: "User" },
    execute: (payload: CompatiblePayload) =>
      callAnalyzer(payload, (analyzer) => analyzer.checkCompatibility(payload.from, payload.to, packageNameOf(payload))),
    target: (payload: CompatiblePayload) => ({ from: payload.from, to: payload.to }),
  } satisfies CommandSpec<CompatiblePayload>,
  graph: {
    name: "graph",
    description: "Generate a type dependency graph.",
    schema: GraphPayload,
    batch: true,
    artifactEligible: true,
    example: { root: "test/fixtures", symbol: "ExtendedUser", depth: 2, format: "mermaid" },
    execute: (payload: GraphPayload) =>
      callAnalyzer(payload, (analyzer) => analyzer.generateGraph(payload.symbol, {
        ...packageField(payload),
        depth: payload.depth ?? 2,
        format: payload.format ?? "mermaid",
      }))
        .pipe(Effect.flatMap((value) => requireFound(value, `Symbol not found: ${payload.symbol}`, { symbol: payload.symbol }))),
    target: (payload: GraphPayload) => ({ symbol: payload.symbol }),
  } satisfies CommandSpec<GraphPayload>,
  "refactor-preview": {
    name: "refactor-preview",
    description: "Preview a rename refactor without applying it.",
    schema: RefactorPreviewPayload,
    batch: true,
    artifactEligible: true,
    example: { root: "test/fixtures", symbol: "RefactorUser", to: "RenamedUser" },
    execute: (payload: RefactorPreviewPayload) =>
      callAnalyzer(payload, (analyzer) => analyzer.previewRefactor({
        action: "rename",
        symbol: payload.symbol,
        to: payload.to,
        ...packageField(payload),
      })),
    target: (payload: RefactorPreviewPayload) => ({ symbol: payload.symbol, to: payload.to }),
  } satisfies CommandSpec<RefactorPreviewPayload>,
  "why-error": {
    name: "why-error",
    description: "Explain a TypeScript diagnostic.",
    schema: WhyErrorPayload,
    batch: true,
    artifactEligible: true,
    example: {
      root: "test/fixtures",
      code: 2322,
      message: "Type 'UserInput' is not assignable to type 'User'.",
    },
    execute: (payload: WhyErrorPayload) =>
      requireAnyField(payload, ["code", "message"], "Provide a TypeScript diagnostic code or message.").pipe(
        Effect.flatMap(() =>
          callAnalyzer(payload, (analyzer) => analyzer.explainError({
            ...packageField(payload),
            ...(payload.code === undefined ? {} : { code: payload.code }),
            ...(payload.message === undefined ? {} : { message: payload.message }),
            ...(payload.file === undefined ? {} : { file: payload.file }),
            ...(payload.line === undefined ? {} : { line: payload.line }),
          }))
            .pipe(Effect.flatMap((value) => requireFound(value, "Diagnostic could not be explained", { code: payload.code }))),
        ),
      ),
    target: (payload: WhyErrorPayload) => ({ code: payload.code, message: payload.message }),
  } satisfies CommandSpec<WhyErrorPayload>,
  explain: {
    name: "explain",
    description: "Explain resolution of a TypeScript type expression.",
    schema: EvalPayload,
    batch: true,
    artifactEligible: true,
    example: { root: "test/fixtures", expression: "Pick<User, \"id\" | \"name\">" },
    execute: (payload: EvalPayload) => callAnalyzer(payload, (analyzer) => analyzer.explainType(payload.expression, packageNameOf(payload))),
    target: (payload: EvalPayload) => ({ expression: payload.expression }),
  } satisfies CommandSpec<EvalPayload>,
  "transform-search": {
    name: "transform-search",
    description: "Search functions by structural input/output type.",
    schema: TransformSearchPayload,
    batch: true,
    artifactEligible: true,
    example: { root: "test/fixtures", from: "User", to: "UserDTO", limit: 5 },
    execute: (payload: TransformSearchPayload) =>
      requireAnyField(payload, ["from", "to"], "Provide at least one of from or to.").pipe(
        Effect.flatMap(() => {
          const options: {
            readonly from?: string
            readonly to?: string
            readonly packageName?: string
            readonly paramPosition?: number | "any"
            readonly unwrapReturn?: boolean
            readonly exportedOnly?: boolean
            readonly allowTypeErasure?: boolean
            readonly verifiedOnly?: boolean
            readonly minVerificationStatus?: "verified" | "unverified" | "unverifiable"
            readonly includeDiagnostics?: boolean
            readonly includeSyntheticCode?: boolean
            readonly includeFailedVerification?: boolean
            readonly limit?: number
          } = {
            ...packageField(payload),
            ...(payload.from === undefined ? {} : { from: payload.from }),
            ...(payload.to === undefined ? {} : { to: payload.to }),
            ...(payload.paramPosition === undefined ? {} : { paramPosition: payload.paramPosition }),
            ...(payload.unwrapReturn === undefined ? {} : { unwrapReturn: payload.unwrapReturn }),
            ...(payload.exportedOnly === undefined ? {} : { exportedOnly: payload.exportedOnly }),
            ...(payload.allowTypeErasure === undefined ? {} : { allowTypeErasure: payload.allowTypeErasure }),
            ...(payload.verifiedOnly === undefined ? {} : { verifiedOnly: payload.verifiedOnly }),
            ...(payload.minVerificationStatus === undefined
              ? {}
              : { minVerificationStatus: payload.minVerificationStatus }),
            ...(payload.includeDiagnostics === undefined ? {} : { includeDiagnostics: payload.includeDiagnostics }),
            ...(payload.includeSyntheticCode === undefined ? {} : { includeSyntheticCode: payload.includeSyntheticCode }),
            ...(payload.includeFailedVerification === undefined
              ? {}
              : { includeFailedVerification: payload.includeFailedVerification }),
            ...(payload.limit === undefined ? {} : { limit: payload.limit }),
          }
          return callAnalyzer(payload, (analyzer) => analyzer.transformSearch(options))
        }),
    ),
    target: (payload: TransformSearchPayload) => ({ from: payload.from, to: payload.to }),
  } satisfies CommandSpec<TransformSearchPayload>,
  "verify-contract": {
    name: "verify-contract",
    description: "Compose compatibility, snippet, diagnostics, and transform evidence for a proposed type contract.",
    schema: VerifyContractPayload,
    batch: true,
    artifactEligible: true,
    example: {
      root: "test/fixtures",
      from: "User",
      to: "UserDTO",
      symbol: "toDTO",
      snippet: "const user: User = { id: '1', name: 'Ada', email: 'ada@example.com' }; const dto: UserDTO = toDTO(user);",
    },
    execute: (payload: VerifyContractPayload) =>
      requireAnyField(payload, ["from", "to", "snippet"], "Provide from/to types or a concrete snippet to verify.").pipe(
        Effect.flatMap(() => {
          const options: VerifyContractOptions = {
            ...packageField(payload),
            ...(payload.from === undefined ? {} : { from: payload.from }),
            ...(payload.to === undefined ? {} : { to: payload.to }),
            ...(payload.symbol === undefined ? {} : { symbol: payload.symbol }),
            ...(payload.snippet === undefined ? {} : { snippet: payload.snippet }),
            ...(payload.includeDiagnostics === undefined ? {} : { includeDiagnostics: payload.includeDiagnostics }),
            ...(payload.includeTransformEvidence === undefined
              ? {}
              : { includeTransformEvidence: payload.includeTransformEvidence }),
            ...(payload.transformLimit === undefined ? {} : { transformLimit: payload.transformLimit }),
          }
          return callAnalyzer(payload, (analyzer) => analyzer.verifyContract(options))
        }),
      ),
    target: (payload: VerifyContractPayload) => ({ from: payload.from, to: payload.to, symbol: payload.symbol }),
  } satisfies CommandSpec<VerifyContractPayload>,
  doctor: {
    name: "doctor",
    description: "Inspect local CLI health and project discovery.",
    schema: DoctorPayload,
    batch: false,
    artifactEligible: false,
    example: { root: "test/fixtures" },
    execute: (payload: DoctorPayload) =>
      callAnalyzer(payload, async (analyzer) => {
        let timing: unknown = null
        if (process.env.QUARTZ_TIMING === "1") {
          try {
            timing = await analyzer.getTimingInfo()
          } catch {
            timing = null
          }
        }
        return {
          metadata: analyzer.metadata,
          packages: await analyzer.getPackages(),
          timing,
        }
      }).pipe(
        Effect.map(({ metadata, packages, timing }) => ({
          version: VERSION,
          engine: "native",
          analysis_typescript_version: metadata.analysisTypescriptVersion,
          root: rootOf(payload),
          ok: true,
          package_count: packages.length,
          packages,
          ...(timing === null ? {} : { timing }),
          warm_path: {
            batch: "array payloads reuse one analyzer per root inside the process",
            plugin: "OpenCode plugin keeps one analyzer for the process lifetime",
            cold_cli: "each one-shot process opens and exits — do not claim plugin warm latency for isolated CLI",
          },
          input_modes: ["inline-json", "@file", "stdin"],
          fitness_checks: fitnessChecks,
          local_install: {
            bin: "quartz",
            build: "bun run cli:build",
            install: "bun run cli:install-local",
          },
        })),
      ),
    target: (payload: DoctorPayload) => ({ root: rootOf(payload) }),
  } satisfies CommandSpec<DoctorPayload>,
}

type CommandName = keyof typeof commandSpecs
type Mutable<T> = { -readonly [K in keyof T]: T[K] }

const commandNames = Object.keys(commandSpecs) as readonly CommandName[]

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}

const protocolError = (type: string, message: string, details?: unknown): ProtocolError =>
  details === undefined ? { type, message } : { type, message, details }

const toProtocolError = (error: unknown): ProtocolError => {
  const record = asRecord(error)
  const type = typeof record["_tag"] === "string" ? record["_tag"] : error instanceof Error ? error.name : "InternalError"
  const message =
    typeof record["message"] === "string"
      ? record["message"]
      : error instanceof Error
        ? error.message
        : String(error)
  const details = record["details"] ?? (record["cause"] === undefined ? undefined : { cause: String(record["cause"]) })
  return protocolError(type, message, details)
}

const parsePositiveInteger = (name: string, value: string): number => {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new CommandInputError({
      message: `${name} must be a positive integer`,
      details: {
        field: name,
        expected: "positive integer",
        received: value,
        retryable: false,
      },
    })
  }
  return parsed
}

const parseChoice = <A extends readonly string[]>(name: string, value: string, choices: A): A[number] => {
  if ((choices as readonly string[]).includes(value)) return value as A[number]
  throw new CommandInputError({
    message: `${name} must be one of: ${choices.join(", ")}`,
    details: {
      field: name,
      expected: choices,
      received: value,
      retryable: false,
    },
  })
}

const takeOptionValue = (argv: readonly string[], index: number, option: string): readonly [string, number] => {
  const current = argv[index]
  const inline = current?.includes("=") === true ? current.slice(current.indexOf("=") + 1) : undefined
  if (inline !== undefined) return [inline, index]
  const next = argv[index + 1]
  if (next === undefined || next.startsWith("--")) {
    throw new CommandInputError({
      message: `${option} requires a value`,
      details: { field: option, retryable: false },
    })
  }
  return [next, index + 1]
}

const resolveCommandTokens = (argv: readonly string[]): ResolvedCommandTokens => {
  const first = argv[0]
  if (first === undefined || first === "help" || first === "--help" || first === "-h") {
    return { command: "capabilities", rest: [] }
  }

  if (first !== "schema" && first !== "examples") {
    return { command: first, rest: argv.slice(1) }
  }

  const rest = argv.slice(1)
  const subcommand = rest[0]
  if (subcommand !== "list" && subcommand !== "show") {
    throw new CommandInputError({
      message: `${first} requires subcommand list or show`,
      details: {
        expected: [`${first} list`, `${first} show <name>`],
        received: argv.join(" "),
        retryable: false,
      },
    })
  }

  return { command: `${first} ${subcommand}`, rest: rest.slice(1) }
}

const assertKnownCommand = (command: string): void => {
  if (isKnownCommand(command)) return
  throw new CommandInputError({
    message: `Unknown command: ${command}`,
    details: {
      expected: [...commandNames, "capabilities", "schema list", "schema show", "examples list", "examples show"],
      received: command,
      retryable: false,
    },
  })
}

const parseExecutionInput = (tokens: readonly string[]): ParsedExecutionInput => {
  const options: Mutable<ExecutionOptions> = defaultExecutionOptions()
  const positionals: string[] = []

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]
    if (token === undefined) continue

    if (token === "--json") {
      options.format = "json"
      continue
    }
    if (token === "--pretty") {
      options.format = "pretty"
      continue
    }
    if (token.startsWith("--output")) {
      const [value, nextIndex] = takeOptionValue(tokens, i, "--output")
      options.output = parseChoice("--output", value, ["inline", "artifact", "auto"] as const)
      i = nextIndex
      continue
    }
    if (token.startsWith("--format")) {
      const [value, nextIndex] = takeOptionValue(tokens, i, "--format")
      options.format = parseChoice("--format", value, ["json", "pretty"] as const)
      i = nextIndex
      continue
    }
    if (token.startsWith("--concurrency")) {
      const [value, nextIndex] = takeOptionValue(tokens, i, "--concurrency")
      options.concurrency = parsePositiveInteger("--concurrency", value)
      i = nextIndex
      continue
    }
    if (token.startsWith("--timeout")) {
      const [value, nextIndex] = takeOptionValue(tokens, i, "--timeout")
      options.timeoutMs = parsePositiveInteger("--timeout", value)
      i = nextIndex
      continue
    }
    if (token.startsWith("--artifact-dir")) {
      const [value, nextIndex] = takeOptionValue(tokens, i, "--artifact-dir")
      options.artifactDir = value
      i = nextIndex
      continue
    }
    if (token.startsWith("--")) {
      throw new CommandInputError({
        message: `Unknown execution flag: ${token}`,
        details: {
          expected: ["--output", "--format", "--json", "--pretty", "--concurrency", "--timeout", "--artifact-dir"],
          received: token,
          hint: "Domain inputs belong in the JSON payload.",
          retryable: false,
        },
      })
    }
    positionals.push(token)
  }

  return { options, positionals }
}

const finalizeParsedCommand = (
  command: string,
  positionals: readonly string[],
  options: ExecutionOptions,
): ParsedCommand => {
  if (command === "schema show" || command === "examples show") {
    if (positionals.length !== 1) {
      throw new CommandInputError({
        message: `${command} requires exactly one name`,
        details: { expected: `${command} <name>`, received: positionals, retryable: false },
      })
    }
    const selector = positionals[0] as string
    return { command, selector, options }
  }

  if (command === "schema list" || command === "examples list" || command === "capabilities") {
    if (positionals.length !== 0) {
      throw new CommandInputError({
        message: `${command} does not accept a payload`,
        details: { received: positionals, retryable: false },
      })
    }
    return { command, options }
  }

  if (positionals.length > 1) {
    throw new CommandInputError({
      message: `${command} accepts at most one JSON payload source`,
      details: {
        expected: "inline JSON, @file, -, or no payload",
        received: positionals,
        retryable: false,
      },
    })
  }

  const payloadSource = positionals[0]
  return payloadSource === undefined ? { command, options } : { command, payloadSource, options }
}

const parseArgv = (argv: readonly string[]): ParsedCommand => {
  const { command, rest } = resolveCommandTokens(argv)
  assertKnownCommand(command)
  const { options, positionals } = parseExecutionInput(rest)
  return finalizeParsedCommand(command, positionals, options)
}

const defaultExecutionOptions = (): ExecutionOptions => ({
  output: "inline",
  format: "json",
  concurrency: DEFAULT_CONCURRENCY,
})

const isKnownCommand = (command: string): command is CommandName | "capabilities" | "schema list" | "schema show" | "examples list" | "examples show" =>
  command === "capabilities"
  || command === "schema list"
  || command === "schema show"
  || command === "examples list"
  || command === "examples show"
  || commandNames.includes(command as CommandName)

const readPayload = (source: string | undefined): Effect.Effect<unknown, CommandInputError> => {
  if (source === undefined) return Effect.succeed({})

  const readText =
    source === "-"
      ? Effect.tryPromise({
          try: () => Bun.stdin.text(),
          catch: (cause) =>
            new CommandInputError({
              message: "Failed to read JSON payload from stdin",
              details: { cause: String(cause), retryable: true },
            }),
        })
      : source.startsWith("@")
        ? Effect.tryPromise({
            try: () => Bun.file(resolve(source.slice(1))).text(),
            catch: (cause) =>
              new CommandInputError({
                message: `Failed to read JSON payload file: ${source}`,
                details: { path: source.slice(1), cause: String(cause), retryable: true },
              }),
          })
        : Effect.succeed(source)

  return readText.pipe(
    Effect.flatMap((text) =>
      Effect.try({
        try: () => JSON.parse(text) as unknown,
        catch: (cause) =>
          new CommandInputError({
            message: "Payload must be valid JSON",
            details: {
              source: source === "-" ? "stdin" : source.startsWith("@") ? "file" : "inline",
              received: text.slice(0, 500),
              cause: cause instanceof Error ? cause.message : String(cause),
              retryable: false,
            },
          }),
      }),
    ),
  )
}

const decodePayload = <A>(
  schema: CommandSchema<A>,
  raw: unknown,
  pathPrefix?: string,
): Effect.Effect<A, CommandInputError> =>
  Schema.decodeUnknown(schema, { errors: "all" })(raw).pipe(
    Effect.mapError(
      (error) =>
        new CommandInputError({
          message: "Payload failed schema validation",
          details: {
            issues: formatParseIssues(error, pathPrefix),
            received: raw,
            retryable: false,
          },
        }),
    ),
  )

const formatParseIssues = (error: ParseResult.ParseError, pathPrefix?: string): readonly Record<string, unknown>[] =>
  ParseResult.ArrayFormatter.formatErrorSync(error).map((issue) => {
    const path = issue.path.length === 0 ? undefined : issue.path.map(String).join(".")
    return {
      tag: issue._tag,
      ...(path === undefined ? {} : { path: pathPrefix === undefined ? path : `${pathPrefix}.${path}` }),
      ...(path === undefined && pathPrefix !== undefined ? { path: pathPrefix } : {}),
      message: issue.message,
    }
  })

const executeParsed = (parsed: ParsedCommand): Effect.Effect<CommandResult, CliError> => {
  switch (parsed.command) {
    case "capabilities":
      return Effect.succeed({ data: capabilities(), exitCode: 0 })
    case "schema list":
      return Effect.succeed({ data: schemaList(), exitCode: 0 })
    case "schema show":
      return showSchema(parsed.selector).pipe(Effect.map((data) => ({ data, exitCode: 0 })))
    case "examples list":
      return Effect.succeed({ data: examplesList(), exitCode: 0 })
    case "examples show":
      return showExample(parsed.selector).pipe(Effect.map((data) => ({ data, exitCode: 0 })))
    default:
      return executeDomainCommand(parsed, commandSpecs[parsed.command as CommandName] as AnyCommandSpec)
  }
}

const executeDomainCommand = (
  parsed: ParsedCommand,
  spec: AnyCommandSpec,
): Effect.Effect<CommandResult, CliError> =>
  readPayload(parsed.payloadSource).pipe(
    Effect.flatMap((raw) => {
      if (Array.isArray(raw)) {
        if (!spec.batch) {
          return Effect.fail(
            new CommandInputError({
              message: `${spec.name} expects a single payload object`,
              details: { expected: "object", received: "array", retryable: false },
            }),
          )
        }
        return executeBatch(spec, raw, parsed.options).pipe(
          Effect.map((batch) => ({
            data: batch,
            exitCode: batch.error_count > 0 ? 1 : 0,
          })),
        )
      }

      return decodePayload(spec.schema, raw).pipe(
        Effect.flatMap((payload) => runSpec(spec, payload, parsed.options)),
        Effect.map((data) => ({ data, exitCode: 0 })),
      )
    }),
  )

const executeBatch = <A>(
  spec: CommandSpec<A>,
  rawItems: readonly unknown[],
  options: ExecutionOptions,
): Effect.Effect<BatchResult, never> =>
  Effect.forEach(
    rawItems.map((raw, index) => ({ raw, index })),
    ({ raw, index }) =>
      decodePayload(spec.schema, raw, `items[${index}]`).pipe(
        Effect.flatMap((payload) =>
          runSpec(spec, payload, options).pipe(
            Effect.map(
              (data): BatchItem => ({
                index,
                ok: true,
                target: spec.target(payload),
                data,
              }),
            ),
          ),
        ),
        Effect.catchAll((error) =>
          Effect.succeed({
            index,
            ok: false,
            target: targetFromRaw(raw),
            error: toProtocolError(error),
          } satisfies BatchItem),
        ),
      ),
    { concurrency: options.concurrency },
  ).pipe(
    Effect.map((results) => {
      const successCount = results.filter((item) => item.ok).length
      const errorCount = results.length - successCount
      const outcome: BatchOutcome =
        errorCount === 0 ? "succeeded" : successCount === 0 ? "failed" : "partial_failure"
      return {
        outcome,
        total: results.length,
        success_count: successCount,
        error_count: errorCount,
        concurrency: options.concurrency,
        results,
      }
    }),
  )

const runSpec = <A>(
  spec: CommandSpec<A>,
  payload: A,
  options: ExecutionOptions,
): Effect.Effect<unknown, CliError> => {
  const effect = spec.execute(payload).pipe(
    Effect.flatMap((data) => materializeOutput(spec.name, data, options, spec.artifactEligible)),
  )
  if (options.timeoutMs === undefined) return effect
  return effect.pipe(
    Effect.timeoutFail({
      duration: `${options.timeoutMs} millis`,
      onTimeout: () =>
        new CommandTimeoutError({
          message: `${spec.name} timed out after ${options.timeoutMs}ms`,
          details: { timeout_ms: options.timeoutMs, retryable: true },
        }),
    }),
  )
}

const targetFromRaw = (raw: unknown): unknown => {
  const record = asRecord(raw)
  if (record["symbol"] !== undefined) return { symbol: record["symbol"] }
  if (record["file"] !== undefined) return { file: record["file"] }
  if (record["query"] !== undefined) return { query: record["query"] }
  if (record["from"] !== undefined || record["to"] !== undefined) return { from: record["from"], to: record["to"] }
  if (record["expression"] !== undefined) return { expression: record["expression"] }
  return undefined
}

const materializeOutput = (
  command: string,
  data: unknown,
  options: ExecutionOptions,
  artifactEligible: boolean,
): Effect.Effect<unknown, CommandExecutionError> => {
  const bytes = Buffer.byteLength(JSON.stringify(data), "utf8")
  const shouldArtifact =
    options.output === "artifact" || (options.output === "auto" && artifactEligible && bytes > AUTO_ARTIFACT_THRESHOLD_BYTES)
  if (!shouldArtifact) return Effect.succeed(data)
  return writeArtifact(command, data, options)
}

const writeArtifact = (
  command: string,
  data: unknown,
  options: ExecutionOptions,
): Effect.Effect<ArtifactResult, CommandExecutionError> =>
  Effect.tryPromise({
    try: async () => {
      const artifactDirectory = resolve(options.artifactDir ?? defaultArtifactDirectory())
      await mkdir(artifactDirectory, { recursive: true })

      const createdAt = new Date().toISOString()
      const safeTimestamp = createdAt.replace(/[:.]/g, "-")
      const safeCommand = command.replace(/\s+/g, "-")
      const absolutePath = join(artifactDirectory, `${safeTimestamp}-${safeCommand}.json`)
      const body = JSON.stringify(data, null, 2)
      await writeFile(absolutePath, `${body}\n`, "utf8")

      return {
        kind: "summary+artifact",
        summary: `${command} output written to artifact (${Buffer.byteLength(body, "utf8")} bytes).`,
        artifact: {
          key: `${safeCommand}.${safeTimestamp}`,
          label: `${command} output`,
          kind: "json",
          absolute_path: absolutePath,
          relative_path: isAbsolute(absolutePath) ? relative(process.cwd(), absolutePath) : absolutePath,
          size_bytes: Buffer.byteLength(body, "utf8"),
          created_at: createdAt,
        },
      }
    },
    catch: (cause) =>
      new CommandExecutionError({
        message: `Failed to write artifact for ${command}`,
        details: { cause: String(cause), retryable: true },
      }),
  })

const capabilities = () => ({
  name: "quartz",
  version: VERSION,
  engine: "native",
  analysis_typescript_version: analysisTypeScriptVersion,
  protocol: "agentic-cli/v1",
  input_modes: ["inline JSON", "@file", "stdin (-)"],
  execution_flags: {
    output: [...OutputPolicy.literals],
    format: ["json", "pretty"],
    concurrency: "positive integer, default 5",
    timeout: "positive integer milliseconds",
    artifact_dir: "explicit directory for artifact output; defaults to runtime_storage.artifact_dir",
  },
  runtime_storage: {
    home_env: QUARTZ_HOME_ENV,
    home: quartzHome(),
    artifact_dir: defaultArtifactDirectory(),
  },
  envelopes: {
    success: { ok: true, command: "<name>", data: {} },
    failure: { ok: false, command: "<name>", error: { type: "CommandInputError", message: "...", details: {} } },
    batch: {
      outcome: ["succeeded", "partial_failure", "failed"],
      exit_code: "1 when error_count > 0",
    },
  },
  commands: [
    ...commandNames.map((name) => {
      const spec = commandSpecs[name]
      return {
        name,
        description: spec.description,
        schema: name,
        batch: spec.batch,
        artifact_output: spec.artifactEligible,
      }
    }),
    { name: "capabilities", description: "Describe CLI protocol support.", schema: null, batch: false, artifact_output: false },
    { name: "schema list", description: "List available payload schemas.", schema: null, batch: false, artifact_output: false },
    { name: "schema show", description: "Show one payload schema contract.", schema: null, batch: false, artifact_output: false },
    { name: "examples list", description: "List example payloads.", schema: null, batch: false, artifact_output: false },
    { name: "examples show", description: "Show one example payload.", schema: null, batch: false, artifact_output: false },
  ],
})

const schemaList = () => ({
  schemas: commandNames.map((name) => ({
    name,
    description: commandSpecs[name].description,
    batch: commandSpecs[name].batch,
    artifact_output: commandSpecs[name].artifactEligible,
  })),
})

const showSchema = (name: string | undefined): Effect.Effect<unknown, CommandInputError> => {
  if (name === undefined || !commandNames.includes(name as CommandName)) {
    return Effect.fail(
      new CommandInputError({
        message: `Unknown schema: ${name ?? ""}`,
        details: { expected: commandNames, received: name, retryable: false },
      }),
    )
  }
  const spec = commandSpecs[name as CommandName]
  return Effect.succeed({
    name,
    description: spec.description,
    batch: spec.batch,
    artifact_output: spec.artifactEligible,
    json_schema: toJsonSchema(spec.schema),
    example: spec.example,
    input_modes: {
      inline: `quartz ${name} '${JSON.stringify(spec.example)}'`,
      file: `quartz ${name} @payload.json`,
      stdin: `cat payload.json | quartz ${name} -`,
    },
  })
}

const examplesList = () => ({
  examples: commandNames.map((name) => ({
    name,
    command: name,
    description: commandSpecs[name].description,
  })),
})

const showExample = (name: string | undefined): Effect.Effect<unknown, CommandInputError> => {
  if (name === undefined || !commandNames.includes(name as CommandName)) {
    return Effect.fail(
      new CommandInputError({
        message: `Unknown example: ${name ?? ""}`,
        details: { expected: commandNames, received: name, retryable: false },
      }),
    )
  }
  const spec = commandSpecs[name as CommandName]
  return Effect.succeed({
    name,
    command: spec.name,
    payload: spec.example,
    invocations: {
      inline: `quartz ${name} '${JSON.stringify(spec.example)}'`,
      file: `quartz ${name} @payload.json`,
      stdin: `cat payload.json | quartz ${name} -`,
    },
  })
}

const toJsonSchema = (schema: Schema.Schema.Any): unknown => {
  try {
    return JSONSchema.make(schema)
  } catch (error) {
    return {
      unavailable: true,
      reason: error instanceof Error ? error.message : String(error),
    }
  }
}

const emitSuccess = (
  command: string,
  result: CommandResult,
  format: FormatMode,
): Effect.Effect<number, never> => {
  const envelope: SuccessEnvelope<unknown> = {
    ok: true,
    command,
    data: result.data,
  }
  return writeEnvelope(Bun.stdout, envelope, format).pipe(Effect.as(result.exitCode))
}

const emitFailure = (
  command: string | undefined,
  error: unknown,
  format: FormatMode,
): Effect.Effect<number, never> => {
  const protocol = toProtocolError(error)
  const envelope: FailureEnvelope =
    command === undefined ? { ok: false, error: protocol } : { ok: false, command, error: protocol }
  return writeEnvelope(Bun.stderr, envelope, format).pipe(Effect.as(1))
}

const writeEnvelope = (
  destination: typeof Bun.stdout | typeof Bun.stderr,
  envelope: unknown,
  format: FormatMode,
): Effect.Effect<void, never> =>
  Effect.promise(() => Bun.write(destination, `${JSON.stringify(envelope, null, format === "pretty" ? 2 : 0)}\n`)).pipe(
    Effect.asVoid,
    Effect.catchAll(() => Effect.void),
  )

export const runCli = (argv: readonly string[]): Effect.Effect<number, never> =>
  Effect.gen(function* () {
    const parsedEither = yield* Effect.either(Effect.try({ try: () => parseArgv(argv), catch: (error) => error }))
    if (Either.isLeft(parsedEither)) {
      return yield* emitFailure(undefined, parsedEither.left, "json")
    }

    const parsed = parsedEither.right
    const resultEither = yield* Effect.either(executeParsed(parsed))
    if (Either.isLeft(resultEither)) {
      return yield* emitFailure(parsed.command, resultEither.left, parsed.options.format)
    }

    return yield* emitSuccess(parsed.command, resultEither.right, parsed.options.format)
  }).pipe(
    Effect.catchAllDefect((defect) =>
      emitFailure(undefined, new CommandExecutionError({ message: "Unexpected CLI defect", details: { defect: String(defect) } }), "json"),
    ),
  )

if (import.meta.main) {
  const exitCode = await Effect.runPromise(runCli(process.argv.slice(2)))
  process.exit(exitCode)
}
