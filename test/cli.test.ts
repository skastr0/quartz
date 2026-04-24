import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawnSync } from "node:child_process"
import { describe, expect, it } from "vitest"
import { fixturesPath } from "./helpers/analyzer"

const repoRoot = join(fixturesPath, "..", "..")
const cliEntry = "apps/cli/src/main.ts"

const runCli = (args: readonly string[], input?: string) =>
  spawnSync("bun", ["run", cliEntry, ...args], {
    cwd: repoRoot,
    input,
    encoding: "utf8",
  })

const parse = (text: string) => JSON.parse(text) as Record<string, any>

describe("agentic CLI protocol", () => {
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
  })

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
  })

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
  })

  it("writes artifact-mode output for graph results", () => {
    const artifactDir = mkdtempSync(join(tmpdir(), "tlt-artifacts-"))
    const result = runCli([
      "graph",
      JSON.stringify({ root: fixturesPath, symbol: "ExtendedUser" }),
      "--output",
      "artifact",
      "--artifact-dir",
      artifactDir,
    ])

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
    expect(existsSync(artifactPath)).toBe(true)
    expect(readFileSync(artifactPath, "utf8")).toContain("ExtendedUser")
  })

  it("exposes capabilities, schemas, examples, and doctor discovery", () => {
    const capabilities = runCli(["capabilities"])
    const schemas = runCli(["schema", "show", "graph"])
    const examples = runCli(["examples", "show", "info"])
    const doctor = runCli(["doctor", JSON.stringify({ root: fixturesPath })])

    expect(capabilities.status).toBe(0)
    expect(parse(capabilities.stdout)).toMatchObject({
      ok: true,
      data: {
        protocol: "agentic-cli/v1",
      },
    })

    expect(schemas.status).toBe(0)
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
      },
    })
  })

  it("builds the CLI bundle", () => {
    const result = spawnSync("bun", ["run", "cli:build"], {
      cwd: repoRoot,
      encoding: "utf8",
    })

    expect(result.status).toBe(0)
  }, 30_000)
})
