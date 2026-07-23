import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import { createTypeAnalyzer } from "@skastr0/quartz-engine"
import type { QuartzAnalyzer } from "@skastr0/quartz-engine"

const optionalPackageArg = tool.schema
  .string()
  .optional()
  .describe("Package/directory to analyze. Omit for root or single-package projects.")

const limitArg = tool.schema.number().optional().describe("Maximum number of results")
const json = (value: unknown) => JSON.stringify(value, null, 2)
const FILE_MODIFYING_TOOLS = new Set(["edit", "morph-mcp_edit_file", "write"])

const packageOption = (packageName: string | undefined): { readonly packageName?: string } =>
  packageName === undefined ? {} : { packageName }

const optionalOption = <K extends string, V>(
  key: K,
  value: V | undefined,
): V extends undefined ? Record<never, never> : { readonly [P in K]?: V } =>
  (value === undefined ? {} : { [key]: value }) as V extends undefined ? Record<never, never> : { readonly [P in K]?: V }

const createDiscoveryTools = (analyzer: QuartzAnalyzer) => ({
  type_packages: tool({
    description: "List TypeScript packages discovered from tsconfig.json files.",
    args: {},
    async execute() {
      return json(await analyzer.getPackages())
    },
  }),
  type_symbols: tool({
    description: "List exported TypeScript symbols.",
    args: {
      package: optionalPackageArg,
      pattern: tool.schema.string().optional().describe("Case-insensitive regex pattern"),
      kind: tool.schema.string().optional().describe("Symbol kind, such as interface, type, class, or function"),
      limit: limitArg,
    },
    async execute(args) {
      return json(
        await analyzer.listSymbols({
          ...packageOption(args.package),
          ...optionalOption("pattern", args.pattern),
          ...optionalOption("kind", args.kind),
          ...optionalOption("limit", args.limit),
        }),
      )
    },
  }),
  type_info: tool({
    description: "Show type information for an exported TypeScript symbol.",
    args: {
      symbol: tool.schema.string().describe("Exported symbol name"),
      package: optionalPackageArg,
    },
    async execute(args) {
      return json(await analyzer.getTypeInfo(args.symbol, args.package))
    },
  }),
  type_expand: tool({
    description: "Expand an exported TypeScript symbol type.",
    args: {
      symbol: tool.schema.string().describe("Exported symbol name"),
      package: optionalPackageArg,
    },
    async execute(args) {
      return json(await analyzer.expandType(args.symbol, args.package))
    },
  }),
  type_related: tool({
    description: "Find types that reference or are referenced by a TypeScript symbol.",
    args: {
      symbol: tool.schema.string().describe("Exported symbol name"),
      package: optionalPackageArg,
    },
    async execute(args) {
      return json(await analyzer.findRelated(args.symbol, args.package))
    },
  }),
  type_search: tool({
    description: "Search exported types by name, property, or base type.",
    args: {
      query: tool.schema.string().describe("Case-insensitive symbol query"),
      package: optionalPackageArg,
      pattern: tool.schema.string().optional().describe("Case-insensitive regex pattern"),
      hasProperty: tool.schema.string().optional().describe("Only include types with this property"),
      extends: tool.schema.string().optional().describe("Only include types extending this base symbol"),
      limit: limitArg,
    },
    async execute(args) {
      return json(
        await analyzer.searchTypes({
          query: args.query,
          ...optionalOption("pattern", args.pattern),
          ...optionalOption("hasProperty", args.hasProperty),
          ...optionalOption("extends", args.extends),
          ...packageOption(args.package),
          ...optionalOption("limit", args.limit),
        }),
      )
    },
  }),
})

const createAnalysisTools = (analyzer: QuartzAnalyzer) => ({
  type_eval: tool({
    description: "Evaluate a TypeScript type expression and return the computed type.",
    args: {
      expression: tool.schema.string().describe("TypeScript type expression"),
      package: optionalPackageArg,
    },
    async execute(args) {
      return json(await analyzer.evalType(args.expression, args.package))
    },
  }),
  type_diagnostics: tool({
    description: "Show TypeScript diagnostics.",
    args: {
      package: optionalPackageArg,
      explain: tool.schema.boolean().optional().describe("Include explanations for diagnostics"),
    },
    async execute(args) {
      return json(
        await analyzer.getDiagnostics({
          ...packageOption(args.package),
          ...optionalOption("explain", args.explain),
        }),
      )
    },
  }),
  type_check_snippet: tool({
    description: "Type-check a TypeScript code snippet without writing to disk.",
    args: {
      code: tool.schema.string().describe("TypeScript code snippet"),
      package: optionalPackageArg,
    },
    async execute(args) {
      return json(await analyzer.checkSnippet(args.code, args.package))
    },
  }),
  type_at_position: tool({
    description: "Show the type at a TypeScript source position.",
    args: {
      file: tool.schema.string().describe("TypeScript file path"),
      line: tool.schema.number().describe("One-based line number"),
      column: tool.schema.number().describe("One-based column number"),
      package: optionalPackageArg,
    },
    async execute(args) {
      return json(await analyzer.getTypeAtPosition(args.file, args.line, args.column, args.package))
    },
  }),
  type_file: tool({
    description: "Inspect declarations in a specific TypeScript file.",
    args: {
      file: tool.schema.string().describe("TypeScript file path"),
      symbol: tool.schema.string().optional().describe("Optional declaration name regex"),
      includePrivate: tool.schema.boolean().optional().describe("Include non-exported declarations"),
      package: optionalPackageArg,
    },
    async execute(args) {
      return json(
        await analyzer.getFileDeclarations(args.file, {
          ...packageOption(args.package),
          ...optionalOption("symbol", args.symbol),
          ...optionalOption("includePrivate", args.includePrivate),
        }),
      )
    },
  }),
  type_refresh: tool({
    description: "Clear cached TypeScript projects to pick up external file changes.",
    args: {
      package: optionalPackageArg,
    },
    async execute(args) {
      return await analyzer.refresh(args.package)
    },
  }),
})

const createRelationshipTools = (analyzer: QuartzAnalyzer) => ({
  ...createCompatibilityTools(analyzer),
  ...createGraphTools(analyzer),
  ...createRefactorTools(analyzer),
  ...createExplanationTools(analyzer),
  ...createTransformSearchTools(analyzer),
  ...createVerifyContractTools(analyzer),
})

const createCompatibilityTools = (analyzer: QuartzAnalyzer) => ({
  type_compatible: tool({
    description: "Check if one type is assignable to another.",
    args: {
      from: tool.schema.string().describe("Source type or symbol"),
      to: tool.schema.string().describe("Target type or symbol"),
      package: optionalPackageArg,
    },
    async execute(args) {
      return json(await analyzer.checkCompatibility(args.from, args.to, args.package))
    },
  }),
})

const createGraphTools = (analyzer: QuartzAnalyzer) => ({
  type_graph: tool({
    description: "Generate a type dependency graph as Mermaid or DOT.",
    args: {
      symbol: tool.schema.string().describe("Root symbol"),
      depth: tool.schema.number().optional().describe("Traversal depth"),
      format: tool.schema.enum(["mermaid", "dot"]).optional().describe("Graph output format"),
      package: optionalPackageArg,
    },
    async execute(args) {
      return json(
        await analyzer.generateGraph(args.symbol, {
          ...packageOption(args.package),
          ...optionalOption("depth", args.depth),
          ...optionalOption("format", args.format),
        }),
      )
    },
  }),
})

const createRefactorTools = (analyzer: QuartzAnalyzer) => ({
  type_refactor_preview: tool({
    description: "Preview a rename refactor without applying it.",
    args: {
      symbol: tool.schema.string().describe("Symbol to rename"),
      to: tool.schema.string().describe("New name"),
      package: optionalPackageArg,
    },
    async execute(args) {
      return json(
        await analyzer.previewRefactor({
          action: "rename",
          symbol: args.symbol,
          to: args.to,
          ...packageOption(args.package),
        }),
      )
    },
  }),
})

const createExplanationTools = (analyzer: QuartzAnalyzer) => ({
  type_why_error: tool({
    description: "Explain a TypeScript diagnostic in human terms.",
    args: {
      code: tool.schema.number().optional().describe("TypeScript diagnostic code"),
      message: tool.schema.string().optional().describe("Diagnostic message"),
      file: tool.schema.string().optional().describe("File path with the diagnostic"),
      line: tool.schema.number().optional().describe("One-based diagnostic line"),
      package: optionalPackageArg,
    },
    async execute(args) {
      return json(
        await analyzer.explainError({
          ...packageOption(args.package),
          ...optionalOption("code", args.code),
          ...optionalOption("message", args.message),
          ...optionalOption("file", args.file),
          ...optionalOption("line", args.line),
        }),
      )
    },
  }),
  type_explain: tool({
    description: "Show step-by-step resolution of a complex TypeScript type expression.",
    args: {
      expression: tool.schema.string().describe("TypeScript type expression"),
      package: optionalPackageArg,
    },
    async execute(args) {
      return json(await analyzer.explainType(args.expression, args.package))
    },
  }),
})

const createTransformSearchTools = (analyzer: QuartzAnalyzer) => ({
  type_transform_search: tool({
    description: "Search for functions by structural input/output type compatibility.",
    args: {
      from: tool.schema.string().optional().describe("Input type"),
      to: tool.schema.string().optional().describe("Output type"),
      paramPosition: tool.schema.union([tool.schema.number(), tool.schema.literal("any")]).optional(),
      unwrapReturn: tool.schema.boolean().optional(),
      exportedOnly: tool.schema.boolean().optional(),
      limit: limitArg,
      allowTypeErasure: tool.schema.boolean().optional(),
      verifiedOnly: tool.schema.boolean().optional(),
      minVerificationStatus: tool.schema
        .enum(["verified", "unverified", "unverifiable"])
        .optional()
        .describe("Minimum verification status to return"),
      includeDiagnostics: tool.schema.boolean().optional(),
      includeSyntheticCode: tool.schema.boolean().optional(),
      includeFailedVerification: tool.schema.boolean().optional(),
      package: optionalPackageArg,
    },
    async execute(args) {
      return json(await analyzer.transformSearch({
        ...packageOption(args.package),
        ...optionalOption("from", args.from),
        ...optionalOption("to", args.to),
        ...optionalOption("paramPosition", args.paramPosition),
        ...optionalOption("unwrapReturn", args.unwrapReturn),
        ...optionalOption("exportedOnly", args.exportedOnly),
        ...optionalOption("limit", args.limit),
        ...optionalOption("allowTypeErasure", args.allowTypeErasure),
        ...optionalOption("verifiedOnly", args.verifiedOnly),
        ...optionalOption("minVerificationStatus", args.minVerificationStatus),
        ...optionalOption("includeDiagnostics", args.includeDiagnostics),
        ...optionalOption("includeSyntheticCode", args.includeSyntheticCode),
        ...optionalOption("includeFailedVerification", args.includeFailedVerification),
      }))
    },
  }),
})

const createVerifyContractTools = (analyzer: QuartzAnalyzer) => ({
  type_verify_contract: tool({
    description: "Compose compatibility, snippet, diagnostics, and transform evidence for a proposed type contract.",
    args: {
      from: tool.schema.string().optional().describe("Source type or symbol"),
      to: tool.schema.string().optional().describe("Target type or symbol"),
      symbol: tool.schema.string().optional().describe("Expected transform symbol"),
      snippet: tool.schema.string().optional().describe("Concrete TypeScript call-site snippet to check"),
      includeDiagnostics: tool.schema.boolean().optional(),
      includeTransformEvidence: tool.schema.boolean().optional(),
      transformLimit: limitArg,
      package: optionalPackageArg,
    },
    async execute(args) {
      return json(
        await analyzer.verifyContract({
          ...packageOption(args.package),
          ...optionalOption("from", args.from),
          ...optionalOption("to", args.to),
          ...optionalOption("symbol", args.symbol),
          ...optionalOption("snippet", args.snippet),
          ...optionalOption("includeDiagnostics", args.includeDiagnostics),
          ...optionalOption("includeTransformEvidence", args.includeTransformEvidence),
          ...optionalOption("transformLimit", args.transformLimit),
        }),
      )
    },
  }),
})

const createToolDefinitions = (analyzer: QuartzAnalyzer) => ({
  ...createDiscoveryTools(analyzer),
  ...createAnalysisTools(analyzer),
  ...createRelationshipTools(analyzer),
})

export const QuartzPlugin: Plugin = async (ctx) => {
  // Persistent analyzer is the primary agent integration: one open workspace
  // per plugin instance, reused across tools until process exit or disposal.
  const analyzer = await createTypeAnalyzer(ctx.directory, { collectTiming: true })
  const client = ctx.client as { app?: { log?: (input: unknown) => Promise<unknown> } }
  let disposePromise: Promise<void> | null = null
  const disposeAnalyzer = (reason: string): Promise<void> => {
    disposePromise ??= (async () => {
      try {
        await analyzer.dispose()
        await client.app?.log?.({
          body: {
            service: "quartz",
            level: "debug",
            message: "quartz analyzer disposed",
            extra: { reason },
          },
        })
      } catch (cause) {
        await client.app?.log?.({
          body: {
            service: "quartz",
            level: "warn",
            message: "quartz analyzer dispose failed",
            extra: { reason, cause: cause instanceof Error ? cause.message : String(cause) },
          },
        })
      }
    })()
    return disposePromise
  }

  // OpenCode Hooks have no plugin-level teardown yet; bind process lifetime and
  // known session terminal events so child TS-Go processes do not leak.
  const onProcessExit = () => {
    void disposeAnalyzer("process-exit")
  }
  process.once("beforeExit", onProcessExit)
  process.once("exit", onProcessExit)

  return {
    event: async ({ event }) => {
      if (event.type === "session.idle") {
        await client.app?.log?.({
          body: {
            service: "quartz",
            level: "debug",
            message: "session idle observed by quartz plugin",
            extra: { sessionID: (event as { properties?: { sessionID?: string } }).properties?.sessionID },
          },
        })
      }
      // Dispose when the host signals session deletion (OpenCode emits session.deleted).
      if (event.type === "session.deleted") {
        process.off("beforeExit", onProcessExit)
        process.off("exit", onProcessExit)
        await disposeAnalyzer(event.type)
      }
    },
    "tool.execute.after": async (input) => {
      if (FILE_MODIFYING_TOOLS.has(input.tool)) {
        await analyzer.markDirty()
      }
    },
    tool: createToolDefinitions(analyzer),
    // Test/host escape hatch — not part of Hooks, ignored by hosts that strip unknown keys.
    dispose: () => {
      process.off("beforeExit", onProcessExit)
      process.off("exit", onProcessExit)
      return disposeAnalyzer("explicit")
    },
  } as Awaited<ReturnType<Plugin>> & { dispose: () => Promise<void> }
}

export default {
  id: "quartz",
  server: QuartzPlugin,
}
