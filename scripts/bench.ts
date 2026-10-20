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
 * optional complexity counters when the command returns them. Warm-analyzer rows
 * also carry the tsrs JSON-RPC cost per call (round trips, batched items, time with a
 * request outstanding), and a separate untimed pass records peak RSS of the server
 * process tree (warm: whole run; cold-cli: per command). Host load average is stored
 * because a loaded machine moves wall-clock far more than most optimizations do.
 * Writes a JSON report; never invents thresholds — budgets freeze from measured
 * distributions.
 *
 * Profiles:
 *   --profile pr       fixtures only, fewer samples (default)
 *   --profile release  fixtures + optional --root, more samples
 *
 * Compare versions on the same machine/run. CI should ratchet ratios or
 * complexity counts, not absolute milliseconds alone.
 */
import { execFileSync, spawn, spawnSync } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import { cpus, hostname, loadavg, platform, arch, totalmem } from "node:os"
import { dirname, isAbsolute, relative, resolve } from "node:path"
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

interface Queries {
  readonly symbol: string
  readonly from: string
  readonly to: string
  readonly rename: string
  /** Package selector for monorepos; unset resolves the default package. */
  readonly package?: string
}

const DEFAULT_QUERIES: Queries = { symbol: "User", from: "ExtendedUser", to: "User", rename: "Person" }

const commandsFor = (root: string, q: Queries = DEFAULT_QUERIES): readonly CommandSpec[] => {
  const pkg = q.package
  // CLI payloads select a package with `package`; analyzer option bags use `packageName`.
  const withPkg = <T extends object>(payload: T): T & { readonly package?: string } =>
    pkg === undefined ? payload : { ...payload, package: pkg }
  const withPackageName = <T extends object>(options: T): T & { readonly packageName?: string } =>
    pkg === undefined ? options : { ...options, packageName: pkg }
  return [
    {
      name: "doctor",
      batchable: false,
      cliArgs: (r) => ["doctor", JSON.stringify(withPkg({ root: r }))],
      batchPayloads: () => [],
      run: async (a) => ({ metadata: a.metadata, packages: await a.getPackages() }),
    },
    {
      name: "diagnostics",
      batchable: true,
      cliArgs: (r) => ["diagnostics", JSON.stringify(withPkg({ root: r }))],
      batchPayloads: (r, n) => Array.from({ length: n }, () => withPkg({ root: r })),
      run: (a) => a.getDiagnostics(pkg),
    },
    {
      name: "info",
      batchable: true,
      cliArgs: (r) => ["info", JSON.stringify(withPkg({ root: r, symbol: q.symbol }))],
      batchPayloads: (r, n) => Array.from({ length: n }, () => withPkg({ root: r, symbol: q.symbol })),
      run: (a) => a.getTypeInfo(q.symbol, pkg),
    },
    {
      name: "expand",
      batchable: true,
      cliArgs: (r) => ["expand", JSON.stringify(withPkg({ root: r, symbol: q.symbol }))],
      batchPayloads: (r, n) => Array.from({ length: n }, () => withPkg({ root: r, symbol: q.symbol })),
      run: (a) => a.expandType(q.symbol, pkg),
    },
    {
      name: "compatible",
      batchable: true,
      cliArgs: (r) => ["compatible", JSON.stringify(withPkg({ root: r, from: q.from, to: q.to }))],
      batchPayloads: (r, n) => Array.from({ length: n }, () => withPkg({ root: r, from: q.from, to: q.to })),
      run: (a) => a.checkCompatibility(q.from, q.to, pkg),
    },
    {
      name: "verify-contract",
      batchable: true,
      cliArgs: (r) => ["verify-contract", JSON.stringify(withPkg({ root: r, from: q.symbol, to: q.symbol }))],
      batchPayloads: (r, n) => Array.from({ length: n }, () => withPkg({ root: r, from: q.symbol, to: q.symbol })),
      run: (a) => a.verifyContract(withPackageName({ from: q.symbol, to: q.symbol })),
    },
    {
      name: "related",
      batchable: true,
      cliArgs: (r) => ["related", JSON.stringify(withPkg({ root: r, symbol: q.symbol }))],
      batchPayloads: (r, n) => Array.from({ length: n }, () => withPkg({ root: r, symbol: q.symbol })),
      run: (a) => a.findRelated(q.symbol, pkg),
    },
    {
      name: "graph",
      batchable: true,
      cliArgs: (r) => ["graph", JSON.stringify(withPkg({ root: r, symbol: q.symbol, depth: 1, format: "mermaid" }))],
      batchPayloads: (r, n) => Array.from({ length: n }, () => withPkg({ root: r, symbol: q.symbol, depth: 1, format: "mermaid" })),
      run: (a) => a.generateGraph(q.symbol, withPackageName({ depth: 1, format: "mermaid" as const })),
    },
    {
      name: "transform-search",
      batchable: true,
      cliArgs: (r) => ["transform-search", JSON.stringify(withPkg({ root: r, from: q.symbol, limit: 5 }))],
      batchPayloads: (r, n) => Array.from({ length: n }, () => withPkg({ root: r, from: q.symbol, limit: 5 })),
      run: (a) => a.transformSearch(withPackageName({ from: q.symbol, limit: 5 })),
    },
    {
      name: "refactor-preview",
      batchable: true,
      cliArgs: (r) => ["refactor-preview", JSON.stringify(withPkg({ root: r, symbol: q.symbol, to: q.rename }))],
      batchPayloads: (r, n) => Array.from({ length: n }, () => withPkg({ root: r, symbol: q.symbol, to: q.rename })),
      run: (a) => a.previewRefactor(withPackageName({ action: "rename" as const, symbol: q.symbol, to: q.rename })),
    },
    {
      name: "check-snippet",
      batchable: true,
      cliArgs: (r) => ["check-snippet", JSON.stringify(withPkg({ root: r, code: "const x: string = 42;" }))],
      batchPayloads: (r, n) =>
        Array.from({ length: n }, () => withPkg({ root: r, code: "const x: string = 42;" })),
      run: (a) => a.checkSnippet("const x: string = 42;", pkg),
    },
  ]
}

interface SampleStats {
  readonly samplesMs: readonly number[]
  readonly p50Ms: number
  readonly p95Ms: number
  readonly meanMs: number
  readonly minMs: number
  readonly maxMs: number
}

/** tsrs JSON-RPC cost of one command call, averaged over the timed samples. */
interface RpcCost {
  /** Wire round trips (a batchRequests counts as one). */
  readonly roundTrips: number
  /** Requests carried, with batchRequests unpacked. */
  readonly requests: number
  /** Wall time with at least one request outstanding. */
  readonly busyMs: number
  /** Requests per round trip method, unpacked batches counted under their own method. */
  readonly byMethod: Readonly<Record<string, number>>
}

interface PeakRss {
  readonly peakMb: number
  readonly samples: number
}

interface ModeResult {
  readonly mode: Mode
  readonly command: string
  readonly stats: SampleStats
  readonly openMs?: number
  readonly rpc?: RpcCost
  readonly peakRss?: PeakRss
  /** 1-minute load average when the row finished. */
  readonly loadAvg1m?: number
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
  readonly queries: Queries
  readonly load: { readonly startAvg1m: number; readonly endAvg1m: number }
  /** Peak RSS of the tsrs server over one untimed warm-analyzer session (open plus every command once). */
  readonly warmServerPeakRss?: PeakRss & { readonly afterOpenMb: number }
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

const mb = (kib: number): number => round(kib / 1024)

/** Sum of RSS (KiB) over `root` and every descendant, from one `ps` snapshot. */
const treeRssKib = (root: number): number => {
  const out = spawnSync("ps", ["-A", "-o", "pid=,ppid=,rss="], { encoding: "utf8" }).stdout
  const rows = new Map<number, { ppid: number; rss: number }>()
  for (const line of out.split("\n")) {
    const [pid, ppid, rss] = line.trim().split(/\s+/).map(Number)
    if (pid !== undefined && ppid !== undefined && rss !== undefined && !Number.isNaN(rss)) rows.set(pid, { ppid, rss })
  }
  let total = 0
  const stack = [root]
  while (stack.length > 0) {
    const pid = stack.pop()!
    const row = rows.get(pid)
    if (row !== undefined && pid !== root) total += row.rss
    for (const [child, info] of rows) if (info.ppid === pid) stack.push(child)
  }
  return total
}

/** Descendant RSS of `pid` (the process itself excluded when `self` is false). */
const startRssSampler = (pid: number, intervalMs = 40) => {
  let peak = 0
  let count = 0
  const sample = () => {
    peak = Math.max(peak, treeRssKib(pid))
    count += 1
  }
  const timer = setInterval(sample, intervalMs)
  return {
    sampleNow: sample,
    stop: (): PeakRss => {
      clearInterval(timer)
      sample()
      return { peakMb: mb(peak), samples: count }
    },
  }
}

/**
 * tsrs async client instrumentation. The client already folds every request issued in one
 * event-loop tick into a single batchRequests, so round trips (not requests) are what a
 * serial await chain pays for.
 */
const installRpcProbe = async () => {
  const clientPath = resolve(dirname(Bun.resolveSync("tsrs/package.json", REPO_ROOT)), "dist/api/async/client.js")
  const mod = (await import(pathToFileURL(clientPath).href)) as {
    readonly Client: { readonly prototype: { sendRequestWithTiming: (type: { method: string }, params: unknown) => Promise<unknown> } }
  }
  const proto = mod.Client.prototype
  const original = proto.sendRequestWithTiming
  const byMethod = new Map<string, number>()
  let roundTrips = 0
  let requests = 0
  let busyMs = 0
  let inflight = 0
  let busySince = 0
  proto.sendRequestWithTiming = async function (this: unknown, type, params) {
    roundTrips += 1
    if (type.method === "batchRequests") {
      const items = (params as { requests?: readonly { method: string }[] }).requests ?? []
      requests += items.length
      for (const item of items) byMethod.set(item.method, (byMethod.get(item.method) ?? 0) + 1)
    } else {
      requests += 1
      byMethod.set(type.method, (byMethod.get(type.method) ?? 0) + 1)
    }
    if (inflight === 0) busySince = performance.now()
    inflight += 1
    try {
      return await original.call(this, type, params)
    } finally {
      inflight -= 1
      if (inflight === 0) busyMs += performance.now() - busySince
    }
  }
  return {
    reset: () => {
      byMethod.clear()
      roundTrips = 0
      requests = 0
      busyMs = 0
    },
    read: (calls: number): RpcCost => ({
      roundTrips: round(roundTrips / calls),
      requests: round(requests / calls),
      busyMs: round(busyMs / calls),
      byMethod: Object.fromEntries(
        [...byMethod.entries()].sort((a, b) => b[1] - a[1]).map(([method, n]) => [method, round(n / calls)]),
      ),
    }),
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

const coldPeakRss = (cli: string, command: CommandSpec, root: string): Promise<PeakRss> =>
  new Promise((resolvePeak, reject) => {
    const child = spawn(cli, [...command.cliArgs(root)], { cwd: REPO_ROOT, env: process.env, stdio: "ignore" })
    const sampler = startRssSampler(child.pid!, 25)
    child.once("error", reject)
    child.once("close", () => resolvePeak(sampler.stop()))
  })

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
  probe: Awaited<ReturnType<typeof installRpcProbe>>,
): Promise<{ readonly stats: SampleStats; readonly openMs: number; readonly rpc: RpcCost }> => {
  const openStarted = performance.now()
  const analyzer = await createTypeAnalyzer(root)
  const openMs = performance.now() - openStarted
  try {
    for (let i = 0; i < warmup; i += 1) await command.run(analyzer)
    const samples: number[] = []
    probe.reset()
    for (let i = 0; i < timed; i += 1) {
      const started = performance.now()
      await command.run(analyzer)
      samples.push(performance.now() - started)
    }
    return { stats: statsOf(samples), openMs: round(openMs), rpc: probe.read(timed) }
  } finally {
    await analyzer.dispose()
  }
}

/** One untimed session: open, run every selected command once, report the server's peak RSS. */
const runWarmMemoryPass = async (
  commands: readonly CommandSpec[],
  root: string,
): Promise<PeakRss & { readonly afterOpenMb: number }> => {
  const sampler = startRssSampler(process.pid)
  const analyzer = await createTypeAnalyzer(root)
  try {
    const afterOpenMb = mb(treeRssKib(process.pid))
    for (const command of commands) {
      process.stderr.write(`[bench] warm-memory ${command.name}\n`)
      await command.run(analyzer)
    }
    return { ...sampler.stop(), afterOpenMb }
  } finally {
    await analyzer.dispose()
  }
}

interface BenchOptions {
  readonly profile?: Profile
  readonly root?: string
  readonly commands?: readonly string[] | null
  readonly cliBinary?: string
  readonly queries?: Partial<Queries>
  /** Overrides the profile's modes. */
  readonly modes?: readonly Mode[]
  readonly warmup?: number
  readonly timed?: number
  /** Add peak-RSS passes (untimed): one warm session, plus one extra process per cold-cli command. */
  readonly memory?: boolean
}

const parseArgs = (argv: readonly string[]): BenchOptions & { readonly out: string | null } => {
  let out: string | null = null
  const options: { -readonly [K in keyof BenchOptions]: BenchOptions[K] } = {}
  const queries: { -readonly [K in keyof Queries]?: Queries[K] } = {}
  const need = (i: number, flag: string): string => {
    const value = argv[i]
    if (value === undefined) throw new Error(`${flag} needs a value`)
    return value
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!
    if (arg === "--profile") {
      const value = need(++i, arg)
      if (value !== "pr" && value !== "release") throw new Error(`Unknown profile: ${value}`)
      options.profile = value
    } else if (arg === "--root") {
      options.root = resolve(need(++i, arg))
    } else if (arg === "--out") {
      out = resolve(need(++i, arg))
    } else if (arg === "--commands") {
      options.commands = need(++i, arg).split(",").map((s) => s.trim()).filter(Boolean)
    } else if (arg === "--modes") {
      options.modes = need(++i, arg).split(",").map((s) => {
        const mode = s.trim()
        if (mode !== "cold-cli" && mode !== "warm-batch" && mode !== "warm-analyzer") throw new Error(`Unknown mode: ${mode}`)
        return mode
      })
    } else if (arg === "--warmup") {
      options.warmup = Number(need(++i, arg))
    } else if (arg === "--timed") {
      options.timed = Number(need(++i, arg))
    } else if (arg === "--memory") {
      options.memory = true
    } else if (arg === "--symbol" || arg === "--from" || arg === "--to" || arg === "--rename" || arg === "--package") {
      queries[arg.slice(2) as keyof Queries] = need(++i, arg)
    } else if (arg === "--help" || arg === "-h") {
      process.stdout.write(
        [
          "Usage: bun scripts/bench.ts [--profile pr|release] [--root <path>] [--out report.json]",
          "                            [--commands a,b] [--modes cold-cli,warm-batch,warm-analyzer]",
          "                            [--warmup n] [--timed n] [--memory]",
          "                            [--symbol S] [--from S] [--to S] [--rename S] [--package P]",
          "",
          "--symbol/--from/--to/--rename replace the fixture symbols (User, ExtendedUser, Person)",
          "so a real repository can be measured; --package picks the package of a monorepo.",
          "--memory adds untimed peak-RSS passes.",
          "",
        ].join("\n"),
      )
      process.exit(0)
    }
  }
  return { ...options, queries, out }
}

export const runBench = async (options: BenchOptions): Promise<BenchReport> => {
  const profile = options.profile ?? "pr"
  const base = PROFILES[profile]
  const config: ProfileConfig = {
    warmup: options.warmup ?? base.warmup,
    timed: options.timed ?? base.timed,
    modes: options.modes ?? base.modes,
  }
  const root = resolve(options.root ?? DEFAULT_FIXTURE_ROOT)
  const cli = options.cliBinary ?? resolveCliBinary()
  const queries: Queries = { ...DEFAULT_QUERIES, ...options.queries }
  const allCommands = commandsFor(root, queries)
  const selected =
    options.commands === undefined || options.commands === null || options.commands.length === 0
      ? allCommands
      : allCommands.filter((c) => options.commands!.includes(c.name))

  const results: ModeResult[] = []
  const startLoad = loadavg()[0]!
  const probe = config.modes.includes("warm-analyzer") ? await installRpcProbe() : null

  for (const command of selected) {
    for (const mode of config.modes) {
      if (mode === "cold-cli") {
        process.stderr.write(`[bench] cold-cli ${command.name}\n`)
        const stats = runColdCli(cli, command, root, config.timed)
        const peakRss = options.memory === true ? await coldPeakRss(cli, command, root) : undefined
        results.push({
          mode,
          command: command.name,
          stats,
          ...(peakRss === undefined ? {} : { peakRss }),
          loadAvg1m: round(loadavg()[0]!),
        })
      } else if (mode === "warm-batch") {
        if (!command.batchable) continue
        process.stderr.write(`[bench] warm-batch ${command.name}\n`)
        results.push({
          mode,
          command: command.name,
          stats: runWarmBatch(cli, command, root, config.warmup, config.timed),
          loadAvg1m: round(loadavg()[0]!),
          notes: "amortized total_wall / item_count from one multi-item process",
        })
      } else {
        process.stderr.write(`[bench] warm-analyzer ${command.name}\n`)
        const warm = await runWarmAnalyzer(command, root, config.warmup, config.timed, probe!)
        results.push({
          mode,
          command: command.name,
          stats: warm.stats,
          openMs: warm.openMs,
          rpc: warm.rpc,
          loadAvg1m: round(loadavg()[0]!),
        })
      }
    }
  }

  const warmServerPeakRss = options.memory === true ? await runWarmMemoryPass(selected, root) : undefined
  const cpu = cpus()[0]
  return {
    schemaVersion: "quartz-bench/v1",
    generatedAt: new Date().toISOString(),
    profile,
    root: isAbsolute(root) ? relative(process.cwd(), root) || "." : root,
    quartzCommit: gitCommit(),
    analysisTypescriptVersion: analysisTypeScriptVersion,
    process: {
      runtime: `bun ${Bun.version}`,
      platform: platform(),
      arch: arch(),
      hostname: "host",
      cpuModel: cpu?.model ?? null,
      cpuCount: cpus().length,
      totalMemGb: round(totalmem() / 1024 ** 3),
    },
    config,
    cliBinary: isAbsolute(cli) ? relative(process.cwd(), cli) || cli : cli,
    queries,
    load: { startAvg1m: round(startLoad), endAvg1m: round(loadavg()[0]!) },
    ...(warmServerPeakRss === undefined ? {} : { warmServerPeakRss }),
    results,
  }
}

const isEntrypoint = (): boolean => {
  const invoked = process.argv[1]
  return invoked !== undefined && import.meta.url === pathToFileURL(invoked).href
}

if (isEntrypoint()) {
  const args = parseArgs(process.argv.slice(2))
  runBench(args)
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
