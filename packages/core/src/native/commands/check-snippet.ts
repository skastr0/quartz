import { Effect } from "effect"
import type { TypeAnalyzer } from "../../analyzer"
import type { NativeCommandContext } from "../context"
import {
  buildSnippetImportPlan,
  collectSnippetExportSources,
  createCheckSnippetContent,
  loadSnippetProject,
  mapSnippetDiagnostics,
  resolvePackage,
  resolveSnippetDirectory,
} from "../snippet-helpers"

/**
 * Native `checkSnippet` — compile an in-memory snippet file via an isolated VFS
 * and return diagnostics. Snippets reuse the native engine session and its
 * hybrid VFS; each snapshot is disposed before the virtual file is removed.
 */
export const checkSnippet =
  (ctx: NativeCommandContext): TypeAnalyzer["checkSnippet"] =>
  (code, packageName) =>
    Effect.gen(function* () {
      const pkg = yield* resolvePackage(ctx, packageName)
      const layoutProgram = ctx.engine.getProgram(pkg.tsconfigPath)
      const layoutProject = ctx.engine.getProject(pkg.tsconfigPath)
      const exportSources = collectSnippetExportSources(layoutProgram, layoutProject, pkg)
      const snippetDir = resolveSnippetDirectory(layoutProgram, pkg)
      const importPlan = buildSnippetImportPlan(exportSources, snippetDir, false)
      const snippetContent = createCheckSnippetContent(code, importPlan)

      const snippetProject = loadSnippetProject(ctx, pkg, snippetContent)
      try {
        const diagnostics = snippetProject.program.getSemanticDiagnostics(snippetProject.snippetPath)
        if (diagnostics.length === 0) {
          return { valid: true }
        }
        const errors = mapSnippetDiagnostics(diagnostics, snippetProject.snippetSourceFile, snippetProject.importLineCount)
        return { valid: false, errors }
      } finally {
        snippetProject.dispose()
      }
    })
