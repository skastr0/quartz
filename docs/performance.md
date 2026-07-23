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

# Custom root (larger real repository)
bun scripts/bench.ts --profile release --root /path/to/repo --out .quartz/bench/custom.json

# Subset
bun scripts/bench.ts --commands diagnostics,refactor-preview,transform-search
```

Reports are JSON (`schemaVersion: quartz-bench/v1`) with wall-clock p50/p95, open time (warm-analyzer), process/runtime, TypeScript nightly, and Quartz commit.

## Interpreting results

- **Compare versions on the same machine and profile.** Absolute milliseconds are noisy across hosts.
- **10× claims are workload-specific evidence**, not a blanket product promise. Always name mode, repository, command, and percentile.
- **Historical dual-engine (native vs morph) speedups** are superseded once morph is removed. Re-baseline with this harness; do not cite morph ratios as current product truth.
- Correctness remains in `bun run verify:regression-guard`. Performance thresholds live in measured reports and optional CI ratio/complexity ratchets — not invented budgets.

## After each performance change

1. Run `bench:pr` (or `bench:release` for architectural changes).
2. Record before/after p50 and p95 for the touched modes/commands.
3. Commit the code change separately from the pin/architecture change (atomic sequence in the performance plan).
