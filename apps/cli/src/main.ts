import { Command, Options } from "@effect/cli"
import { BunContext, BunRuntime } from "@effect/platform-bun"
import { Console, Effect } from "effect"
import { createTypeAnalyzer, type ListSymbolsOptions, type SearchTypesOptions } from "@type-level-tools/core"

const rootOption = Options.text("root").pipe(
  Options.withDefault(process.cwd()),
  Options.withDescription("Project root to analyze"),
)
const packageOption = Options.text("package").pipe(
  Options.withDefault(""),
  Options.withDescription("Package name or path to analyze"),
)
const symbolOption = Options.text("symbol").pipe(Options.withDescription("Exported symbol name"))
const fileOption = Options.text("file").pipe(Options.withDescription("TypeScript file path"))
const lineOption = Options.integer("line").pipe(Options.withDescription("One-based line number"))
const columnOption = Options.integer("column").pipe(Options.withDescription("One-based column number"))
const patternOption = Options.text("pattern").pipe(
  Options.withDefault(""),
  Options.withDescription("Case-insensitive symbol pattern"),
)
const kindOption = Options.text("kind").pipe(
  Options.withDefault(""),
  Options.withDescription("Symbol kind filter"),
)
const limitOption = Options.integer("limit").pipe(
  Options.withDefault(100),
  Options.withDescription("Maximum number of results"),
)
const queryOption = Options.text("query").pipe(Options.withDescription("Search query"))
const expressionOption = Options.text("expression").pipe(Options.withDescription("TypeScript type expression"))
const codeOption = Options.text("code").pipe(Options.withDescription("TypeScript code snippet or error code"))
const fromOption = Options.text("from").pipe(Options.withDefault(""), Options.withDescription("Source type"))
const toOption = Options.text("to").pipe(Options.withDefault(""), Options.withDescription("Target type"))
const includePrivateOption = Options.boolean("include-private").pipe(
  Options.withDescription("Include non-exported declarations"),
)
const explainOption = Options.boolean("explain").pipe(Options.withDescription("Include diagnostic explanations"))

const normalizePackage = (packageName: string): string | undefined => (packageName === "" ? undefined : packageName)
const normalizeText = (value: string): string | undefined => (value === "" ? undefined : value)
const packageField = (packageName: string): { readonly packageName: string } | {} => {
  const normalized = normalizePackage(packageName)
  return normalized === undefined ? {} : { packageName: normalized }
}
const optionalField = <K extends string, T>(key: K, value: T | undefined): { readonly [P in K]: T } | {} =>
  value === undefined ? {} : { [key]: value } as { readonly [P in K]: T }

const printJson = (value: unknown) => Console.log(JSON.stringify(value, null, 2))
type Mutable<T> = { -readonly [K in keyof T]: T[K] }

const packages = Command.make("packages", { root: rootOption }, ({ root }) =>
  createTypeAnalyzer(root).getPackages().pipe(Effect.flatMap(printJson)),
).pipe(Command.withDescription("List TypeScript packages discovered from tsconfig.json files"))

const symbols = Command.make(
  "symbols",
  {
    root: rootOption,
    packageName: packageOption,
    pattern: patternOption,
    kind: kindOption,
    limit: limitOption,
  },
  ({ root, packageName, pattern, kind, limit }) =>
    Effect.gen(function* () {
      const options: Mutable<ListSymbolsOptions> = { limit }
      const normalizedPackage = normalizePackage(packageName)
      const normalizedPattern = normalizeText(pattern)
      const normalizedKind = normalizeText(kind)
      if (normalizedPackage !== undefined) options.packageName = normalizedPackage
      if (normalizedPattern !== undefined) options.pattern = normalizedPattern
      if (normalizedKind !== undefined) options.kind = normalizedKind
      return yield* createTypeAnalyzer(root).listSymbols(options)
    }).pipe(Effect.flatMap(printJson)),
).pipe(Command.withDescription("List exported symbols"))

const info = Command.make(
  "info",
  { root: rootOption, packageName: packageOption, symbol: symbolOption },
  ({ root, packageName, symbol }) =>
    createTypeAnalyzer(root).getTypeInfo(symbol, normalizePackage(packageName)).pipe(Effect.flatMap(printJson)),
).pipe(Command.withDescription("Show type information for an exported symbol"))

const expand = Command.make(
  "expand",
  { root: rootOption, packageName: packageOption, symbol: symbolOption },
  ({ root, packageName, symbol }) =>
    createTypeAnalyzer(root).expandType(symbol, normalizePackage(packageName)).pipe(Effect.flatMap(printJson)),
).pipe(Command.withDescription("Expand an exported symbol type"))

const search = Command.make(
  "search",
  { root: rootOption, packageName: packageOption, query: queryOption, limit: limitOption },
  ({ root, packageName, query, limit }) =>
    Effect.gen(function* () {
      const options: Mutable<SearchTypesOptions> = { query, limit }
      const normalizedPackage = normalizePackage(packageName)
      if (normalizedPackage !== undefined) options.packageName = normalizedPackage
      return yield* createTypeAnalyzer(root).searchTypes(options)
    }).pipe(Effect.flatMap(printJson)),
).pipe(Command.withDescription("Search exported types by name"))

const diagnostics = Command.make(
  "diagnostics",
  { root: rootOption, packageName: packageOption, explain: explainOption },
  ({ root, packageName, explain }) =>
    createTypeAnalyzer(root)
      .getDiagnostics({
        ...packageField(packageName),
        explain,
      })
      .pipe(Effect.flatMap(printJson)),
).pipe(Command.withDescription("Show TypeScript diagnostics"))

const atPosition = Command.make(
  "at-position",
  {
    root: rootOption,
    packageName: packageOption,
    file: fileOption,
    line: lineOption,
    column: columnOption,
  },
  ({ root, packageName, file, line, column }) =>
    createTypeAnalyzer(root)
      .getTypeAtPosition(file, line, column, normalizePackage(packageName))
      .pipe(Effect.flatMap(printJson)),
).pipe(Command.withDescription("Show the type at a source position"))

const related = Command.make(
  "related",
  { root: rootOption, packageName: packageOption, symbol: symbolOption },
  ({ root, packageName, symbol }) =>
    createTypeAnalyzer(root).findRelated(symbol, normalizePackage(packageName)).pipe(Effect.flatMap(printJson)),
).pipe(Command.withDescription("Find types that reference or are referenced by a symbol"))

const evalType = Command.make(
  "eval",
  { root: rootOption, packageName: packageOption, expression: expressionOption },
  ({ root, packageName, expression }) =>
    createTypeAnalyzer(root).evalType(expression, normalizePackage(packageName)).pipe(Effect.flatMap(printJson)),
).pipe(Command.withDescription("Evaluate a TypeScript type expression"))

const checkSnippet = Command.make(
  "check-snippet",
  { root: rootOption, packageName: packageOption, code: codeOption },
  ({ root, packageName, code }) =>
    createTypeAnalyzer(root).checkSnippet(code, normalizePackage(packageName)).pipe(Effect.flatMap(printJson)),
).pipe(Command.withDescription("Type-check a code snippet without writing to disk"))

const file = Command.make(
  "file",
  {
    root: rootOption,
    packageName: packageOption,
    file: fileOption,
    symbol: patternOption,
    includePrivate: includePrivateOption,
  },
  ({ root, packageName, file, symbol, includePrivate }) =>
    createTypeAnalyzer(root)
      .getFileDeclarations(file, {
        ...packageField(packageName),
        ...optionalField("symbol", normalizeText(symbol)),
        includePrivate,
      })
      .pipe(Effect.flatMap(printJson)),
).pipe(Command.withDescription("Inspect declarations in a TypeScript file"))

const compatible = Command.make(
  "compatible",
  { root: rootOption, packageName: packageOption, from: fromOption, to: toOption },
  ({ root, packageName, from, to }) =>
    createTypeAnalyzer(root).checkCompatibility(from, to, normalizePackage(packageName)).pipe(Effect.flatMap(printJson)),
).pipe(Command.withDescription("Check whether one type is assignable to another"))

const graph = Command.make(
  "graph",
  {
    root: rootOption,
    packageName: packageOption,
    symbol: symbolOption,
    depth: Options.integer("depth").pipe(Options.withDefault(2)),
    format: Options.text("format").pipe(Options.withDefault("mermaid")),
  },
  ({ root, packageName, symbol, depth, format }) =>
    createTypeAnalyzer(root)
      .generateGraph(symbol, {
        ...packageField(packageName),
        depth,
        format: format === "dot" ? "dot" : "mermaid",
      })
      .pipe(Effect.flatMap(printJson)),
).pipe(Command.withDescription("Generate a type dependency graph"))

const refactorPreview = Command.make(
  "refactor-preview",
  { root: rootOption, packageName: packageOption, symbol: symbolOption, to: toOption },
  ({ root, packageName, symbol, to }) =>
    createTypeAnalyzer(root)
      .previewRefactor({
        action: "rename",
        symbol,
        to,
        ...packageField(packageName),
      })
      .pipe(Effect.flatMap(printJson)),
).pipe(Command.withDescription("Preview a rename refactor without applying it"))

const whyError = Command.make(
  "why-error",
  {
    root: rootOption,
    packageName: packageOption,
    code: Options.integer("code").pipe(Options.withDefault(0)),
    message: Options.text("message").pipe(Options.withDefault("")),
    file: Options.text("file").pipe(Options.withDefault("")),
    line: Options.integer("line").pipe(Options.withDefault(0)),
  },
  ({ root, packageName, code, message, file, line }) =>
    createTypeAnalyzer(root)
      .explainError({
        ...(code === 0 ? {} : { code }),
        ...(message === "" ? {} : { message }),
        ...(file === "" ? {} : { file }),
        ...(line === 0 ? {} : { line }),
        ...packageField(packageName),
      })
      .pipe(Effect.flatMap(printJson)),
).pipe(Command.withDescription("Explain a TypeScript diagnostic"))

const explain = Command.make(
  "explain",
  { root: rootOption, packageName: packageOption, expression: expressionOption },
  ({ root, packageName, expression }) =>
    createTypeAnalyzer(root).explainType(expression, normalizePackage(packageName)).pipe(Effect.flatMap(printJson)),
).pipe(Command.withDescription("Explain the resolution of a TypeScript type expression"))

const transformSearch = Command.make(
  "transform-search",
  { root: rootOption, packageName: packageOption, from: fromOption, to: toOption, limit: limitOption },
  ({ root, packageName, from, to, limit }) =>
    createTypeAnalyzer(root)
      .transformSearch({
        ...(normalizeText(from) === undefined ? {} : { from }),
        ...(normalizeText(to) === undefined ? {} : { to }),
        ...packageField(packageName),
        limit,
      })
      .pipe(Effect.flatMap(Console.log)),
).pipe(Command.withDescription("Search functions by structural input/output type"))

const command = Command.make("type-level-tools").pipe(
  Command.withSubcommands([
    packages,
    symbols,
    info,
    expand,
    search,
    diagnostics,
    atPosition,
    related,
    evalType,
    checkSnippet,
    file,
    compatible,
    graph,
    refactorPreview,
    whyError,
    explain,
    transformSearch,
  ]),
)

Command.run(command, {
  name: "type-level-tools",
  version: "0.1.0",
})(process.argv).pipe(Effect.provide(BunContext.layer), BunRuntime.runMain)
