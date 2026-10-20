import { relative } from "node:path"
import type { Node, SourceFile } from "tsrs/unstable/ast"
import { DiagnosticCategory, SymbolFlags, type Diagnostic, type Project } from "tsrs/unstable/async"
import type { AnalyzerContext } from "./context"
import type { PackageInfo, RefactorError } from "./contracts"

export interface RenameEditSite {
  readonly sourceFile: SourceFile
  readonly node: Node
}

const namedMeaning = SymbolFlags.Value | SymbolFlags.Type | SymbolFlags.Namespace

const errorDiagnosticsOf = async (project: Project, files: readonly string[]): Promise<readonly Diagnostic[]> => {
  const [syntactic, semantic] = await Promise.all([
    project.program.getSyntacticDiagnostics(files),
    project.program.getSemanticDiagnostics(files),
  ])
  return [...syntactic, ...semantic].filter((diagnostic) => diagnostic.category === DiagnosticCategory.Error)
}

const wordPattern = (name: string): RegExp => new RegExp(`(?<![\\w$])${name.replace(/[$]/g, "\\$&")}(?![\\w$])`, "g")

const diagnosticKey = (file: string, diagnostic: Diagnostic, text: string): string =>
  `${file}\u0000${diagnostic.code}\u0000${text}`

const lineAt = (text: string, position: number): number => {
  let line = 1
  for (let index = 0; index < Math.min(position, text.length); index += 1) if (text.charCodeAt(index) === 10) line += 1
  return line
}

const applyRename = (sourceFile: SourceFile, sites: readonly RenameEditSite[], to: string): string => {
  const ranges = sites
    .map(({ node }) => ({ start: node.getStart(sourceFile), end: node.end }))
    .sort((left, right) => right.start - left.start)
  let text = sourceFile.text
  for (const { start, end } of ranges) text = `${text.slice(0, start)}${to}${text.slice(end)}`
  return text
}

/**
 * Names that already resolve at the target's declaration. Their files join the
 * diagnosed set because a collision is reported on the other declaration too.
 */
const collidingDeclarationFiles = async (project: Project, declaration: Node, to: string): Promise<readonly string[]> => {
  const existing = await project.checker.resolveName(to, namedMeaning, declaration, true)
  if (existing === undefined) return []
  const files = new Set<string>()
  for (const handle of existing.declarations) {
    const node = await handle.resolve(project)
    if (node !== undefined) files.add(node.getSourceFile().fileName)
  }
  return [...files]
}

/**
 * Apply the rename in a layered copy of the program and report the compiler
 * errors it introduces. Matching tsc beats a hand-rolled scope analysis:
 * duplicate declarations, merged declarations with different type parameters
 * (TS2428/TS2314), shadowing of globals and captured references all surface as diagnostics.
 */
export const predictRenameErrors = async (
  context: AnalyzerContext,
  pkg: PackageInfo,
  project: Project,
  declaration: Node,
  sites: readonly RenameEditSite[],
  from: string,
  to: string,
): Promise<readonly RefactorError[]> => {
  if (sites.length === 0 || from === to) return []
  const sitesByFile = new Map<string, RenameEditSite[]>()
  for (const site of sites) {
    const fileName = site.sourceFile.fileName
    const forFile = sitesByFile.get(fileName)
    if (forFile === undefined) sitesByFile.set(fileName, [site])
    else forFile.push(site)
  }
  const edited = [...sitesByFile.values()].map((fileSites) => ({
    path: fileSites[0]!.sourceFile.fileName,
    content: applyRename(fileSites[0]!.sourceFile, fileSites, to),
  }))
  const diagnosed = [...new Set([...sitesByFile.keys(), ...(await collidingDeclarationFiles(project, declaration, to))])]

  const baseline = new Map<string, number>()
  for (const diagnostic of await errorDiagnosticsOf(project, diagnosed)) {
    const key = diagnosticKey(diagnostic.fileName ?? "", diagnostic, diagnostic.text)
    baseline.set(key, (baseline.get(key) ?? 0) + 1)
  }

  const editedPaths = new Set(edited.map((file) => file.path))
  const toPattern = wordPattern(to)
  return context.workspace.withVirtualFiles(pkg.tsconfigPath, edited, async (renamed) => {
    const introduced: RefactorError[] = []
    const seenLines = new Set<string>()
    for (const diagnostic of await errorDiagnosticsOf(renamed, diagnosed)) {
      const fileName = diagnostic.fileName ?? ""
      // The renamed symbol appears under its new name in messages; compare under the old one.
      const key = diagnosticKey(fileName, diagnostic, diagnostic.text.replace(toPattern, from))
      const remaining = baseline.get(key) ?? 0
      if (remaining > 0) {
        baseline.set(key, remaining - 1)
        continue
      }
      const text = editedPaths.has(fileName)
        ? edited.find((file) => file.path === fileName)!.content
        : (await renamed.program.getSourceFile(fileName))?.text ?? ""
      const file = relative(context.root, fileName)
      const line = lineAt(text, diagnostic.pos)
      const message = `TS${diagnostic.code}: ${diagnostic.text}`
      const dedupe = `${file}:${line}:${message}`
      if (seenLines.has(dedupe)) continue
      seenLines.add(dedupe)
      introduced.push({ file, line, message })
    }
    return introduced
  })
}
