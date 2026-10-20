import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawnSync } from "node:child_process"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { fixturesPath } from "./helpers/analyzer"

// tsrs panics on getAliasedSymbol for non-alias symbols (checker_08.rs:2155, "Should only get alias here").
// The panic lands on the backend's stderr while the request still succeeds, so only a stderr
// assertion catches a regression of the alias guard.
const repoRoot = join(fixturesPath, "..", "..")
const cliEntry = "apps/cli/src/main.ts"
const cliTestTimeout = 30_000

const runCli = (command: string, payload: Record<string, unknown>) =>
  spawnSync("bun", ["run", cliEntry, command, JSON.stringify(payload)], {
    cwd: repoRoot,
    env: process.env,
    encoding: "utf8",
  })

let barrelRoot = ""

beforeAll(() => {
  barrelRoot = mkdtempSync(join(tmpdir(), "quartz-tsrs-stderr-"))
  mkdirSync(join(barrelRoot, "src", "lib"), { recursive: true })
  writeFileSync(
    join(barrelRoot, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: { target: "ES2022", module: "ESNext", moduleResolution: "Bundler", strict: true, skipLibCheck: true },
      include: ["src"],
    }),
  )
  writeFileSync(
    join(barrelRoot, "src", "lib", "core.ts"),
    [
      "export interface Core { id: string; tags: string[] }",
      "export type CoreKey = keyof Core",
      "export const make = (id: string): Core => ({ id, tags: [] })",
      "export enum Level { Low = 1, High = 2 }",
      "export class Repo<T extends Core> { items: T[] = []; add(t: T): this { this.items.push(t); return this } }",
      "export namespace Util { export const x = 1; export type Alias = string }",
      "export default function def(a: number): string { return String(a) }",
    ].join("\n"),
  )
  writeFileSync(
    join(barrelRoot, "src", "barrel.ts"),
    [
      "export * from './lib/core'",
      "export { Core as RenamedCore, make as build } from './lib/core'",
      "export { default as defFn } from './lib/core'",
      "import * as NS from './lib/core'",
      "export { NS }",
      "export type { CoreKey as KeyAlias } from './lib/core'",
    ].join("\n"),
  )
  writeFileSync(
    join(barrelRoot, "src", "use.ts"),
    [
      "import { RenamedCore, build, NS, defFn, KeyAlias } from './barrel'",
      "export const c: RenamedCore = build('1')",
      "export const lv = NS.Level.High",
      "export const k: KeyAlias = 'id'",
      "export const d = defFn(3)",
    ].join("\n"),
  )
})

afterAll(() => {
  if (barrelRoot !== "") rmSync(barrelRoot, { recursive: true, force: true })
})

const symbolCommands = ["info", "expand", "related", "graph"] as const

describe("tsrs backend stderr stays clean", () => {
  it.each(["User", "ExtendedUser", "toDTO", "Role"])(
    "keeps stderr empty for symbol commands on fixtures symbol %s",
    (symbol) => {
      for (const command of symbolCommands) {
        const result = runCli(command, { root: "test/fixtures", symbol })
        expect(result.stderr, `${command} ${symbol}`).toBe("")
        expect(JSON.parse(result.stdout).ok, `${command} ${symbol}`).toBe(true)
      }
      const rename = runCli("refactor-preview", { root: "test/fixtures", symbol, to: `${symbol}Renamed` })
      expect(rename.stderr, `refactor-preview ${symbol}`).toBe("")
      expect(JSON.parse(rename.stdout).ok, `refactor-preview ${symbol}`).toBe(true)
    },
    cliTestTimeout,
  )

  it.each(["RenamedCore", "build", "defFn", "KeyAlias", "Core", "Repo", "Level"])(
    "keeps stderr empty for re-exported and aliased symbol %s",
    (symbol) => {
      for (const command of symbolCommands) {
        const result = runCli(command, { root: barrelRoot, symbol })
        expect(result.stderr, `${command} ${symbol}`).toBe("")
        expect(JSON.parse(result.stdout).ok, `${command} ${symbol}`).toBe(true)
      }
      const rename = runCli("refactor-preview", { root: barrelRoot, symbol, to: `${symbol}Renamed` })
      expect(rename.stderr, `refactor-preview ${symbol}`).toBe("")
      expect(JSON.parse(rename.stdout).ok, `refactor-preview ${symbol}`).toBe(true)
    },
    cliTestTimeout,
  )
})
