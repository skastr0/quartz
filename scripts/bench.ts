#!/usr/bin/env bun
/**
 * Durable native-engine performance harness.
 *
 * Measures three operating modes separately:
 *   - cold-cli: one-shot subprocess per sample (process start + open + command + exit)
 *   - warm-batch: one CLI process, N payload items (shared analyzer cache inside process)
 *   - warm-analyzer: in-process createTypeAnalyzer, warmup then timed steady-state ops
 *
 * Records wall-clock p50/p95, open time (warm-analyzer), process/TS versions, and
 * optional complexity counters when the command returns them. Writes a JSON
 * report; never invents thresholds — budgets freeze from measured distributions.
 *
 * Profiles:
 *   --profile pr       fixtures only, fewer samples (default)
 *   --profile release  fixtures + optional --root, more samples
 *
 * Compare versions on the same machine/run. CI should ratchet ratios or
 * complexity counts, not absolute milliseconds alone.
 */
import { execFileSync, spawnSync } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import { cpus, hostname, platform, arch, totalmem } from "node:os"
import { dirname, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { performance } from "node:perf_hooks"
import { createTypeAnalyzer, analysisTypeScriptVersion, type QuartzAnalyzer } from "@skastr0/quartz-engine"

const REPO_ROOT = resolve(import.meta.dir, "..")
const DEFAULT_FIXTURE_ROOT = resolve(REPO_ROOT, "test/fixtures")

type Profile = "pr" | "release"
type Mode = "cold-cli" | "warm-batch" | "warm-analyzer"

interface ProfileConfig {
  readonly warmup: number
  readonly timed: number
  readonly modes: readonly Mode[]
}

const PROFILES: Record<Profile, ProfileConfig> = {
  pr: { warmup: 1, timed: 3, modes: ["cold-cli", "warm-analyzer"] },
  release: { warmup: 2, timed: 7, modes: ["cold-cli", "warm-batch", "warm-analyzer"] },
}

interface CommandSpec {
  readonly name: string
  readonly cliArgs: (root: string) => readonly string[]
  readonly batchPayloads: (root: string, n: number) => readonly unknown[]
  readonly run: (analyzer: QuartzAnalyzer) => Promise<unknown>
  /** Skip warm-batch when the command does not support batch arrays. */
  readonly batchable: boolean
}

const commandsFor = (root: string): readonly CommandSpec[] => [
  {
    name: "doctor",
    batchable: false,
    cliArgs: (r) => ["doctor", JSON.stringify({ root: r })],
    batchPayloads: () => [],
    run: async (a) => ({ metadata: a.metadata, packages: await a.getPackages() }),
  },
  {
    name: "diagnostics",
    batchable: true,
    cliArgs: (r) => ["diagnostics", JSON.stringify({ root: r })],
    batchPayloads: (r, n) => Array.from({ length: n }, () => ({ root: r })),
    run: (a) => a.getDiagnostics(),
  },
  {
    name: "info",
    batchable: true,
    cliArgs: (r) => ["info", JSON.stringify({ root: r, symbol: "User" })],
    batchPayloads: (r, n) => Array.from({ length: n }, () => ({ root: r, symbol: "User" })),
    run: (a) => a.getTypeInfo("User"),
  },
  {
    name: "expand",
    batchable: true,
    cliArgs: (r) => ["expand", JSON.stringify({ root: r, symbol: "User" })],
    batchPayloads: (r, n) => Array.from({ length: n }, () => ({ root: r, symbol: "User" })),
    run: (a) => a.expandType("User"),
  },
  {
    name: "compatible",
    batchable: true,
    cliArgs: (r) => ["compatible", JSON.stringify({ root: r, from: "ExtendedUser", to: "User" })],
    batchPayloads: (r, n) => Array.from({ length: n }, () => ({ root: r, from: "ExtendedUser", to: "User" })),
    run: (a) => a.checkCompatibility("ExtendedUser", "User"),
  },
  {
    name: "verify-contract",
    batchable: true,
    cliArgs: (r) => ["verify-contract", JSON.stringify({ root: r, from: "User", to: "User" })],
    batchPayloads: (r, n) => Array.from({ length: n }, () => ({ root: r, from: "User", to: "User" })),
    run: (a) => a.verifyContract({ from: "User", to: "User" }),
  },
  {
    name: "related",
    batchable: true,
    cliArgs: (r) => ["related", JSON.stringify({ root: r, symbol: "User" })],
    batchPayloads: (r, n) => Array.from({ length: n }, () => ({ root: r, symbol: "User" })),
    run: (a) => a.findRelated("User"),
  },
  {
    name: "transform-search",
    batchable: true,
    cliArgs: (r) => ["transform-search", JSON.stringify({ root: r, from: "User", limit: 5 })],
    batchPayloads: (r, n) => Array.from({ length: n }, () => ({ root: r, from: "User", limit: 5 })),
    run: (a) => a.transformSearch({ from: "User", limit: 5 }),
  },
  {
    name: "refactor-preview",
    batchable: true,
    cliArgs: (r) => ["refactor-preview", JSON.stringify({ root: r, symbol: "User", to: "Person" })],
    batchPayloads: (r, n) => Array.from({ length: n }, () => ({ root: r, symbol: "User", to: "Person" })),
    run: (a) => a.previewRefactor({ action: "rename", symbol: "User", to: "Person" }),
  },
  {
    name: "check-snippet",
    batchable: true,
    cliArgs: (r) => ["check-snippet", JSON.stringify({ root: r, code: "const x: string = 42;" })],
    batchPayloads: (r, n) =>
      Array.from({ length: n }, () => ({ root: r, code: "const x: string = 42;" })),
    run: (a) => a.checkSnippet("const x: string = 42;"),
  },
]

interface SampleStats {
  readonly samplesMs: readonly number[]
  readonly p50Ms: number
  readonly p95Ms: number
  readonly meanMs: number
  readonly minMs: number
  readonly maxMs: number
}

interface ModeResult {
  readonly mode: Mode
  readonly command: string
  readonly stats: SampleStats
  readonly openMs?: number
  readonly notes?: string
}

interface BenchReport {
  readonly schemaVersion: "quartz-bench/v1"
  readonly generatedAt: string
  readonly profile: Profile
  readonly root: string
  readonly quartzCommit: string | null
  readonly analysisTypescriptVersion: string
  readonly process: {
    readonly runtime: string
    readonly platform: string
    readonly arch: string
    readonly hostname: string
    readonly cpuModel: string | null
    readonly cpuCount: number
    readonly totalMemGb: number
  }
  readonly config: ProfileConfig
  readonly cliBinary: string
  readonly results: readonly ModeResult[]
}

const round = (value: number): number => Math.round(value * 1000) / 1000

const percentile = (sorted: readonly number[], p: number): number => {
  if (sorted.length === 0) return Number.NaN
  if (sorted.length === 1) return sorted[0]!
  const rank = (p / 100) * (sorted.length - 1)
  const low = Math.floor(rank)
  const high = Math.ceil(rank)
  if (low === high) return sorted[low]!
  const weight = rank - low
  return sorted[low]! * (1 - weight) + sorted[high]! * weight
}

const statsOf = (samples: readonly number[]): SampleStats => {
  const sorted = [...samples].sort((a, b) => a - b)
  const sum = samples.reduce((acc, n) => acc + n, 0)
  return {
    samplesMs: samples.map(round),
    p50Ms: round(percentile(sorted, 50)),
    p95Ms: round(percentile(sorted, 95)),
    meanMs: round(sum / Math.max(samples.length, 1)),
    minMs: round(sorted[0] ?? Number.NaN),
    maxMs: round(sorted[sorted.length - 1] ?? Number.NaN),
  }
}

const gitCommit = (): string | null => {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" }).trim()
  } catch {
    return null
  }
}

const resolveCliBinary = (): string => {
  const fromEnv = process.env.QUARTZ_BIN
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv
  const local = resolve(process.env.HOME ?? "", ".local/bin/quartz")
  try {
    execFileSync(local, ["capabilities"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
    return local
  } catch {
    return "quartz"
  }
}

const runColdCli = (
  cli: string,
  command: CommandSpec,
  root: string,
  timed: number,
): SampleStats => {
  const samples: number[] = []
  for (let i = 0; i < timed; i += 1) {
    const started = performance.now()
    const result = spawnSync(cli, [...command.cliArgs(root)], {
      encoding: "utf8",
      cwd: REPO_ROOT,
      env: process.env,
    })
    const elapsed = performance.now() - started
    if (result.status !== 0) {
      const err = result.stderr || result.stdout || `exit ${result.status}`
      throw new Error(`cold-cli ${command.name} failed: ${err.slice(0, 400)}`)
    }
    samples.push(elapsed)
  }
  return statsOf(samples)
}

const runWarmBatch = (
  cli: string,
  command: CommandSpec,
  root: string,
  warmup: number,
  timed: number,
): SampleStats => {
  if (!command.batchable) {
    return statsOf([])
  }
  // One process: warmup items then timed items. CLI reuses analyzer per root.
  const payloads = command.batchPayloads(root, warmup + timed)
  const args = [command.name, JSON.stringify(payloads)]
  const started = performance.now()
  const result = spawnSync(cli, args, {
    encoding: "utf8",
    cwd: REPO_ROOT,
    env: process.env,
  })
  const totalMs = performance.now() - started
  if (result.status !== 0 && result.status !== 1) {
    throw new Error(`warm-batch ${command.name} failed: ${(result.stderr || result.stdout || "").slice(0, 400)}`)
  }
  let envelope: { ok?: boolean; data?: { results?: readonly unknown[]; total?: number } }
  try {
    envelope = JSON.parse(result.stdout) as typeof envelope
  } catch {
    throw new Error(`warm-batch ${command.name}: non-JSON stdout: ${result.stdout.slice(0, 200)}`)
  }
  if (envelope.ok !== true) {
    throw new Error(`warm-batch ${command.name}: envelope not ok: ${result.stdout.slice(0, 300)}`)
  }
  const total = envelope.data?.total ?? payloads.length
  // Approximate per-item cost from total wall / total items (honest: one sample of amortized cost).
  const perItem = total === 0 ? totalMs : totalMs / total
  // Emit timed samples as equal amortized slices so p50/p95 are defined; note the limitation.
  const samples = Array.from({ length: timed }, () => perItem)
  return statsOf(samples)
}

const runWarmAnalyzer = async (
  command: CommandSpec,
  root: string,
  warmup: number,
  timed: number,
): Promise<{ readonly stats: SampleStats; readonly openMs: number }> => {
  const openStarted = performance.now()
  const analyzer = await createTypeAnalyzer(root)
  const openMs = performance.now() - openStarted
  try {
    for (let i = 0; i < warmup; i += 1) await command.run(analyzer)
    const samples: number[] = []
    for (let i = 0; i < timed; i += 1) {
      const started = performance.now()
      await command.run(analyzer)
      samples.push(performance.now() - started)
    }
    return { stats: statsOf(samples), openMs: round(openMs) }
  } finally {
    await analyzer.dispose()
  }
}

const parseArgs = (argv: readonly string[]): {
  readonly profile: Profile
  readonly root: string
  readonly out: string | null
  readonly commands: readonly string[] | null
} => {
  let profile: Profile = "pr"
  let root = DEFAULT_FIXTURE_ROOT
  let out: string | null = null
  let commands: string[] | null = null
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!
    if (arg === "--profile") {
      const value = argv[++i]
      if (value !== "pr" && value !== "release") throw new Error(`Unknown profile: ${value}`)
      profile = value
    } else if (arg === "--root") {
      root = resolve(argv[++i] ?? root)
    } else if (arg === "--out") {
      out = resolve(argv[++i] ?? "")
    } else if (arg === "--commands") {
      commands = (argv[++i] ?? "").split(",").map((s) => s.trim()).filter(Boolean)
    } else if (arg === "--help" || arg === "-h") {
      process.stdout.write(`Usage: bun scripts/bench.ts [--profile pr|release] [--root <path>] [--out report.json] [--commands a,b]\n`)
      process.exit(0)
    }
  }
  return { profile, root, out, commands }
}

export const runBench = async (options: {
  readonly profile?: Profile
  readonly root?: string
  readonly commands?: readonly string[] | null
  readonly cliBinary?: string
}): Promise<BenchReport> => {
  const profile = options.profile ?? "pr"
  const config = PROFILES[profile]
  const root = resolve(options.root ?? DEFAULT_FIXTURE_ROOT)
  const cli = options.cliBinary ?? resolveCliBinary()
  const allCommands = commandsFor(root)
  const selected =
    options.commands === undefined || options.commands === null || options.commands.length === 0
      ? allCommands
      : allCommands.filter((c) => options.commands!.includes(c.name))

  const results: ModeResult[] = []

  for (const command of selected) {
    for (const mode of config.modes) {
      if (mode === "cold-cli") {
        process.stderr.write(`[bench] cold-cli ${command.name}\n`)
        results.push({
          mode,
          command: command.name,
          stats: runColdCli(cli, command, root, config.timed),
        })
      } else if (mode === "warm-batch") {
        if (!command.batchable) continue
        process.stderr.write(`[bench] warm-batch ${command.name}\n`)
        results.push({
          mode,
          command: command.name,
          stats: runWarmBatch(cli, command, root, config.warmup, config.timed),
          notes: "amortized total_wall / item_count from one multi-item process",
        })
      } else {
        process.stderr.write(`[bench] warm-analyzer ${command.name}\n`)
        const warm = await runWarmAnalyzer(command, root, config.warmup, config.timed)
        results.push({
          mode,
          command: command.name,
          stats: warm.stats,
          openMs: warm.openMs,
        })
      }
    }
  }

  const cpu = cpus()[0]
  return {
    schemaVersion: "quartz-bench/v1",
    generatedAt: new Date().toISOString(),
    profile,
    root,
    quartzCommit: gitCommit(),
    analysisTypescriptVersion: analysisTypeScriptVersion,
    process: {
      runtime: `bun ${Bun.version}`,
      platform: platform(),
      arch: arch(),
      hostname: hostname(),
      cpuModel: cpu?.model ?? null,
      cpuCount: cpus().length,
      totalMemGb: round(totalmem() / 1024 ** 3),
    },
    config,
    cliBinary: cli,
    results,
  }
}

const isEntrypoint = (): boolean => {
  const invoked = process.argv[1]
  return invoked !== undefined && import.meta.url === pathToFileURL(invoked).href
}

if (isEntrypoint()) {
  const args = parseArgs(process.argv.slice(2))
  runBench({
    profile: args.profile,
    root: args.root,
    commands: args.commands,
  })
    .then((report) => {
      const text = `${JSON.stringify(report, null, 2)}\n`
      process.stdout.write(text)
      if (args.out !== null) {
        mkdirSync(dirname(args.out), { recursive: true })
        writeFileSync(args.out, text)
        process.stderr.write(`[bench] wrote ${args.out}\n`)
      }
    })
    .catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
      process.exitCode = 2
    })
}
