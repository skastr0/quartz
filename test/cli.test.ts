import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join, relative } from "node:path"
import { spawnSync } from "node:child_process"
import { afterEach, describe, expect, it } from "vitest"
import { fixturesPath } from "./helpers/analyzer"
import { __testing } from "../apps/cli/src/main"

const repoRoot = join(fixturesPath, "..", "..")
const cliEntry = "apps/cli/src/main.ts"

const runCli = (args: readonly string[], input?: string, env: NodeJS.ProcessEnv = {}) =>
  spawnSync("bun", ["run", cliEntry, ...args], {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    input,
    encoding: "utf8",
  })

const parse = (text: string) => JSON.parse(text) as Record<string, any>
const cliTestTimeout = 20_000

afterEach(async () => {
  await __testing.clearAnalyzerCache()
})

describe("agentic CLI protocol", () => {
  it("reuses analyzers by normalized root without changing payload-facing roots", async () => {
    await __testing.clearAnalyzerCache()

    const first = __testing.analyzerFor({ root: "test/fixtures" })
    const second = __testing.analyzerFor({ root: "./test/fixtures" })

    expect(first).toBe(second)
    expect(__testing.cacheRootOf({ root: "test/fixtures" })).toBe(__testing.cacheRootOf({ root: "./test/fixtures" }))
    expect(__testing.analyzerCacheSize()).toBe(1)
  })

  it("keeps relative roots visible in response targets", () => {
    const result = runCli([
      "diagnostics",
      JSON.stringify([
        { root: "test/fixtures" },
        { root: "./test/fixtures" },
      ]),
    ])

    expect(result.status).toBe(0)
    expect(result.stderr).toBe("")
    const envelope = parse(result.stdout)
    expect(envelope.data.results.map((item: any) => item.target.root)).toEqual(["test/fixtures", "./test/fixtures"])
  }, cliTestTimeout)

  it("accepts inline, @file, and stdin JSON payloads", () => {
    const payload = { root: fixturesPath, symbol: "User" }
    const payloadFile = join(mkdtempSync(join(tmpdir(), "tlt-payload-")), "payload.json")
    writeFileSync(payloadFile, JSON.stringify(payload), "utf8")

    const inline = runCli(["info", JSON.stringify(payload)])
    const file = runCli(["info", `@${payloadFile}`])
    const stdin = runCli(["info", "-"], JSON.stringify(payload))

    for (const result of [inline, file, stdin]) {
      expect(result.status).toBe(0)
      expect(result.stderr).toBe("")
      const envelope = parse(result.stdout)
      expect(envelope).toMatchObject({
        ok: true,
        command: "info",
        data: { name: "User", kind: "interface" },
      })
    }
  }, cliTestTimeout)

  it("writes expected failures as stderr envelopes", () => {
    const result = runCli(["info", JSON.stringify({ root: fixturesPath })])

    expect(result.status).toBe(1)
    expect(result.stdout).toBe("")
    expect(parse(result.stderr)).toMatchObject({
      ok: false,
      command: "info",
      error: {
        type: "CommandInputError",
        details: {
          retryable: false,
        },
      },
    })
  }, cliTestTimeout)

  it("surfaces unresolved transform queries as stable engine errors", () => {
    const result = runCli([
      "transform-search",
      JSON.stringify({ root: fixturesPath, from: 'Pick<User, "id">', to: "UserDTO" }),
    ])

    expect(result.status).toBe(1)
    expect(result.stdout).toBe("")
    expect(parse(result.stderr)).toMatchObject({
      ok: false,
      command: "transform-search",
      error: {
        type: "QuartzEngineError",
        message: expect.stringContaining("Declare an exported named type or alias"),
        details: {
          code: "TRANSFORM_QUERY_UNRESOLVED",
          retryable: false,
          next_step: "Declare an exported named type or alias and retry.",
        },
      },
    })
  }, cliTestTimeout)

  it("preserves unresolved query failures inside ordered batches", () => {
    const result = runCli([
      "transform-search",
      JSON.stringify([
        { root: fixturesPath, from: "User", to: "UserDTO" },
        { root: fixturesPath, from: "DefinitelyNotAType", to: "UserDTO" },
      ]),
    ])

    expect(result.status).toBe(1)
    expect(result.stderr).toBe("")
    expect(parse(result.stdout)).toMatchObject({
      ok: true,
      command: "transform-search",
      data: {
        outcome: "partial_failure",
        success_count: 1,
        error_count: 1,
        results: [
          { index: 0, ok: true, target: { from: "User", to: "UserDTO" } },
          {
            index: 1,
            ok: false,
            target: { from: "DefinitelyNotAType", to: "UserDTO" },
            error: {
              type: "QuartzEngineError",
              details: { code: "TRANSFORM_QUERY_UNRESOLVED", retryable: false },
            },
          },
        ],
      },
    })
  }, cliTestTimeout)

  it("returns ordered batch results with partial failure semantics", () => {
    const result = runCli([
      "info",
      JSON.stringify([
        { root: fixturesPath, symbol: "User" },
        { root: fixturesPath, symbol: "MissingSymbol" },
      ]),
    ])

    expect(result.status).toBe(1)
    expect(result.stderr).toBe("")

    const envelope = parse(result.stdout)
    expect(envelope).toMatchObject({
      ok: true,
      command: "info",
      data: {
        outcome: "partial_failure",
        total: 2,
        success_count: 1,
        error_count: 1,
        concurrency: 5,
      },
    })
    expect(envelope.data.results.map((item: any) => item.index)).toEqual([0, 1])
    expect(envelope.data.results[0]).toMatchObject({ ok: true, target: { symbol: "User" } })
    expect(envelope.data.results[1]).toMatchObject({
      ok: false,
      target: { symbol: "MissingSymbol" },
      error: { type: "NotFoundError" },
    })
  }, cliTestTimeout)

  it("writes default artifact-mode output under Quartz home", () => {
    const quartzHome = mkdtempSync(join(tmpdir(), "quartz-home-"))
    const result = runCli([
      "graph",
      JSON.stringify({ root: fixturesPath, symbol: "ExtendedUser" }),
      "--output",
      "artifact",
    ], undefined, { QUARTZ_HOME: quartzHome })

    expect(result.status).toBe(0)
    expect(result.stderr).toBe("")

    const envelope = parse(result.stdout)
    expect(envelope).toMatchObject({
      ok: true,
      command: "graph",
      data: {
        kind: "summary+artifact",
        artifact: { kind: "json" },
      },
    })
    const artifactPath = envelope.data.artifact.absolute_path
    const relativeToHomeArtifacts = relative(join(quartzHome, "artifacts"), artifactPath)
    expect(relativeToHomeArtifacts).not.toBe("")
    expect(relativeToHomeArtifacts.startsWith("..")).toBe(false)
    expect(readFileSync(artifactPath, "utf8")).toContain("ExtendedUser")
  }, cliTestTimeout)

  it("honors explicit artifact output directories for graph results", () => {
    const quartzHome = mkdtempSync(join(tmpdir(), "quartz-home-"))
    const artifactDir = mkdtempSync(join(tmpdir(), "tlt-artifacts-"))
    const result = runCli([
      "graph",
      JSON.stringify({ root: fixturesPath, symbol: "ExtendedUser" }),
      "--output",
      "artifact",
      "--artifact-dir",
      artifactDir,
    ], undefined, { QUARTZ_HOME: quartzHome })

    expect(result.status).toBe(0)
    expect(result.stderr).toBe("")

    const envelope = parse(result.stdout)
    expect(envelope).toMatchObject({
      ok: true,
      command: "graph",
      data: {
        kind: "summary+artifact",
        artifact: { kind: "json" },
      },
    })
    const artifactPath = envelope.data.artifact.absolute_path
    const relativeToExplicitArtifacts = relative(artifactDir, artifactPath)
    expect(relativeToExplicitArtifacts).not.toBe("")
    expect(relativeToExplicitArtifacts.startsWith("..")).toBe(false)
    expect(existsSync(artifactPath)).toBe(true)
    expect(readFileSync(artifactPath, "utf8")).toContain("ExtendedUser")
  }, cliTestTimeout)

  it("exposes capabilities, schemas, examples, and doctor discovery", () => {
    const quartzHome = mkdtempSync(join(tmpdir(), "quartz-home-"))
    const capabilities = runCli(["capabilities"], undefined, { QUARTZ_HOME: quartzHome })
    const schemaList = runCli(["schema", "list"])
    const schemas = runCli(["schema", "show", "graph"])
    const examplesList = runCli(["examples", "list"])
    const examples = runCli(["examples", "show", "info"])
    const doctor = runCli(["doctor", JSON.stringify({ root: fixturesPath })])

    expect(capabilities.status).toBe(0)
    expect(parse(capabilities.stdout)).toMatchObject({
      ok: true,
      data: {
        protocol: "agentic-cli/v1",
        runtime_storage: {
          home_env: "QUARTZ_HOME",
          home: quartzHome,
          artifact_dir: join(quartzHome, "artifacts"),
        },
      },
    })

    expect(schemas.status).toBe(0)
    expect(schemaList.status).toBe(0)
    expect(parse(schemaList.stdout)).toMatchObject({
      ok: true,
      command: "schema list",
      data: {
        schemas: expect.arrayContaining([expect.objectContaining({ name: "graph" })]),
      },
    })
    expect(parse(schemas.stdout)).toMatchObject({
      ok: true,
      command: "schema show",
      data: {
        name: "graph",
        json_schema: {
          required: ["symbol"],
        },
      },
    })

    expect(examples.status).toBe(0)
    expect(examplesList.status).toBe(0)
    expect(parse(examplesList.stdout)).toMatchObject({
      ok: true,
      command: "examples list",
      data: {
        examples: expect.arrayContaining([expect.objectContaining({ name: "info" })]),
      },
    })
    expect(parse(examples.stdout)).toMatchObject({
      ok: true,
      command: "examples show",
      data: {
        name: "info",
        payload: { symbol: "User" },
      },
    })

    expect(doctor.status).toBe(0)
    expect(parse(doctor.stdout)).toMatchObject({
      ok: true,
      command: "doctor",
      data: {
        ok: true,
        package_count: 1,
        fitness_checks: expect.arrayContaining([
          expect.objectContaining({ command: "bun run verify:native-engine" }),
          expect.objectContaining({ command: "bun run verify:package-boundaries" }),
          expect.objectContaining({ command: "bun run verify:docs-examples" }),
          expect.objectContaining({ command: "bun run verify:regression-guard" }),
        ]),
      },
    })
  }, cliTestTimeout)

  it("ignores an empty Quartz home override", () => {
    const capabilities = runCli(["capabilities"], undefined, { QUARTZ_HOME: "" })

    expect(capabilities.status).toBe(0)
    expect(parse(capabilities.stdout)).toMatchObject({
      ok: true,
      data: {
        runtime_storage: {
          home: join(homedir(), ".config", "quartz"),
          artifact_dir: join(homedir(), ".config", "quartz", "artifacts"),
        },
      },
    })
  }, cliTestTimeout)

  it("rejects payloads for list discovery commands", () => {
    const result = runCli(["schema", "list", JSON.stringify({ name: "graph" })])

    expect(result.status).toBe(1)
    expect(result.stdout).toBe("")
    expect(parse(result.stderr)).toMatchObject({
      ok: false,
      error: {
        type: "CommandInputError",
        details: {
          retryable: false,
        },
      },
    })
  }, cliTestTimeout)

  it("explains unquoted assignability errors through the CLI", () => {
    const result = runCli([
      "why-error",
      JSON.stringify({
        root: fixturesPath,
        code: 2322,
        message: "Type UserInput is not assignable to type User",
      }),
    ])

    expect(result.status).toBe(0)
    const envelope = parse(result.stdout)
    expect(envelope).toMatchObject({
      ok: true,
      command: "why-error",
      data: {
        explanation: expect.stringContaining("UserInput"),
        issues: [expect.objectContaining({ kind: "missing_property", property: "id" })],
      },
    })
  }, cliTestTimeout)

  it("verifies composed contract evidence through the CLI", () => {
    const result = runCli([
      "verify-contract",
      JSON.stringify({
        root: fixturesPath,
        from: "User",
        to: "UserDTO",
        symbol: "toDTO",
        snippet: "const user: User = { id: '1', name: 'Ada', email: 'ada@example.com' }; const dto: UserDTO = toDTO(user);",
      }),
    ])

    expect(result.status).toBe(0)
    expect(result.stderr).toBe("")
    const envelope = parse(result.stdout)
    expect(envelope).toMatchObject({
      ok: true,
      command: "verify-contract",
      data: {
        schemaVersion: "verify-contract/v1",
        ok: true,
        checks: {
          compatibility: { ran: true, passed: false, blocking: false },
          snippet: { ran: true, passed: true },
          diagnostics: { ran: true, passed: true },
          transform: { ran: true, passed: true },
        },
        evidence: {
          transformSearch: {
            results: expect.arrayContaining([
              expect.objectContaining({
                name: expect.stringContaining("toDTO"),
                verification: expect.objectContaining({ status: "verified" }),
              }),
            ]),
          },
        },
      },
    })
  }, cliTestTimeout)

  it("builds the CLI bundle", () => {
    const result = spawnSync("bun", ["run", "cli:build"], {
      cwd: repoRoot,
      encoding: "utf8",
    })

    expect(result.status).toBe(0)
  }, 30_000)
})
