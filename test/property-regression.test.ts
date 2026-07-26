import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { isAbsolute, join, relative } from "node:path"
import { describe, expect, it } from "vitest"
import { createTypeAnalyzer, type VerificationStatus } from "@skastr0/quartz-engine"
import { fixturesPath } from "./helpers/analyzer"

const repoRoot = join(fixturesPath, "..", "..")
const cliEntry = "apps/cli/src/main.ts"
const cliTestTimeout = 60_000
const cliSpawnTimeoutMs = 20_000

const verificationRank: Record<VerificationStatus, number> = {
  unverifiable: 0,
  unverified: 1,
  verified: 2,
}

const runCli = (args: readonly string[]) =>
  spawnSync("bun", ["run", cliEntry, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: cliSpawnTimeoutMs,
  })

const parse = (text: string) => JSON.parse(text) as Record<string, any>
const unpackCommandData = (data: unknown) => (
  typeof data === "string" ? JSON.parse(data) : data
) as Record<string, any>

const expectExampleData = (command: string, data: Record<string, any>) => {
  switch (command) {
    case "info":
      expect(data).toMatchObject({ name: "User", kind: "interface" })
      break
    case "graph":
      expect(data.graph).toContain("ExtendedUser")
      break
    case "refactor-preview":
      expect(data).toMatchObject({ action: "rename", from: "RefactorUser", to: "RenamedUser" })
      expect(data.totalLocations).toBeGreaterThan(0)
      break
    case "transform-search":
      expect(data.results[0]).toMatchObject({
        name: expect.stringContaining("toDTO"),
        verification: expect.objectContaining({ status: "verified" }),
      })
      break
    case "verify-contract":
      expect(data).toMatchObject({
        schemaVersion: "verify-contract/v1",
        ok: true,
        checks: {
          snippet: { passed: true },
          diagnostics: { passed: true },
          transform: { passed: true },
        },
      })
      break
  }
}


describe("property-style regression invariants", () => {
  it("preserves batch result ordering across payload families and concurrency settings", () => {
    const cases = [
      { symbols: ["User", "UserDTO", "ExtendedUser"], concurrency: 1 },
      { symbols: ["MissingSymbol", "User", "Role"], concurrency: 2 },
      { symbols: ["User", "User", "MissingSymbol", "UserDTO"], concurrency: 4 },
    ] as const

    for (const { symbols, concurrency } of cases) {
      const payloads = symbols.map((symbol) => ({ root: fixturesPath, symbol }))
      const result = runCli(["info", JSON.stringify(payloads), "--concurrency", String(concurrency)])
      const missingCount = symbols.filter((symbol) => symbol === "MissingSymbol").length

      expect(result.status).toBe(missingCount === 0 ? 0 : 1)
      expect(result.stderr).toBe("")

      const envelope = parse(result.stdout)
      const rows = envelope.data.results
      expect(rows).toHaveLength(symbols.length)
      expect(envelope.data).toMatchObject({
        total: symbols.length,
        success_count: symbols.length - missingCount,
        error_count: missingCount,
        concurrency,
      })

      for (const [index, row] of rows.entries()) {
        expect(row.index).toBe(index)
        expect(row.target.symbol).toBe(symbols[index])
        expect(row.ok).toBe(symbols[index] !== "MissingSymbol")
      }
    }
  }, cliTestTimeout)

  it("keeps schema examples executable and aligned with example payloads", () => {
    const commands = ["info", "transform-search", "verify-contract"] as const

    for (const command of commands) {
      const schema = runCli(["schema", "show", command])
      const example = runCli(["examples", "show", command])

      expect(schema.status).toBe(0)
      expect(example.status).toBe(0)

      const schemaEnvelope = parse(schema.stdout)
      const exampleEnvelope = parse(example.stdout)
      expect(schemaEnvelope.data.example).toEqual(exampleEnvelope.data.payload)

      const execution = runCli([command, JSON.stringify(exampleEnvelope.data.payload)])
      expect(execution.status).toBe(0)
      expect(execution.stderr).toBe("")
      const executionEnvelope = parse(execution.stdout)
      expect(executionEnvelope).toMatchObject({ ok: true, command })
      expectExampleData(command, unpackCommandData(executionEnvelope.data))
    }
  }, cliTestTimeout)

  it("writes artifact output as parseable JSON at reported paths", () => {
    const commands = [
      ["graph", { root: fixturesPath, symbol: "ExtendedUser" }],
      ["refactor-preview", { root: fixturesPath, symbol: "RefactorUser", to: "RenamedUser" }],
      ["verify-contract", {
        root: fixturesPath,
        from: "User",
        to: "UserDTO",
        symbol: "toDTO",
        snippet: "const user: User = { id: '1', name: 'Ada', email: 'ada@example.com' }; const dto: UserDTO = toDTO(user);",
      }],
    ] as const

    for (const [command, payload] of commands) {
      const artifactDir = mkdtempSync(join(tmpdir(), "quartz-property-artifacts-"))
      const result = runCli([command, JSON.stringify(payload), "--output", "artifact", "--artifact-dir", artifactDir])

      expect(result.status).toBe(0)
      expect(result.stderr).toBe("")

      const envelope = parse(result.stdout)
      const artifact = envelope.data.artifact
      const artifactPath = artifact.absolute_path
      const relativeToArtifactDir = relative(artifactDir, artifactPath)
      const body = readFileSync(artifactPath, "utf8")
      const parsedArtifact = JSON.parse(body)

      expect(envelope).toMatchObject({
        ok: true,
        command,
        data: {
          kind: "summary+artifact",
          artifact: { kind: "json" },
        },
      })
      expect(isAbsolute(artifactPath)).toBe(true)
      expect(relativeToArtifactDir).not.toBe("")
      expect(relativeToArtifactDir.startsWith("..")).toBe(false)
      expect(artifact.relative_path).toBe(relative(repoRoot, artifactPath))
      expect(existsSync(artifactPath)).toBe(true)
      expect(artifact.size_bytes).toBe(Buffer.byteLength(JSON.stringify(parsedArtifact, null, 2), "utf8"))
      expectExampleData(command, unpackCommandData(parsedArtifact))
    }
  }, cliTestTimeout)

  it("preserves transform-search trust filters and failed evidence invariants", async () => {
    const analyzer = await createTypeAnalyzer(fixturesPath)
    const minimumStatuses = ["unverifiable", "unverified", "verified"] as const

    try {
      for (const minimum of minimumStatuses) {
        const response = await analyzer.transformSearch({
          from: "User",
          to: "CreateUserRequest",
          includeFailedVerification: true,
          minVerificationStatus: minimum,
          limit: 50,
        })

        expect(response.query.options.minVerificationStatus).toBe(minimum)
        expect(response.results.every((result) => (
          verificationRank[result.verification.status] >= verificationRank[minimum]
        ))).toBe(true)
      }

      const verifiedOnly = await analyzer.transformSearch({
        from: "User",
        to: "CreateUserRequest",
        includeFailedVerification: true,
        verifiedOnly: true,
        limit: 50,
      })
      expect(verifiedOnly.results.length).toBeGreaterThan(0)
      expect(verifiedOnly.results.every((result) => result.verification.status === "verified")).toBe(true)
    } finally {
      await analyzer.dispose()
    }

    const failingRoot = mkdtempSync(join(tmpdir(), "quartz-property-transform-failure-"))
    mkdirSync(join(failingRoot, "src"), { recursive: true })
    writeFileSync(
      join(failingRoot, "tsconfig.json"),
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
      join(failingRoot, "src", "transforms.ts"),
      [
        "export interface SourceShape { id: string }",
        "export interface TargetShape { id: string; displayName: string }",
        "export type TargetShapePlus = TargetShape & { extra: string }",
        "export class SecretMapper {",
        "  private constructor() {}",
        "  private map(value: SourceShape): TargetShapePlus {",
        "    return { ...value, displayName: value.id, extra: value.id }",
        "  }",
        "}",
      ].join("\n"),
      "utf8",
    )
    const failingAnalyzer = await createTypeAnalyzer(failingRoot)
    try {
      const failedEvidenceCases = [
        { includeFailedVerification: false, includeDiagnostics: true, includeSyntheticCode: true, exposesFailure: false },
        { includeFailedVerification: true, includeDiagnostics: false, includeSyntheticCode: false, exposesFailure: true },
        { includeFailedVerification: true, includeDiagnostics: true, includeSyntheticCode: true, exposesFailure: true },
      ] as const

      for (const options of failedEvidenceCases) {
        const response = await failingAnalyzer.transformSearch({
          from: "SourceShape",
          to: "TargetShape",
          ...options,
          limit: 10,
        })
        const failed = response.results.find((result) => result.verification.reason === "synthetic_check_failed")

        expect(Boolean(failed)).toBe(options.exposesFailure)
        if (failed === undefined) continue

        expect(failed.verification.status).not.toBe("verified")
        expect(failed.confidence).not.toBe("high")
        expect(failed.verification.diagnostics === undefined).toBe(!options.includeDiagnostics)
        expect(failed.verification.syntheticCode === undefined).toBe(!options.includeSyntheticCode)
      }
    } finally {
      await failingAnalyzer.dispose()
    }
  }, cliTestTimeout)

  it("keeps refactor preview locations inside project-relative TypeScript files", async () => {
    const analyzer = await createTypeAnalyzer(fixturesPath)
    const renameTargets = [
      { symbol: "RefactorUser", to: "RenamedUser" },
      { symbol: "RefactorUserProfile", to: "RenamedProfile" },
    ] as const

    try {
      for (const target of renameTargets) {
        const preview = await analyzer.previewRefactor({ action: "rename", symbol: target.symbol, to: target.to })
        const files = [
          ...preview.locations.map((location) => location.file),
          ...preview.predictedErrors.map((error) => error.file),
          ...preview.stringLiteralLocations.map((location) => location.file),
          ...preview.commentLocations.map((location) => location.file),
        ]

        expect(preview.totalLocations).toBeGreaterThan(0)
        expect(files.length).toBeGreaterThan(0)
        for (const file of files) {
          const resolvedPath = join(fixturesPath, file)
          const relativeToFixtureRoot = relative(fixturesPath, resolvedPath)

          expect(file).not.toBe("")
          expect(file).not.toMatch(/^(\.\.|\/)/)
          expect(relativeToFixtureRoot.startsWith("..")).toBe(false)
          expect(file.endsWith(".ts")).toBe(true)
          expect(existsSync(resolvedPath)).toBe(true)
        }
      }
    } finally {
      await analyzer.dispose()
    }
  })
})
