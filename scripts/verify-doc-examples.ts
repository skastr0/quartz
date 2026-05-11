import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawnSync } from "node:child_process"

interface CommandCheck {
  readonly name: string
  readonly args: readonly string[]
  readonly input?: string
  readonly expectStatus?: number
  readonly assert?: (envelope: any, output: string) => void
}

const repoRoot = process.cwd()
const cliEntry = "apps/cli/src/main.ts"
const fixtureRoot = "test/fixtures"
const tempDir = mkdtempSync(join(tmpdir(), "quartz-doc-examples-"))
const payloadFile = join(tempDir, "info.json")
const batchFile = join(tempDir, "info-batch.json")
const artifactDir = join(tempDir, "artifacts")
const multiPackageRoot = join(tempDir, "multi-package")
const leafPackage = "packages/leaf"

writeFileSync(payloadFile, JSON.stringify({ root: fixtureRoot, symbol: "User" }), "utf8")
writeFileSync(
  batchFile,
  JSON.stringify([
    { root: fixtureRoot, symbol: "User" },
    { root: fixtureRoot, symbol: "MissingSymbol" },
  ]),
  "utf8",
)
mkdirSync(join(multiPackageRoot, "src"), { recursive: true })
mkdirSync(join(multiPackageRoot, leafPackage, "src"), { recursive: true })
writeFileSync(join(multiPackageRoot, "tsconfig.json"), JSON.stringify({ include: ["src/**/*.ts"] }), "utf8")
writeFileSync(join(multiPackageRoot, "src", "root.ts"), "export interface RootOnly { root: string }\n", "utf8")
writeFileSync(join(multiPackageRoot, leafPackage, "tsconfig.json"), JSON.stringify({ include: ["src/**/*.ts"] }), "utf8")
writeFileSync(join(multiPackageRoot, leafPackage, "src", "leaf.ts"), "export interface LeafOnly { leaf: string }\n", "utf8")

const checks: readonly CommandCheck[] = [
  { name: "capabilities", args: ["capabilities"] },
  { name: "schema list", args: ["schema", "list"] },
  { name: "schema show graph", args: ["schema", "show", "graph"] },
  { name: "examples list", args: ["examples", "list"] },
  { name: "examples show info", args: ["examples", "show", "info"] },
  { name: "doctor", args: ["doctor", JSON.stringify({ root: fixtureRoot })] },
  { name: "inline info", args: ["info", JSON.stringify({ root: fixtureRoot, symbol: "User" })] },
  { name: "@file info", args: ["info", `@${payloadFile}`] },
  { name: "stdin info", args: ["info", "-"], input: JSON.stringify({ root: fixtureRoot, symbol: "User" }) },
  {
    name: "pretty format",
    args: ["packages", JSON.stringify({ root: fixtureRoot }), "--format", "pretty"],
    assert: (_envelope, output) => {
      if (!output.includes("\n  \"ok\": true,")) {
        throw new Error("pretty output was not indented")
      }
    },
  },
  { name: "packages", args: ["packages", JSON.stringify({ root: fixtureRoot })] },
  { name: "symbols", args: ["symbols", JSON.stringify({ root: fixtureRoot, pattern: "^User", limit: 25 })] },
  {
    name: "package-scoped symbols route to selected package",
    args: ["symbols", JSON.stringify({ root: multiPackageRoot, package: leafPackage, limit: 25 })],
    assert: (envelope) => {
      const names = envelope.data?.symbols?.map((symbol: any) => symbol.name) ?? []
      if (!names.includes("LeafOnly") || names.includes("RootOnly")) {
        throw new Error(`package routing returned unexpected symbols: ${names.join(", ")}`)
      }
    },
  },
  { name: "expand", args: ["expand", JSON.stringify({ root: fixtureRoot, symbol: "User" })] },
  { name: "search", args: ["search", JSON.stringify({ root: fixtureRoot, query: "Role", limit: 10 })] },
  { name: "diagnostics", args: ["diagnostics", JSON.stringify({ root: fixtureRoot, explain: true })] },
  {
    name: "at-position",
    args: ["at-position", JSON.stringify({ root: fixtureRoot, file: "types/basic.ts", line: 9, column: 3 })],
  },
  { name: "related", args: ["related", JSON.stringify({ root: fixtureRoot, symbol: "User" })] },
  { name: "eval", args: ["eval", JSON.stringify({ root: fixtureRoot, expression: 'Pick<User, "id" | "name">' })] },
  {
    name: "check-snippet",
    args: ["check-snippet", JSON.stringify({ root: fixtureRoot, code: "const value = 1 satisfies number;" })],
  },
  { name: "file", args: ["file", JSON.stringify({ root: fixtureRoot, file: "types/basic.ts", includePrivate: false })] },
  { name: "compatible", args: ["compatible", JSON.stringify({ root: fixtureRoot, from: "ExtendedUser", to: "User" })] },
  {
    name: "graph artifact",
    args: [
      "graph",
      JSON.stringify({ root: fixtureRoot, symbol: "ExtendedUser", depth: 2, format: "mermaid" }),
      "--output",
      "artifact",
      "--artifact-dir",
      artifactDir,
    ],
    assert: (envelope) => {
      const artifactPath = envelope.data?.artifact?.absolute_path
      if (typeof artifactPath !== "string" || !existsSync(artifactPath)) {
        throw new Error("graph artifact was not written")
      }
      if (!readFileSync(artifactPath, "utf8").includes("ExtendedUser")) {
        throw new Error("graph artifact did not contain expected symbol")
      }
    },
  },
  {
    name: "refactor-preview",
    args: ["refactor-preview", JSON.stringify({ root: fixtureRoot, symbol: "RefactorUser", to: "RenamedUser" })],
  },
  {
    name: "why-error",
    args: [
      "why-error",
      JSON.stringify({
        root: fixtureRoot,
        code: 2322,
        message: "Type 'UserInput' is not assignable to type 'User'.",
      }),
    ],
  },
  { name: "explain", args: ["explain", JSON.stringify({ root: fixtureRoot, expression: 'Pick<User, "id" | "name">' })] },
  { name: "transform-search", args: ["transform-search", JSON.stringify({ root: fixtureRoot, from: "User", to: "UserDTO", limit: 5 })] },
  {
    name: "batch partial failure",
    args: ["info", `@${batchFile}`, "--concurrency", "2"],
    expectStatus: 1,
    assert: (envelope) => {
      if (envelope.data?.outcome !== "partial_failure") {
        throw new Error(`expected partial_failure, received ${String(envelope.data?.outcome)}`)
      }
    },
  },
  {
    name: "timeout flag validation",
    args: ["packages", JSON.stringify({ root: fixtureRoot }), "--timeout", "0"],
    expectStatus: 1,
    assert: (envelope) => {
      if (envelope.ok !== false || envelope.error?.type !== "CommandInputError") {
        throw new Error(`expected CommandInputError, received ${JSON.stringify(envelope)}`)
      }
    },
  },
]

const failures: string[] = []

for (const check of checks) {
  const result = spawnSync("bun", ["run", cliEntry, ...check.args], {
    cwd: repoRoot,
    input: check.input,
    encoding: "utf8",
    timeout: 20_000,
    maxBuffer: 1024 * 1024 * 16,
  })
  const expectedStatus = check.expectStatus ?? 0
  if (result.status !== expectedStatus) {
    failures.push(`${check.name}: expected exit ${expectedStatus}, got ${String(result.status)}; ${result.stderr || result.stdout}`)
    continue
  }
  const output = result.stdout || result.stderr
  try {
    const envelope = JSON.parse(output)
    if (check.expectStatus === undefined && envelope.ok !== true) {
      failures.push(`${check.name}: expected success envelope`)
    }
    check.assert?.(envelope, output)
  } catch (error) {
    failures.push(`${check.name}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

if (failures.length > 0) {
  console.error(failures.join("\n"))
  process.exit(1)
}

console.log(JSON.stringify({ checks: checks.length, ok: true }, null, 2))
