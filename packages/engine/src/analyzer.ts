import type {
  DiagnosticOptions,
  DiagnosticInfo,
  ErrorExplanationOptions,
  ExplainedDiagnosticInfo,
  ExplainedDiagnosticsResult,
  ListSymbolsOptions,
  RefactorPreviewOptions,
  SearchTypesOptions,
  TransformSearchOptions,
  TypeAnalyzer,
  VerifyContractOptions,
} from "./contracts"
import { AnalyzerContext } from "./context"
import { QuartzEngineError } from "./errors"
import { createLeafOperations } from "./leaf-operations"
import { createReferenceOperations } from "./reference-operations"
import { createTransformSearchOperation } from "./transform-search"
import type { WorkspaceMetadata, WorkspaceOptions } from "./types"
import { createVerificationOperations } from "./verification-operations"

export class QuartzAnalyzer implements TypeAnalyzer {
  readonly #context: AnalyzerContext
  readonly #leaf: ReturnType<typeof createLeafOperations>
  readonly #references: ReturnType<typeof createReferenceOperations>
  readonly #transformSearchOperation: ReturnType<typeof createTransformSearchOperation>
  readonly #verification: ReturnType<typeof createVerificationOperations>
  #disposePromise: Promise<void> | null = null

  private constructor(context: AnalyzerContext) {
    this.#context = context
    this.#leaf = createLeafOperations(context)
    this.#references = createReferenceOperations(context)
    this.#transformSearchOperation = createTransformSearchOperation(context)
    this.#verification = createVerificationOperations(context, {
      compatibility: this.#leaf.checkCompatibility,
      diagnostics: this.#leaf.getDiagnostics,
      transformSearch: this.#transformSearchOperation,
    })
  }

  static async open(root: string, options?: WorkspaceOptions): Promise<QuartzAnalyzer> {
    return new QuartzAnalyzer(await AnalyzerContext.open(root, options))
  }

  get metadata(): WorkspaceMetadata {
    return this.#context.workspace.metadata
  }

  getTimingInfo = (): Promise<unknown> => this.#context.workspace.getTimingInfo()
  resetTimingInfo = (): Promise<void> => this.#context.workspace.resetTimingInfo()

  getPackages = async () => {
    this.#assertOpen()
    return this.#leaf.getPackages()
  }
  listSymbols = (options?: ListSymbolsOptions) => this.#leaf.listSymbols(options)
  getTypeInfo = (symbolName: string, packageName?: string) => this.#leaf.getTypeInfo(symbolName, packageName)
  expandType = (symbolName: string, packageName?: string) => this.#leaf.expandType(symbolName, packageName)
  findRelated = (symbolName: string, packageName?: string) => this.#references.findRelated(symbolName, packageName)
  searchTypes = (options: SearchTypesOptions) => this.#leaf.searchTypes(options)
  evalType = (expression: string, packageName?: string) => this.#leaf.evalType(expression, packageName)
  checkSnippet = (code: string, packageName?: string) => this.#verification.checkSnippet(code, packageName)
  getFileDeclarations = (
    file: string,
    options?: { readonly symbol?: string; readonly includePrivate?: boolean; readonly packageName?: string },
  ) => this.#leaf.getFileDeclarations(file, options)
  checkCompatibility = (from: string, to: string, packageName?: string) =>
    this.#leaf.checkCompatibility(from, to, packageName)
  generateGraph = (
    symbol: string,
    options?: { readonly depth?: number; readonly format?: "mermaid" | "dot"; readonly packageName?: string },
  ) => this.#references.generateGraph(symbol, options)
  previewRefactor = (options: RefactorPreviewOptions) => this.#references.previewRefactor(options)
  getDiagnostics = async (
    packageNameOrOptions?: string | DiagnosticOptions,
  ): Promise<readonly DiagnosticInfo[] | ExplainedDiagnosticsResult> => {
    const packageName =
      typeof packageNameOrOptions === "string" ? packageNameOrOptions : packageNameOrOptions?.packageName
    const diagnostics = await this.#leaf.getDiagnostics(packageName)
    if (typeof packageNameOrOptions !== "object" || packageNameOrOptions.explain !== true) {
      return diagnostics as readonly DiagnosticInfo[]
    }
    const raw = diagnostics as readonly DiagnosticInfo[]
    const errors: ExplainedDiagnosticInfo[] = []
    for (const diagnostic of raw.slice(0, 10)) {
      const explanation = await this.#verification.explainError({
        code: diagnostic.code,
        message: diagnostic.message,
        ...(diagnostic.file === undefined ? {} : { file: diagnostic.file }),
        ...(diagnostic.line === undefined ? {} : { line: diagnostic.line }),
        ...(packageName === undefined ? {} : { packageName }),
      })
      errors.push({ ...diagnostic, explanation })
    }
    return {
      totalErrors: raw.length,
      explained: errors.length,
      truncated: raw.length > 10,
      errors,
    }
  }
  getTypeAtPosition = (filePath: string, line: number, column: number, packageName?: string) =>
    this.#leaf.getTypeAtPosition(filePath, line, column, packageName)
  explainError = (options: ErrorExplanationOptions) => this.#verification.explainError(options)
  explainType = (expression: string, packageName?: string) => this.#leaf.explainType(expression, packageName)
  transformSearch = (options: TransformSearchOptions & { readonly packageName?: string }) =>
    this.#transformSearchOperation(options)
  verifyContract = (options: VerifyContractOptions) => this.#verification.verifyContract(options)

  async refresh(packageName?: string): Promise<string> {
    if (packageName === undefined) {
      await this.#context.refresh()
      return "Refreshed all TypeScript projects"
    }
    const pkg = this.#context.package(packageName)
    await this.#context.refreshPackage(packageName)
    return `Refreshed package ${pkg.name}`
  }

  async markDirty(): Promise<void> {
    this.#context.markDirty()
  }

  dispose(): Promise<void> {
    this.#disposePromise ??= this.#context.close()
    return this.#disposePromise
  }

  #assertOpen(): void {
    if (this.#disposePromise !== null) {
      throw new QuartzEngineError("WORKSPACE_CLOSED", `Quartz analyzer at ${this.#context.root} is closed`)
    }
  }
}

export const createTypeAnalyzer = (root: string, options?: WorkspaceOptions): Promise<QuartzAnalyzer> =>
  QuartzAnalyzer.open(root, options)
