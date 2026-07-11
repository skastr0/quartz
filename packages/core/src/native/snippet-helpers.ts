import {
  API,
  DiagnosticCategory,
  ModifierFlags,
  type Program,
  type Project,
  SymbolFlags,
  type Snapshot,
} from "typescript/unstable/sync"
import { SyntaxKind } from "typescript/unstable/ast"
import { isTypeAliasDeclaration } from "typescript/unstable/ast/is"
import { relative, dirname, basename, join } from "node:path"
import { Effect } from "effect"
import { discoverPackages, type PackageInfo } from "../discovery"
import { QuartzError } from "../errors"
import type { SnippetDiagnostic, SnippetImportPlan } from "../project-types"
import type { NativeCommandContext } from "./context"
import { createHybridFileSystem } from "./vfs"

/**
 * Shared helpers for the native `checkSnippet` and `evalType` commands. These
 * keep the per-snippet VFS, import-plan, and export-discovery logic in one
 * place so each command file stays focused on its envelope shape.
 */

export interface SnippetExportSource {
  readonly name: string
  readonly absolutePath: string
  readonly isDefault: boolean
  readonly isTypeOnly: boolean
}

export interface NativeSnippetProject {
  readonly api: API
  readonly snapshot: Snapshot
  readonly project: Project
  readonly program: Program
  readonly snippetPath: string
  readonly snippetSourceFile: import("typescript/unstable/ast").SourceFile
  readonly importLineCount: number
  readonly dispose: () => void
}

const SNIPPET_FILE_PREFIX = "__quartz_snippet_"

const uniqueSnippetFileName = (): string =>
  `${SNIPPET_FILE_PREFIX}${Date.now()}_${Math.random().toString(36).slice(2, 10)}__.ts`

const isPackageSourceFile = (program: Program, pkg: PackageInfo, fileName: string): boolean => {
  if (!fileName.startsWith(pkg.path)) return false
  if (fileName.includes("node_modules")) return false
  if (fileName.endsWith(".d.ts")) return false
  const sourceFile = program.getSourceFile(fileName)
  if (sourceFile === undefined) return false
  if (program.isSourceFileDefaultLibrary(sourceFile)) return false
  if (program.isSourceFileFromExternalLibrary(sourceFile)) return false
  return true
}

/**
 * Pick a directory inside the package where the virtual snippet file will live.
 * The file must be discoverable by the project's `include` glob, so we place it
 * alongside an existing package source file. If no source file is found we fall
 * back to the package root (the caller should only reach this path for empty or
 * misconfigured packages).
 */
export const resolveSnippetDirectory = (program: Program, pkg: PackageInfo): string => {
  const firstSourceFile = program
    .getSourceFileNames()
    .find((fileName) => isPackageSourceFile(program, pkg, fileName))
  return firstSourceFile === undefined ? pkg.path : dirname(firstSourceFile)
}

const getDefaultExportName = (project: Project, sourceFile: import("typescript/unstable/ast").SourceFile): string => {
  // Fall back to "default" if we cannot extract a meaningful name.
  const defaultName = "default"
  // The native API does not expose a direct "default export name" helper, so we
  // walk the source file statements looking for an export assignment or a
  // declaration with the `default` modifier and return its identifier text.
  let found: string | undefined
  const visit = (node: import("typescript/unstable/ast").Node): void => {
    if (found !== undefined) return

    if (node.kind === SyntaxKind.ExportAssignment) {
      node.forEachChild((child) => {
        if (found !== undefined) return
        if (child.kind === SyntaxKind.Identifier) {
          found = child.getText(sourceFile)
        }
      })
      return
    }

    const modifierFlags = (node as import("typescript/unstable/ast").ModifiersBase | undefined)?.modifierFlags
    if (modifierFlags !== undefined && (modifierFlags & ModifierFlags.Default) !== 0) {
      node.forEachChild((child) => {
        if (found !== undefined) return
        if (child.kind === SyntaxKind.Identifier) {
          found = child.getText(sourceFile)
        }
      })
      if (found !== undefined) return
    }

    node.forEachChild((child) => {
      visit(child)
    })
  }
  visit(sourceFile)
  return found ?? defaultName
}

export const collectSnippetExportSources = (
  program: Program,
  project: Project,
  pkg: PackageInfo,
): Map<string, SnippetExportSource[]> => {
  const checker = project.checker
  const exports = new Map<string, SnippetExportSource[]>()

  for (const fileName of program.getSourceFileNames()) {
    if (!isPackageSourceFile(program, pkg, fileName)) continue
    const sourceFile = program.getSourceFile(fileName)
    if (sourceFile === undefined) continue
    const moduleSymbol = checker.getSymbolAtLocation(sourceFile)
    if (moduleSymbol === undefined) continue
    const moduleExports = checker.getExportsOfModule(moduleSymbol)

    for (const exportedSymbol of moduleExports) {
      const exportName = exportedSymbol.name
      const isDefault = exportName === "default"
      const displayName = isDefault ? getDefaultExportName(project, sourceFile) : exportName
      const hasValue = (exportedSymbol.flags & SymbolFlags.Value) !== 0
      const isTypeOnly = !hasValue
      const sources = exports.get(displayName) ?? []
      sources.push({
        name: displayName,
        absolutePath: fileName,
        isDefault,
        isTypeOnly,
      })
      exports.set(displayName, sources)
    }
  }

  return exports
}

const toSnippetModulePath = (tempDir: string, absolutePath: string): string => {
  let modulePath = relative(tempDir, absolutePath)
  if (!modulePath.startsWith(".") && !modulePath.startsWith("/")) {
    modulePath = `./${modulePath}`
  }
  return modulePath.replace(/\\/g, "/").replace(/\.(ts|tsx)$/, "")
}

interface GroupedFileExports {
  readonly type: string[]
  readonly value: string[]
}

export const buildSnippetImportPlan = (
  exportSources: Map<string, SnippetExportSource[]>,
  tempDir: string,
  typeOnly: boolean,
): SnippetImportPlan => {
  const fileExports = new Map<string, GroupedFileExports>()

  for (const [name, sources] of exportSources) {
    sources.forEach((source, index) => {
      const alias = sources.length === 1 ? name : `${name}_${index}`
      const importName = source.isDefault
        ? `default as ${alias}`
        : alias === name
          ? name
          : `${name} as ${alias}`
      const existing = fileExports.get(source.absolutePath) ?? { type: [], value: [] }
      const target = typeOnly || source.isTypeOnly ? existing.type : existing.value
      target.push(importName)
      fileExports.set(source.absolutePath, existing)
    })
  }

  const imports: string[] = []
  for (const [absolutePath, exportLists] of fileExports) {
    for (const { imports: exportList, prefix } of [
      { imports: exportLists.type, prefix: "import type" },
      { imports: exportLists.value, prefix: "import" },
    ]) {
      if (exportList.length === 0) continue
      const modulePath = toSnippetModulePath(tempDir, absolutePath)
      imports.push(`${prefix} { ${exportList.join(", ")} } from "${modulePath}";`)
    }
  }

  const importBlock = imports.join("\n")
  return {
    fileContent: imports.length > 0 ? `${importBlock}\n` : "",
    importLineCount: imports.length,
  }
}

export const createEvalSnippetContent = (
  expression: string,
  importPlan: SnippetImportPlan,
): string => `${importPlan.fileContent}type __EvalResult__ = ${expression};`

export const createCheckSnippetContent = (
  code: string,
  importPlan: SnippetImportPlan,
): string =>
  importPlan.fileContent.length > 0
    ? `${importPlan.fileContent}${code}`
    : code

export const findEvalTypeAlias = (
  sourceFile: import("typescript/unstable/ast").SourceFile,
): import("typescript/unstable/ast").TypeAliasDeclaration | undefined => {
  let typeAlias: import("typescript/unstable/ast").TypeAliasDeclaration | undefined
  const visit = (node: import("typescript/unstable/ast").Node): void => {
    if (typeAlias !== undefined) return
    if (isTypeAliasDeclaration(node)) {
      const name = node.name?.getText(sourceFile)
      if (name === "__EvalResult__") {
        typeAlias = node
        return
      }
    }
    node.forEachChild(visit)
  }
  visit(sourceFile)
  return typeAlias
}

export const loadSnippetProject = (
  ctx: NativeCommandContext,
  pkg: PackageInfo,
  snippetContent: string,
): NativeSnippetProject => {
  // Discover the package source-file layout using the shared native engine,
  // then create an isolated per-snippet API with a VFS that injects the
  // snippet file into a directory covered by the tsconfig `include` glob.
  const layoutProgram = ctx.engine.getProgram(pkg.tsconfigPath)
  const snippetDir = resolveSnippetDirectory(layoutProgram, pkg)
  const snippetPath = join(snippetDir, uniqueSnippetFileName())
  const fs = createHybridFileSystem({ [snippetPath]: snippetContent })

  let api: API
  try {
    api = new API({ cwd: ctx.rootDirectory, fs })
  } catch (cause) {
    throw new QuartzError({
      message: `Could not start the native TypeScript engine for snippet analysis: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
      cause,
    })
  }

  const snapshot = api.updateSnapshot({ openProjects: [pkg.tsconfigPath], openFiles: [snippetPath] })
  const project = snapshot.getProject(pkg.tsconfigPath)
  if (project === undefined) {
    api.close()
    throw new QuartzError({
      message: `The native engine could not resolve a project for ${pkg.tsconfigPath} during snippet analysis.`,
    })
  }

  const program = project.program
  const snippetSourceFile = program.getSourceFile(snippetPath)
  if (snippetSourceFile === undefined) {
    api.close()
    throw new QuartzError({
      message: `The native engine did not load the virtual snippet file ${snippetPath}.`,
    })
  }

  return {
    api,
    snapshot,
    project,
    program,
    snippetPath,
    snippetSourceFile,
    importLineCount: snippetContent.split("\n").filter((line) => line.startsWith("import")).length,
    dispose: () => {
      try {
        snapshot.dispose()
      } catch {
        // Best-effort cleanup only.
      }
      try {
        api.close()
      } catch {
        // Best-effort cleanup only.
      }
    },
  }
}

export const resolvePackage = (
  ctx: NativeCommandContext,
  packageName?: string,
): Effect.Effect<PackageInfo, QuartzError> =>
  Effect.gen(function* () {
    const packages = yield* discoverPackages(ctx.rootDirectory)
    if (packageName === undefined || packageName.length === 0) {
      const root = packages.find((pkg) => pkg.name === "(root)")
      if (root !== undefined) return root
      if (packages.length === 1) return packages[0]!
      return yield* Effect.fail(
        new QuartzError({
          message: `Multiple packages found. Please specify a package: ${packages.map((pkg) => pkg.name).join(", ")}`,
        }),
      )
    }
    const normalized = packageName.replace(/^\//, "")
    const found = packages.find(
      (pkg) => pkg.name === packageName || pkg.name === normalized || pkg.path.endsWith(packageName),
    )
    if (found === undefined) {
      return yield* Effect.fail(
        new QuartzError({
          message: `Package "${packageName}" not found. Available: ${packages.map((pkg) => pkg.name).join(", ")}`,
        }),
      )
    }
    return found
  })

export const mapSnippetDiagnostics = (
  diagnostics: readonly import("typescript/unstable/sync").Diagnostic[],
  sourceFile: import("typescript/unstable/ast").SourceFile,
  importLineCount: number,
): SnippetDiagnostic[] =>
  diagnostics.map((diagnostic) => {
    const text = diagnostic.text ?? "Unknown diagnostic"
    const position =
      diagnostic.pos !== undefined && diagnostic.pos >= 0
        ? sourceFile.getLineAndCharacterOfPosition(diagnostic.pos)
        : undefined
    const line = position === undefined ? 1 : Math.max(1, position.line + 1 - importLineCount)
    const column = position === undefined ? 1 : position.character + 1
    const severity: "error" | "warning" = diagnostic.category === DiagnosticCategory.Error ? "error" : "warning"
    return { message: text, line, column, severity }
  })
