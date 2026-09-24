# Quartz reference

The full CLI contract, the OpenCode plugin, and the published packages. For a first run, start with the [README](../README.md).

## Packages

| package | what it is |
| --- | --- |
| `@skastr0/quartz` | the `quartz` CLI, with prebuilt binaries for macOS and Linux (arm64, x64) |
| `@skastr0/quartz-engine` | the analysis library the CLI and plugin share |
| `@skastr0/quartz-opencode-plugin` | the OpenCode plugin (`/server` export) |

Every platform package carries the TypeScript native compiler it needs. There is no Windows build.

## CLI protocol

The CLI follows `agentic-cli/v1`. Domain input lives in JSON payloads. Flags are reserved for execution controls:

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

If `root` is omitted, Quartz analyzes the current working directory. Multi-package workspaces can pass `package` to target a discovered package or directory.

Every command returns an envelope. Success is written to stdout:

```json
{"ok":true,"command":"info","data":{}}
```

Expected failures are written to stderr and exit with code `1`:

```json
{"ok":false,"command":"info","error":{"type":"CommandInputError","message":"Payload failed schema validation","details":{}}}
```

Most failures include `details.retryable`. Schema errors, unknown commands, missing required fields, and not-found lookups are non-retryable until the payload changes. File-read, artifact-write, and timeout failures may be retryable after fixing the environment or increasing `--timeout`.

Quartz-owned runtime output defaults to `~/.config/quartz`, or `$QUARTZ_HOME` when that environment variable is set. Project output is written only when a command receives an explicit path such as `--artifact-dir`.

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

`capabilities` reports supported input modes, execution flags, envelope shape, batch behavior, and command inventory. `schema show <command>` returns the JSON schema and example for one command. `examples show <command>` returns a payload plus inline, file, and stdin invocation forms.

Architecture fitness checks are documented in [architecture-fitness.md](architecture-fitness.md), and `doctor` reports the same check inventory for agents that need executable obligations.

## Commands

All command examples below use `test/fixtures`, the same fixture repo exercised by `bun run verify:docs-examples`.

| Command | Use | Example payload |
| --- | --- | --- |
| `packages` | List discovered TypeScript packages from `tsconfig.json` files. | `{"root":"test/fixtures"}` |
| `symbols` | List exported symbols with `pattern`, `kind`, `file`, `package`, and `limit` filters. | `{"root":"test/fixtures","pattern":"^User","limit":25}` |
| `info` | Show type information for an exported symbol or `@file:path.ts:Symbol.member`. | `{"root":"test/fixtures","symbol":"User"}` |
| `expand` | Expand an exported symbol type. | `{"root":"test/fixtures","symbol":"User"}` |
| `search` | Search exported types by name, regex, property, or base type. | `{"root":"test/fixtures","query":"Role","limit":10}` |
| `diagnostics` | Show TypeScript diagnostics, optionally with Quartz explanations. | `{"root":"test/fixtures","explain":true}` |
| `at-position` | Show the type at a one-based source position. | `{"root":"test/fixtures","file":"types/basic.ts","line":9,"column":3}` |
| `related` | Find symbols that reference or are referenced by a symbol. | `{"root":"test/fixtures","symbol":"User"}` |
| `eval` | Evaluate a TypeScript type expression. | `{"root":"test/fixtures","expression":"Pick<User, \"id\" | \"name\">"}` |
| `check-snippet` | Type-check a snippet without writing to disk. | `{"root":"test/fixtures","code":"const value = 1 satisfies number;"}` |
| `file` | Inspect declarations in one source file. | `{"root":"test/fixtures","file":"types/basic.ts","includePrivate":false}` |
| `compatible` | Check whether one type is assignable to another. | `{"root":"test/fixtures","from":"ExtendedUser","to":"User"}` |
| `graph` | Generate a type dependency graph as Mermaid or DOT. | `{"root":"test/fixtures","symbol":"ExtendedUser","depth":2,"format":"mermaid"}` |
| `refactor-preview` | Preview a rename refactor without applying it. | `{"root":"test/fixtures","symbol":"RefactorUser","to":"RenamedUser"}` |
| `why-error` | Explain a TypeScript diagnostic by code, message, or a file/line pair. | `{"root":"test/fixtures","code":2322,"message":"Type 'UserInput' is not assignable to type 'User'."}` |
| `explain` | Expand a type expression and return its resolved form. | `{"root":"test/fixtures","expression":"Pick<User, \"id\" | \"name\">"}` |
| `transform-search` | Search functions by structural input/output type compatibility. | `{"root":"test/fixtures","from":"User","to":"UserDTO","limit":5}` |
| `verify-contract` | Compose compatibility, snippet, diagnostics, and transform evidence for a proposed contract. | `{"root":"test/fixtures","from":"User","to":"UserDTO","symbol":"toDTO"}` |
| `doctor` | Inspect local CLI health and project discovery. | `{"root":"test/fixtures"}` |

Use `schema show <command>` for exact payload fields. Artifact-capable commands are `expand`, `diagnostics`, `file`, `graph`, `refactor-preview`, `why-error`, `explain`, `transform-search`, and `verify-contract`.

### verify-contract evidence

`verify-contract` returns a versioned evidence packet with `schemaVersion: "verify-contract/v1"`. Its `ok` field means the configured Quartz checks found enough evidence for the requested contract shape; it is not a proof of runtime correctness or TypeScript soundness.

The command composes existing checks: direct assignability, optional snippet checking, package diagnostics, and verified transform search. Direct assignability can fail for a conversion contract while a verified transform still provides useful compiler-backed evidence.

### transform-search trust levels

`transform-search` ranks structural transform candidates with TypeScript/compiler feedback, but Quartz does not make TypeScript sound. Treat verification status as a trust ladder:

- `verified`: candidate passed the requested compiler-backed checks.
- `unverified`: candidate was found structurally, but verification was not requested or did not have enough evidence to prove it.
- `unverifiable`: Quartz could not build a meaningful verification check for the candidate.

Use `verifiedOnly` to return only verified candidates. Use `minVerificationStatus` to set the lowest acceptable status. Use `includeDiagnostics` to include compiler feedback, `includeSyntheticCode` to include the generated verification snippet, and `includeFailedVerification` to keep candidates whose verification failed.

## Example payload files

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

## Batch calls and partial failures

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
quartz graph @payloads/graph.json --output artifact
quartz graph @payloads/graph.json --output artifact --artifact-dir ./quartz-artifacts
quartz diagnostics '{"root":"test/fixtures","explain":true}' --output auto
```

Without `--artifact-dir`, artifacts are written under `~/.config/quartz/artifacts` or `$QUARTZ_HOME/artifacts`. Use `--artifact-dir` when you intentionally want project-local output.

Artifact responses include a compact summary plus an absolute path:

```json
{
  "kind": "summary+artifact",
  "summary": "graph output written to artifact (428 bytes).",
  "artifact": {
    "kind": "json",
    "absolute_path": "/Users/alice/.config/quartz/artifacts/result.json"
  }
}
```

Graphs, diagnostics, declaration dumps, transform search results, refactor previews, expanded types, and large explanations support artifact output.

## OpenCode plugin

The OpenCode plugin exposes the same analyzer through tool calls rooted at the OpenCode project directory.

The package export is:

```ts
import plugin from "@skastr0/quartz-opencode-plugin/server"
```

Configure OpenCode to load `@skastr0/quartz-opencode-plugin/server`. The plugin creates one persistent native analyzer for the OpenCode workspace directory and reuses it across tool calls. It marks the analyzer cache dirty from OpenCode file events, with tool-hook fallbacks for `apply_patch`, `edit`, `write`, and `morph-mcp_edit_file`; it disposes only when OpenCode reports `server.instance.disposed` for that directory, not when a session is deleted.

Plugin tools:

- Discovery: `type_packages`, `type_symbols`, `type_info`, `type_expand`, `type_related`, `type_search`
- Analysis: `type_eval`, `type_diagnostics`, `type_check_snippet`, `type_at_position`, `type_file`, `type_refresh`
- Relationships, refactors, and composed evidence: `type_compatible`, `type_graph`, `type_refactor_preview`, `type_why_error`, `type_explain`, `type_transform_search`, `type_verify_contract`

Tool arguments mirror CLI payload fields except `root`, because the plugin root is the OpenCode workspace directory. Use `package` for multi-package workspaces.
