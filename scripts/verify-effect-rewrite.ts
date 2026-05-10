import { execFileSync } from "node:child_process"

const root = new URL("..", import.meta.url).pathname

const runRg = (pattern: string, paths: readonly string[]): string => {
  try {
    return execFileSync("rg", ["-n", "--glob", "!scripts/verify-effect-rewrite.ts", pattern, ...paths], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim()
  } catch (cause) {
    const status = typeof cause === "object" && cause !== null && "status" in cause ? cause.status : undefined
    if (status === 1) return ""
    throw cause
  }
}

const requireNoMatches = (label: string, pattern: string, paths: readonly string[]): void => {
  const output = runRg(pattern, paths)
  if (output.length > 0) {
    throw new Error(`${label} found forbidden matches:\n${output}`)
  }
}

const requireMatches = (label: string, pattern: string, paths: readonly string[], expected: readonly string[]): void => {
  const output = runRg(pattern, paths)
  for (const item of expected) {
    if (!output.includes(item)) {
      throw new Error(`${label} missing ${item}. Output:\n${output}`)
    }
  }
}

const coreAndEdges = ["packages/core/src", "apps", "test", "scripts", "README.md"]
const oldAnalyzerTerms = [
  "class Project" + "Manager",
  "new Project" + "Manager",
  "fromProject" + "Promise",
  "createType" + "Analyzer\\b",
].join("|")
const oldDocTerms = [
  "createType" + "AnalyzerRuntime",
  "Project" + "Manager",
  "fromProject" + "Promise",
  "partially Effect-" + "shaped",
  "not Effect-" + "native",
  "lacks runtime " + "ownership",
].join("|")

requireNoMatches("old analyzer path", oldAnalyzerTerms, coreAndEdges)
requireNoMatches("core runPromise", "Effect\\.runPromise", ["packages/core/src"])
requireNoMatches("repeated AppLayer provide", "Effect\\.provide\\(AppLayer|provide\\(AppLayer", ["packages/core/src", "apps"])
requireNoMatches(
  "old API docs",
  oldDocTerms,
  ["README.md", "docs"],
)

requireMatches("runtime ownership", "ManagedRuntime\\.make", ["apps"], [
  "apps/cli/src/main.ts",
  "apps/opencode-plugin/src/server.ts",
])

requireMatches("service definitions", "export class .*Effect\\.Service|export class AnalyzerConfig", ["packages/core/src/service-spine.ts"], [
  "AnalyzerConfig",
  "PackageDiscovery",
  "ProjectWorkspace",
  "SourceProjectCache",
  "SymbolLookup",
  "FileInspection",
  "SnippetEvaluation",
  "Diagnostics",
  "TypeRelations",
  "TypeExplainer",
  "RefactorPreview",
  "TypeGraph",
  "TransformSearch",
  "TypeAnalyzerService",
])

console.log("effect rewrite verification passed")
