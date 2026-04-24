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

const normalizePackage = (packageName: string): string | undefined => (packageName === "" ? undefined : packageName)
const normalizeText = (value: string): string | undefined => (value === "" ? undefined : value)

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
  { root: rootOption, packageName: packageOption },
  ({ root, packageName }) =>
    createTypeAnalyzer(root).getDiagnostics(normalizePackage(packageName)).pipe(Effect.flatMap(printJson)),
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

const unported = (name: string) =>
  Command.make(name, {}, () =>
    Console.log(
      JSON.stringify({
        status: "not_ported",
        command: name,
        message: "This command is reserved in the CLI shape but still needs a core implementation port.",
      }),
    ),
  )

const command = Command.make("type-level-tools").pipe(
  Command.withSubcommands([
    packages,
    symbols,
    info,
    expand,
    search,
    diagnostics,
    atPosition,
    unported("related"),
    unported("eval"),
    unported("transform-search"),
    unported("why-error"),
    unported("explain"),
  ]),
)

Command.run(command, {
  name: "type-level-tools",
  version: "0.1.0",
})(process.argv).pipe(Effect.provide(BunContext.layer), BunRuntime.runMain)
