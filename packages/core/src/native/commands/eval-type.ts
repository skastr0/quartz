import { Effect } from "effect"
import { DiagnosticCategory, NodeBuilderFlags } from "typescript/unstable/sync"
import type { TypeAnalyzer } from "../../analyzer"
import type { NativeCommandContext } from "../context"
import {
  buildSnippetImportPlan,
  collectSnippetExportSources,
  createEvalSnippetContent,
  findEvalTypeAlias,
  loadSnippetProject,
  mapSnippetDiagnostics,
  resolvePackage,
  resolveSnippetDirectory,
} from "../snippet-helpers"

/**
 * Native `evalType` — synthesize a snippet containing the expression as a type
 * alias, resolve the alias type, and return both the source expression and an
 * expanded structural rendering.
 */
export const evalType =
  (ctx: NativeCommandContext): TypeAnalyzer["evalType"] =>
  (expression, packageName) =>
    Effect.gen(function* () {
      const pkg = yield* resolvePackage(ctx, packageName)
      const layoutProgram = ctx.engine.getProgram(pkg.tsconfigPath)
      const layoutProject = ctx.engine.getProject(pkg.tsconfigPath)
      const exportSources = collectSnippetExportSources(layoutProgram, layoutProject, pkg)
      const snippetDir = resolveSnippetDirectory(layoutProgram, pkg)
      const importPlan = buildSnippetImportPlan(exportSources, snippetDir, true)
      const snippetContent = createEvalSnippetContent(expression, importPlan)

      const snippetProject = loadSnippetProject(ctx, pkg, snippetContent)
      try {
        const diagnostics = snippetProject.program.getSemanticDiagnostics(snippetProject.snippetPath)
        const relevantDiagnostics = diagnostics.filter(
          (diagnostic) => diagnostic.category === DiagnosticCategory.Error,
        )
        if (relevantDiagnostics.length > 0) {
          const mapped = mapSnippetDiagnostics(
            relevantDiagnostics,
            snippetProject.snippetSourceFile,
            snippetProject.importLineCount,
          )
          const first = mapped[0]
          return { error: first?.message ?? "Could not evaluate type expression" }
        }

        const typeAlias = findEvalTypeAlias(snippetProject.snippetSourceFile)
        if (typeAlias === undefined) {
          return { error: "Failed to parse type expression" }
        }

        const checker = snippetProject.project.checker
        const type = checker.getTypeFromTypeNode(typeAlias.type)
        const result = typeAlias.type.getText(snippetProject.snippetSourceFile)
        const expanded = checker.typeToString(
          type,
          typeAlias,
          NodeBuilderFlags.NoTruncation | NodeBuilderFlags.InTypeAlias,
        )
        return { result, expanded }
      } finally {
        snippetProject.dispose()
      }
    })
