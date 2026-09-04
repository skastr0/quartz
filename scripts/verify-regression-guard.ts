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
    name: "Native engine behavior",
    command: "bun",
    args: [
      "run",
      "vitest",
      "run",
      "test/engine-analyzer.test.ts",
      "test/engine-leaf-operations.test.ts",
      "test/engine-package-resolution.test.ts",
      "test/engine-reference-operations.test.ts",
      "test/engine-transform-search.test.ts",
      "test/engine-verification-operations.test.ts",
      "test/engine-workspace.test.ts",
      "test/typescript-unstable-contract.test.ts",
    ],
    covers: [
      "persistent workspace lifecycle and refresh semantics",
      "compiler-native analysis, references, transforms, and verification",
      "package selection, virtual files, disposal, and consumed TypeScript unstable APIs",
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
    args: [
      "run",
      "vitest",
      "run",
      "test/cli.test.ts",
      "test/opencode-plugin.test.ts",
      "test/property-regression.test.ts",
    ],
    covers: [
      "CLI and plugin wrapper regression tests",
      "property-style invariants for batch ordering, artifact records, trust filters, failed verification evidence, and refactor paths",
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
