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
    tool: {
      type_packages: tool({
        description: "List TypeScript packages discovered from tsconfig.json files.",
        args: {},
        async execute() {
          return JSON.stringify(await run(analyzer.getPackages()), null, 2)
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
          return JSON.stringify(
            await run(
              analyzer.listSymbols({
                ...(args.package === undefined ? {} : { packageName: args.package }),
                ...(args.pattern === undefined ? {} : { pattern: args.pattern }),
                ...(args.kind === undefined ? {} : { kind: args.kind }),
                ...(args.limit === undefined ? {} : { limit: args.limit }),
              }),
            ),
            null,
            2,
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
          return JSON.stringify(await run(analyzer.getTypeInfo(args.symbol, args.package)), null, 2)
        },
      }),
      type_expand: tool({
        description: "Expand an exported TypeScript symbol type.",
        args: {
          symbol: tool.schema.string().describe("Exported symbol name"),
          package: optionalPackageArg,
        },
        async execute(args) {
          return JSON.stringify(await run(analyzer.expandType(args.symbol, args.package)), null, 2)
        },
      }),
      type_diagnostics: tool({
        description: "Show TypeScript diagnostics.",
        args: {
          package: optionalPackageArg,
        },
        async execute(args) {
          return JSON.stringify(await run(analyzer.getDiagnostics(args.package)), null, 2)
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
          return JSON.stringify(
            await run(analyzer.getTypeAtPosition(args.file, args.line, args.column, args.package)),
            null,
            2,
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
