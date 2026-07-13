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

const commandData = (envelope: any): any =>
  typeof envelope.data === "string" ? JSON.parse(envelope.data) : envelope.data

const repoRoot = process.cwd()
const cliEntry = "apps/cli/src/main.ts"
const fixtureRoot = "test/fixtures"
const tempDir = mkdtempSync(join(tmpdir(), "quartz-doc-examples-"))
const payloadFile = "payloads/info.json"
const batchFile = "payloads/info-batch.json"
const graphPayloadFile = "payloads/graph.json"
const transformSearchPayloadFile = "payloads/transform-search.json"
const artifactDir = join(tempDir, "artifacts")
const multiPackageRoot = join(tempDir, "multi-package")
const leafPackage = "packages/leaf"

mkdirSync(join(multiPackageRoot, "src"), { recursive: true })
mkdirSync(join(multiPackageRoot, leafPackage, "src"), { recursive: true })
const transformFailureRoot = join(tempDir, "transform-failure")
mkdirSync(join(transformFailureRoot, "src"), { recursive: true })
writeFileSync(join(multiPackageRoot, "tsconfig.json"), JSON.stringify({ include: ["src/**/*.ts"] }), "utf8")
writeFileSync(join(multiPackageRoot, "src", "root.ts"), "export interface RootOnly { root: string }\n", "utf8")
writeFileSync(join(multiPackageRoot, leafPackage, "tsconfig.json"), JSON.stringify({ include: ["src/**/*.ts"] }), "utf8")
writeFileSync(join(multiPackageRoot, leafPackage, "src", "leaf.ts"), "export interface LeafOnly { leaf: string }\n", "utf8")
writeFileSync(
  join(transformFailureRoot, "tsconfig.json"),
  JSON.stringify({
    compilerOptions: {
      target: "ESNext",
      module: "ESNext",
      moduleResolution: "bundler",
      strict: true,
      skipLibCheck: true,
      noEmit: true,
    },
    include: ["src/**/*.ts"],
  }),
  "utf8",
)
writeFileSync(
  join(transformFailureRoot, "src", "transforms.ts"),
  [
    "export interface SourceShape { id: string }",
    "export interface TargetShape { id: string; displayName: string }",
    "export type TargetShapePlus = TargetShape & { extra: string }",
    "export class SecretMapper {",
    "  private constructor() {}",
    "  map(value: SourceShape): TargetShapePlus {",
    "    return { ...value, displayName: value.id, extra: value.id }",
    "  }",
    "}",
  ].join("\n"),
  "utf8",
)

const checks: readonly CommandCheck[] = [
  { name: "capabilities", args: ["capabilities"] },
  { name: "schema list", args: ["schema", "list"] },
  { name: "schema show graph", args: ["schema", "show", "graph"] },
  { name: "examples list", args: ["examples", "list"] },
  { name: "examples show info", args: ["examples", "show", "info"] },
  { name: "doctor", args: ["doctor", JSON.stringify({ root: fixtureRoot })] },
  {
    name: "doctor fitness checks",
    args: ["doctor", JSON.stringify({ root: fixtureRoot })],
    assert: (envelope) => {
      const commands = envelope.data?.fitness_checks?.map((check: any) => check.command) ?? []
      for (const expected of [
        "bunx vitest run test/engine-*.test.ts",
        "bun run verify:package-boundaries",
        "bun run verify:docs-examples",
        "bun run verify:regression-guard",
      ]) {
        if (!commands.includes(expected)) {
          throw new Error(`doctor did not report fitness check ${expected}: ${commands.join(", ")}`)
        }
      }
    },
  },
  { name: "inline info", args: ["info", JSON.stringify({ root: fixtureRoot, symbol: "User" })] },
  { name: "@file info", args: ["info", `@${payloadFile}`] },
  { name: "stdin info", args: ["info", "-"], input: readFileSync(payloadFile, "utf8") },
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
      `@${graphPayloadFile}`,
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
  {
    name: "transform-search",
    args: ["transform-search", `@${transformSearchPayloadFile}`],
    assert: (envelope) => {
      const first = commandData(envelope)?.results?.[0]
      if (
        typeof first?.verification?.status !== "string" ||
        !("method" in first.verification) ||
        typeof first.verification.reason !== "string"
      ) {
        throw new Error(`transform-search did not include verification metadata: ${JSON.stringify(first)}`)
      }
    },
  },
  {
    name: "verify-contract",
    args: [
      "verify-contract",
      JSON.stringify({
        root: fixtureRoot,
        from: "User",
        to: "UserDTO",
        symbol: "toDTO",
        snippet: "const user: User = { id: '1', name: 'Ada', email: 'ada@example.com' }; const dto: UserDTO = toDTO(user);",
      }),
    ],
    assert: (envelope) => {
      const data = envelope.data
      if (
        data?.schemaVersion !== "verify-contract/v1" ||
        data?.ok !== true ||
        data?.checks?.transform?.passed !== true ||
        data?.checks?.snippet?.passed !== true ||
        data?.evidence?.transformSearch?.results?.[0]?.verification?.status !== "verified"
      ) {
        throw new Error(`verify-contract did not return passing evidence: ${JSON.stringify(data)}`)
      }
    },
  },
  {
    name: "transform-search verifiedOnly",
    args: [
      "transform-search",
      JSON.stringify({
        root: fixtureRoot,
        from: "User",
        to: "CreateUserRequest",
        includeFailedVerification: true,
        verifiedOnly: true,
        limit: 10,
      }),
    ],
    assert: (envelope) => {
      const results = commandData(envelope)?.results ?? []
      if (results.length === 0 || results.some((result: any) => result.verification?.status !== "verified")) {
        throw new Error(`verifiedOnly returned non-verified results: ${JSON.stringify(results)}`)
      }
    },
  },
  {
    name: "transform-search minVerificationStatus",
    args: [
      "transform-search",
      JSON.stringify({
        root: fixtureRoot,
        from: "User",
        includeFailedVerification: true,
        minVerificationStatus: "unverified",
        limit: 10,
      }),
    ],
    assert: (envelope) => {
      const results = commandData(envelope)?.results ?? []
      if (
        results.length === 0 ||
        results.some((result: { readonly verification?: { readonly status?: string } }) => result.verification?.status !== "unverified")
      ) {
        throw new Error(`minVerificationStatus did not preserve unverified partial matches: ${JSON.stringify(results)}`)
      }
    },
  },
  {
    name: "transform-search failed verification evidence",
    args: [
      "transform-search",
      JSON.stringify({
        root: transformFailureRoot,
        from: "SourceShape",
        to: "TargetShape",
        includeFailedVerification: true,
        includeDiagnostics: true,
        includeSyntheticCode: true,
        limit: 10,
      }),
    ],
    assert: (envelope) => {
      const failed = commandData(envelope)?.results?.find(
        (result: any) => result.verification?.reason === "synthetic_check_failed",
      )
      if (
        failed?.verification?.status !== "unverified" ||
        !Array.isArray(failed.verification.diagnostics) ||
        !failed.verification.diagnostics.some((diagnostic: any) =>
          typeof diagnostic.message === "string" && diagnostic.message.includes("SecretMapper"),
        ) ||
        typeof failed.verification.syntheticCode !== "string" ||
        !failed.verification.syntheticCode.includes("SecretMapper")
      ) {
        throw new Error(`failed verification evidence was not exposed: ${JSON.stringify(failed)}`)
      }
    },
  },
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
