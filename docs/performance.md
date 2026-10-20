# Quartz performance measurement

Quartz ships a durable native-engine benchmark harness. Use it **before** changing the TypeScript nightly, snapshot architecture, or algorithmic hot paths so every optimization can show a causal delta.

## Operating modes

| Mode | What it measures | How |
|------|------------------|-----|
| `cold-cli` | One-shot agent/shell cost | New `quartz` process per sample |
| `warm-batch` | Shell agents that batch payloads | One process, multi-item payload (analyzer reused per root) |
| `warm-analyzer` | Persistent plugin / long-lived analyzer | In-process `createTypeAnalyzer`, warmup then timed ops |

Ordinary CLI execution opens an analyzer and exits with the process. The OpenCode plugin keeps one analyzer for the session. Prefer batch mode or the plugin for warm work.

## Commands covered

startup/`doctor`, `diagnostics`, type lookup (`info`/`expand`), `compatible`/`verify-contract`, `related`, `transform-search`, `refactor-preview`, `check-snippet`.

## How to run

```bash
# Fast PR profile (fixtures, cold-cli + warm-analyzer)
bun run bench:pr

# Fuller release profile (adds warm-batch, more samples)
bun run bench:release

# Custom root (larger real repository); name symbols that exist in it
bun scripts/bench.ts --profile release --root /path/to/repo --symbol Foo --from Bar --to Foo --out .quartz/bench/custom.json

# Monorepo package, warm only, with peak server RSS
bun scripts/bench.ts --modes warm-analyzer --memory --root /path/to/repo --package packages/api --symbol Foo

# Subset
bun scripts/bench.ts --commands diagnostics,refactor-preview,transform-search
```

Reports are JSON (`schemaVersion: quartz-bench/v1`) with wall-clock p50/p95, open time (warm-analyzer), process/runtime, TypeScript nightly, and Quartz commit. Warm-analyzer rows also carry `rpc` (tsrs round trips, requests and busy time per call, with the request methods) and `loadAvg1m`; `--memory` adds `peakRss` for cold-cli rows and `warmServerPeakRss` for one untimed warm session.

## Interpreting results

- **Compare versions on the same machine and profile.** Absolute milliseconds are noisy across hosts.
- **10× claims are workload-specific evidence**, not a blanket product promise. Always name mode, repository, command, and percentile.
- **Historical dual-engine (native vs morph) speedups** are superseded once morph is removed. Re-baseline with this harness; do not cite morph ratios as current product truth.
- Correctness remains in `bun run verify:regression-guard`. Performance thresholds live in measured reports and optional CI ratio/complexity ratchets — not invented budgets.

## Warm vs cold product paths

| Path | Analyzer lifetime | Use when |
|------|-------------------|----------|
| One-shot CLI | Open → command → process exit | Ad-hoc shell; always pays cold open |
| CLI batch (array payload) | One process, analyzer reused per root | Shell agents with multiple targets |
| OpenCode plugin | One analyzer for process/session | Daily agent workflows (primary) |

Set `QUARTZ_TIMING=1` to enable TS-Go collectTiming and include a `timing` object on `quartz doctor` when available. Do **not** claim the plugin’s warm latency for isolated CLI commands.

Daemon decision: only if cold startup remains a dominant real-workflow cost **and** batch/plugin cannot serve the workflow. Otherwise reject the added lifecycle machinery.

## After each performance change

1. Run `bench:pr` (or `bench:release` for architectural changes).
2. Record before/after p50 and p95 for the touched modes/commands.
3. Commit the code change separately from the pin/architecture change (atomic sequence in the performance plan).

## tsrs cost model

Quartz talks to the `tsrs --api` server over JSON-RPC. What a command costs is mostly set by how many **round trips** it makes, not how many requests.

- The async client folds every request issued in the same event-loop tick into one `batchRequests` round trip. Requests awaited one after another each pay a full round trip.
- Measured on Bun with `isTypeAssignableTo` on the fixtures: a serial round trip costs 160-520 µs; the same call inside a batch of 200 costs 16-26 µs. Issue independent checker calls together (`Promise.all`, or `mapBounded` in `packages/engine/src/concurrency.ts`) and keep awaits for dependent stages.
- `tsrs/unstable/sync` (MessagePack) does not construct under Bun (`stdout._handle.fd` is undefined), so it is not an option for the CLI or the plugin. Under Node it measures 44-138 µs per serial call, still slower than batching.
- `tsrs --api` accepts no `--checkers`, `--singleThreaded` or `--maxMemory`; the `TSRS_MAX_MEMORY` environment variable changed neither time nor peak RSS in API mode. On junto (2.7k files) the first semantic diagnostics take about 3 s of server CPU on one thread, where `tsrs -p` spends 5 s of CPU across threads in 2.7 s wall. Per-file diagnostics requests do not parallelize either.
- Cold first calls scan the package: every project file is fetched as an AST. Keep per-file work out of the scan, fetch through a bounded fan-out, and skip walking trees whose text cannot contain the name.

## Measuring on a loaded machine

Wall time moves far more with host load than most changes do. Compare **round trips and requests per call** (deterministic), client CPU (`process.cpuUsage()`), and back-to-back A/B runs; treat `loadAvg1m` in the report as the noise level. Do not compare reports taken at different load.
