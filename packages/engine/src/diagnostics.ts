import { DiagnosticCategory, type Diagnostic, type Project } from "typescript/unstable/async"
import type { DiagnosticSeverity, EngineDiagnostic } from "./types"

const severityFor = (category: DiagnosticCategory): DiagnosticSeverity => {
  switch (category) {
    case DiagnosticCategory.Error:
      return "error"
    case DiagnosticCategory.Warning:
      return "warning"
    case DiagnosticCategory.Suggestion:
      return "suggestion"
    case DiagnosticCategory.Message:
      return "message"
  }
}

const lineAndColumnAt = (text: string, position: number): { readonly line: number; readonly column: number } => {
  const bounded = Math.max(0, Math.min(position, text.length))
  let line = 1
  let lineStart = 0
  for (let index = 0; index < bounded; index += 1) {
    if (text.charCodeAt(index) === 10) {
      line += 1
      lineStart = index + 1
    }
  }
  return { line, column: bounded - lineStart + 1 }
}

const diagnosticKey = (diagnostic: Diagnostic): string =>
  [diagnostic.fileName ?? "", diagnostic.pos, diagnostic.end, diagnostic.code, diagnostic.category, diagnostic.text].join("\u0000")

export const collectDiagnostics = async (project: Project): Promise<readonly EngineDiagnostic[]> => {
  const diagnosticGroups = await Promise.all([
    project.program.getConfigFileParsingDiagnostics(),
    project.program.getSyntacticDiagnostics(),
    project.program.getSemanticDiagnostics(),
  ])
  const diagnostics = diagnosticGroups.flat()
  const unique = new Map<string, Diagnostic>()
  for (const diagnostic of diagnostics) unique.set(diagnosticKey(diagnostic), diagnostic)

  const sourceTextByFile = new Map<string, Promise<string | null>>()
  const sourceTextFor = (fileName: string): Promise<string | null> => {
    const cached = sourceTextByFile.get(fileName)
    if (cached !== undefined) return cached
    const pending = project.program.getSourceFile(fileName).then((sourceFile) => sourceFile?.text ?? null)
    sourceTextByFile.set(fileName, pending)
    return pending
  }

  const mapped = await Promise.all(
    [...unique.values()].map(async (diagnostic): Promise<EngineDiagnostic> => {
      if (diagnostic.fileName === undefined) {
        return {
          file: null,
          line: null,
          column: null,
          endLine: null,
          endColumn: null,
          code: diagnostic.code,
          severity: severityFor(diagnostic.category),
          message: diagnostic.text,
        }
      }

      const sourceText = await sourceTextFor(diagnostic.fileName)
      const start = sourceText === null ? null : lineAndColumnAt(sourceText, diagnostic.pos)
      const end = sourceText === null ? null : lineAndColumnAt(sourceText, diagnostic.end)
      return {
        file: diagnostic.fileName,
        line: start?.line ?? null,
        column: start?.column ?? null,
        endLine: end?.line ?? null,
        endColumn: end?.column ?? null,
        code: diagnostic.code,
        severity: severityFor(diagnostic.category),
        message: diagnostic.text,
      }
    }),
  )

  return mapped.sort((left, right) => {
    const fileOrder = (left.file ?? "").localeCompare(right.file ?? "")
    if (fileOrder !== 0) return fileOrder
    return (left.line ?? 0) - (right.line ?? 0) || (left.column ?? 0) - (right.column ?? 0) || left.code - right.code
  })
}
