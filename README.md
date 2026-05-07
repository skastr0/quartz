# quartz

Generic TypeScript type-analysis core, an agent-native CLI, and a thin OpenCode plugin app.

## Layout

- `packages/core`: reusable type-analysis behavior, independent of OpenCode.
- `apps/cli`: Effect-powered CLI protocol for agents and scripts.
- `apps/opencode-plugin`: OpenCode-specific tool registration, event hooks, logging, and session context behavior.

## CLI Protocol

The CLI accepts domain input as JSON payloads. Flags are reserved for execution controls:

- `--output inline|artifact|auto`
- `--format json|pretty`
- `--concurrency <n>`
- `--timeout <milliseconds>`
- `--artifact-dir <path>`

Payloads can be passed inline, from a file, or from stdin:

```bash
quartz info @payloads/info.json
quartz info '{"root":"test/fixtures","symbol":"User"}'
cat payloads/info.json | quartz info -
```

Every command returns an envelope. Success is written to stdout:

```json
{"ok":true,"command":"info","data":{}}
```

Expected failures are written to stderr and exit with code `1`:

```json
{"ok":false,"command":"info","error":{"type":"CommandInputError","message":"Payload failed schema validation","details":{}}}
```

## Discovery

Agents should discover the contract instead of scraping help text:

```bash
quartz capabilities
quartz schema list
quartz schema show graph
quartz examples list
quartz examples show info
quartz doctor '{"root":"test/fixtures"}'
```

## Example Payloads

`payloads/info.json`:

```json
{
  "root": "test/fixtures",
  "symbol": "User"
}
```

`payloads/graph.json`:

```json
{
  "root": "test/fixtures",
  "symbol": "ExtendedUser",
  "depth": 2,
  "format": "mermaid"
}
```

`payloads/transform-search.json`:

```json
{
  "root": "test/fixtures",
  "from": "User",
  "to": "UserDTO",
  "limit": 5
}
```

## Batch Calls

Batch-capable commands accept an array of payload objects and preserve input order:

```bash
quartz info @payloads/info-batch.json --concurrency 5
```

`payloads/info-batch.json`:

```json
[
  { "root": "test/fixtures", "symbol": "User" },
  { "root": "test/fixtures", "symbol": "MissingSymbol" }
]
```

Batch responses use `outcome: "succeeded" | "partial_failure" | "failed"` with per-item `index`, `target`, and either `data` or `error`. A completed batch with item failures still writes the batch envelope to stdout and exits with code `1`.

## Artifacts

Large outputs can be redirected to artifacts:

```bash
quartz graph @payloads/graph.json --output artifact --artifact-dir .quartz/artifacts
quartz diagnostics '{"root":"test/fixtures","explain":true}' --output auto
```

Artifact responses include a compact summary plus an absolute path:

```json
{
  "kind": "summary+artifact",
  "summary": "graph output written to artifact (428 bytes).",
  "artifact": {
    "kind": "json",
    "absolute_path": "/abs/path/.quartz/artifacts/result.json"
  }
}
```

Graphs, diagnostics, declaration dumps, transform search results, refactor previews, expanded types, and large explanations support artifact output.

## Commands

JSON-payload commands:

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

Use `schema show <command>` for exact payload fields.

## Local Build And Install

```bash
bun run cli:build
bun run cli:install-local
quartz capabilities
```

Package checks:

```bash
bun run typecheck
bun run test
bun run build
```
