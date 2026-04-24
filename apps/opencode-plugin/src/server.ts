import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import { Effect } from "effect"
import { createTypeAnalyzer } from "@type-level-tools/core"

const run = <A>(effect: Effect.Effect<A, unknown>) =>
  Effect.runPromise(effect.pipe(Effect.mapError((error) => (error instanceof Error ? error : new Error(String(error))))))

const optionalPackageArg = tool.schema
  .string()
  .optional()
  .describe("Package/directory to analyze. Omit for root or single-package projects.")

const limitArg = tool.schema.number().optional().describe("Maximum number of results")
const json = (value: unknown) => JSON.stringify(value, null, 2)
const FILE_MODIFYING_TOOLS = new Set(["edit", "morph-mcp_edit_file", "write"])

export const TypeLevelToolsPlugin: Plugin = async (ctx) => {
  const analyzer = createTypeAnalyzer(ctx.directory)
  const client = ctx.client as { app?: { log?: (input: unknown) => Promise<unknown> } }

  return {
    event: async ({ event }) => {
      if (event.type === "session.idle") {
        await client.app?.log?.({
          body: {
            service: "type-level-tools",
            level: "debug",
            message: "session idle observed by type-level-tools plugin",
            extra: { sessionID: event.properties.sessionID },
          },
        })
      }
    },
    "tool.execute.after": async (input) => {
      if (FILE_MODIFYING_TOOLS.has(input.tool)) {
        analyzer.markDirty()
      }
    },
    tool: {
      type_packages: tool({
        description: "List TypeScript packages discovered from tsconfig.json files.",
        args: {},
        async execute() {
          return json(await run(analyzer.getPackages()))
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
            await run(
              analyzer.listSymbols({
                ...(args.package === undefined ? {} : { packageName: args.package }),
                ...(args.pattern === undefined ? {} : { pattern: args.pattern }),
                ...(args.kind === undefined ? {} : { kind: args.kind }),
                ...(args.limit === undefined ? {} : { limit: args.limit }),
              }),
            ),
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
          return json(await run(analyzer.getTypeInfo(args.symbol, args.package)))
        },
      }),
      type_expand: tool({
        description: "Expand an exported TypeScript symbol type.",
        args: {
          symbol: tool.schema.string().describe("Exported symbol name"),
          package: optionalPackageArg,
        },
        async execute(args) {
          return json(await run(analyzer.expandType(args.symbol, args.package)))
        },
      }),
      type_related: tool({
        description: "Find types that reference or are referenced by a TypeScript symbol.",
        args: {
          symbol: tool.schema.string().describe("Exported symbol name"),
          package: optionalPackageArg,
        },
        async execute(args) {
          return json(await run(analyzer.findRelated(args.symbol, args.package)))
        },
      }),
      type_search: tool({
        description: "Search exported types by name.",
        args: {
          query: tool.schema.string().describe("Case-insensitive symbol query"),
          package: optionalPackageArg,
          limit: limitArg,
        },
        async execute(args) {
          return json(
            await run(
              analyzer.searchTypes({
                query: args.query,
                ...(args.package === undefined ? {} : { packageName: args.package }),
                ...(args.limit === undefined ? {} : { limit: args.limit }),
              }),
            ),
          )
        },
      }),
      type_eval: tool({
        description: "Evaluate a TypeScript type expression and return the computed type.",
        args: {
          expression: tool.schema.string().describe("TypeScript type expression"),
          package: optionalPackageArg,
        },
        async execute(args) {
          return json(await run(analyzer.evalType(args.expression, args.package)))
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
            await run(
              analyzer.getDiagnostics({
                ...(args.package === undefined ? {} : { packageName: args.package }),
                ...(args.explain === undefined ? {} : { explain: args.explain }),
              }),
            ),
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
          return json(await run(analyzer.checkSnippet(args.code, args.package)))
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
          return json(await run(analyzer.getTypeAtPosition(args.file, args.line, args.column, args.package)))
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
            await run(
              analyzer.getFileDeclarations(args.file, {
                ...(args.symbol === undefined ? {} : { symbol: args.symbol }),
                ...(args.includePrivate === undefined ? {} : { includePrivate: args.includePrivate }),
                ...(args.package === undefined ? {} : { packageName: args.package }),
              }),
            ),
          )
        },
      }),
      type_refresh: tool({
        description: "Clear cached TypeScript projects to pick up external file changes.",
        args: {
          package: optionalPackageArg,
        },
        async execute(args) {
          return await run(analyzer.refresh(args.package))
        },
      }),
      type_compatible: tool({
        description: "Check if one type is assignable to another.",
        args: {
          from: tool.schema.string().describe("Source type or symbol"),
          to: tool.schema.string().describe("Target type or symbol"),
          package: optionalPackageArg,
        },
        async execute(args) {
          return json(await run(analyzer.checkCompatibility(args.from, args.to, args.package)))
        },
      }),
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
            await run(
              analyzer.generateGraph(args.symbol, {
                ...(args.depth === undefined ? {} : { depth: args.depth }),
                ...(args.format === undefined ? {} : { format: args.format }),
                ...(args.package === undefined ? {} : { packageName: args.package }),
              }),
            ),
          )
        },
      }),
      type_refactor_preview: tool({
        description: "Preview a rename refactor without applying it.",
        args: {
          symbol: tool.schema.string().describe("Symbol to rename"),
          to: tool.schema.string().describe("New name"),
          package: optionalPackageArg,
        },
        async execute(args) {
          return json(
            await run(
              analyzer.previewRefactor({
                action: "rename",
                symbol: args.symbol,
                to: args.to,
                ...(args.package === undefined ? {} : { packageName: args.package }),
              }),
            ),
          )
        },
      }),
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
            await run(
              analyzer.explainError({
                ...(args.code === undefined ? {} : { code: args.code }),
                ...(args.message === undefined ? {} : { message: args.message }),
                ...(args.file === undefined ? {} : { file: args.file }),
                ...(args.line === undefined ? {} : { line: args.line }),
                ...(args.package === undefined ? {} : { packageName: args.package }),
              }),
            ),
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
          return json(await run(analyzer.explainType(args.expression, args.package)))
        },
      }),
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
          package: optionalPackageArg,
        },
        async execute(args) {
          return await run(
            analyzer.transformSearch({
              ...(args.from === undefined ? {} : { from: args.from }),
              ...(args.to === undefined ? {} : { to: args.to }),
              ...(args.paramPosition === undefined ? {} : { paramPosition: args.paramPosition }),
              ...(args.unwrapReturn === undefined ? {} : { unwrapReturn: args.unwrapReturn }),
              ...(args.exportedOnly === undefined ? {} : { exportedOnly: args.exportedOnly }),
              ...(args.limit === undefined ? {} : { limit: args.limit }),
              ...(args.allowTypeErasure === undefined ? {} : { allowTypeErasure: args.allowTypeErasure }),
              ...(args.package === undefined ? {} : { packageName: args.package }),
            }),
          )
        },
      }),
    },
  }
}

export default {
  id: "type-level-tools",
  server: TypeLevelToolsPlugin,
}
