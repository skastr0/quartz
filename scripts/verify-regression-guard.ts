import { execFileSync } from "node:child_process"

interface GuardStep {
  readonly name: string
  readonly command: string
  readonly args: readonly string[]
  readonly covers: readonly string[]
}

const root = new URL("..", import.meta.url).pathname

const steps: readonly GuardStep[] = [
  {
    name: "Effect rewrite structure",
    command: "bun",
    args: ["run", "verify:effect-rewrite"],
    covers: [
      "core internals do not regain Effect.runPromise",
      "old analyzer/project manager path stays deleted",
      "runtime ownership remains at CLI/plugin edges",
    ],
  },
  {
    name: "Documented public CLI examples",
    command: "bun",
    args: ["run", "verify:docs-examples"],
    covers: [
      "packages/symbols/info/expand/search",
      "diagnostics/why-error/explain",
      "at-position/related/eval/check-snippet/file/compatible/graph/refactor-preview/transform-search/doctor",
      "inline JSON, @file, stdin, artifact output, and batch partial failure semantics",
    ],
  },
  {
    name: "CLI and plugin wrapper regression tests",
    command: "bun",
    args: ["run", "vitest", "run", "test/cli.test.ts", "test/opencode-plugin.test.ts", "test/refactor-coverage.test.ts"],
    covers: [
      "agentic CLI envelopes, discovery, artifacts, and batch behavior",
      "OpenCode tool registration, tool execution, refresh, and file-modification dirty marking",
      "refactor, diagnostics, explanation, related-symbol, snippet, file, and transform-search coverage",
    ],
  },
]

const results = steps.map((step) => {
  console.error(`[guard] ${step.name}`)
  execFileSync(step.command, [...step.args], {
    cwd: root,
    stdio: "inherit",
  })
  return {
    name: step.name,
    covers: step.covers,
  }
})

console.log(JSON.stringify({
  ok: true,
  steps: results,
}, null, 2))
