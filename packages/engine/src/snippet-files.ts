import { resolve } from "node:path"
import { DiagnosticCategory, type Project } from "tsrs/unstable/async"
import type { AnalyzerContext } from "./context"
import type { SnippetDiagnostic, SnippetFilesCheckOptions, SnippetFilesCheckResult } from "./contracts"
import { QuartzEngineError } from "./errors"

interface MultiFileWorkspace {
  withVirtualFiles<T>(
    tsconfigPath: string,
    files: readonly { readonly path: string; readonly content: string }[],
    operation: (project: Project, paths: readonly string[]) => Promise<T>,
  ): Promise<T>
}

const workspaceWithVirtualFiles = (context: AnalyzerContext): MultiFileWorkspace => {
  const workspace = context.workspace as unknown as Partial<MultiFileWorkspace>
  if (typeof workspace.withVirtualFiles !== "function") {
    throw new QuartzEngineError(
      "WORKSPACE_REFRESH_FAILED",
      "checkSnippetFiles requires QuartzWorkspace.withVirtualFiles(tsconfigPath, files, operation), which layers every file into one snapshot",
    )
  }
  return workspace as MultiFileWorkspace
}

/**
 * Diagnostics for one layered file. The three queries plus the source-file read
 * are issued together so the tsrs client folds them into one batch request.
 */
const diagnosticsFor = async (project: Project, filePath: string): Promise<readonly SnippetDiagnostic[]> => {
  const [syntactic, bind, semantic, sourceFile] = await Promise.all([
    project.program.getSyntacticDiagnostics(filePath),
    project.program.getBindDiagnostics(filePath),
    project.program.getSemanticDiagnostics(filePath),
    project.program.getSourceFile(filePath),
  ])
  const seen = new Set<string>()
  const diagnostics: SnippetDiagnostic[] = []
  for (const diagnostic of [...syntactic, ...bind, ...semantic]) {
    const key = `${diagnostic.code}\u0000${diagnostic.pos}\u0000${diagnostic.end}\u0000${diagnostic.text}`
    if (seen.has(key)) continue
    seen.add(key)
    const location = sourceFile === undefined
      ? { line: 1, character: 0 }
      : sourceFile.getLineAndCharacterOfPosition(Math.max(0, diagnostic.pos))
    diagnostics.push({
      message: diagnostic.text,
      line: location.line + 1,
      column: location.character + 1,
      severity: diagnostic.category === DiagnosticCategory.Error ? "error" : "warning",
    })
  }
  return diagnostics.sort((left, right) =>
    left.line - right.line || left.column - right.column || left.message.localeCompare(right.message))
}

export type SnippetFilesOperation = (options: SnippetFilesCheckOptions) => Promise<SnippetFilesCheckResult>

/**
 * Compile caller-supplied files as one program inside a layered snapshot.
 * Unlike check-snippet there are no synthesized package imports: a multi-file
 * check exists to resolve the imports the caller wrote between the files.
 */
export const createSnippetFilesOperation = (context: AnalyzerContext): SnippetFilesOperation => async (options) => {
  if (options.files.length === 0) {
    throw new QuartzEngineError("SNIPPET_INVALID", "checkSnippetFiles requires at least one file")
  }
  const pkg = context.package(options.packageName)
  const workspace = workspaceWithVirtualFiles(context)
  const resolvedPaths = options.files.map((file) => resolve(pkg.path, file.path))
  if (new Set(resolvedPaths).size !== resolvedPaths.length) {
    throw new QuartzEngineError("SNIPPET_INVALID", "checkSnippetFiles received the same path more than once")
  }

  const errors = await workspace.withVirtualFiles(
    pkg.tsconfigPath,
    options.files.map((file, index) => ({ path: resolvedPaths[index]!, content: file.content })),
    async (project, paths) => {
      const perFile = await Promise.all(paths.map((path) => diagnosticsFor(project, path)))
      // Report the caller's own path label, not the resolved absolute path.
      return perFile.flatMap((fileDiagnostics, index) =>
        fileDiagnostics.map((diagnostic) => ({ ...diagnostic, file: options.files[index]!.path })))
    },
  )
  return errors.length === 0 ? { valid: true } : { valid: false, errors }
}
