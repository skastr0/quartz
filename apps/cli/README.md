# @skastr0/quartz-cli

Agent-native CLI for Quartz TypeScript code intelligence.

## Run

```bash
bun run ../../apps/cli/src/main.ts capabilities
```

After building and linking locally:

```bash
bun run install:local
quartz capabilities
```

## Protocol

Quartz uses `agentic-cli/v1`.

- Domain input is JSON.
- Input modes are inline JSON, `@file`, and stdin with `-`.
- Execution flags are `--output`, `--format`, `--concurrency`, `--timeout`, and `--artifact-dir`.
- Success envelopes go to stdout.
- Expected failure envelopes go to stderr and exit `1`.
- Batch-capable commands accept an array of payloads and return ordered per-item results.
- Runtime-owned artifacts default to `~/.config/quartz/artifacts`, or `$QUARTZ_HOME/artifacts` when `QUARTZ_HOME` is set.
- Use `--artifact-dir <path>` only when you intentionally want artifacts in a specific output directory.

Examples:

```bash
quartz info '{"root":"test/fixtures","symbol":"User"}'
quartz info @payload.json
cat payload.json | quartz info -
```

Discovery commands:

```bash
quartz capabilities
quartz schema list
quartz schema show graph
quartz examples list
quartz examples show info
quartz doctor '{"root":"test/fixtures"}'
```

## Commands

- `packages`
- `symbols`
- `info`
- `expand`
- `search`
- `diagnostics`
- `at-position`
- `related`
- `eval`
- `check-snippet`
- `file`
- `compatible`
- `graph`
- `refactor-preview`
- `why-error`
- `explain`
- `transform-search`
- `doctor`

Run `quartz schema show <command>` for exact payload fields. Run `bun run verify:docs-examples` from the workspace root to smoke-test the documented examples.
