# quartz

Compiler-native TypeScript analysis engine, an agent-native CLI, and a thin OpenCode plugin.

Quartz is built for agents that need to inspect TypeScript projects without scraping editor UI or guessing from text search. It answers questions about packages, exported symbols, type expansion, diagnostics, snippets, source positions, compatibility, dependency graphs, refactor previews, and structural transform candidates.

## Status

Experimental. Quartz is usable for local agent workflows, but the CLI protocol, package exports, plugin tool surface, and distribution channels may change while the project is in `0.y.z`.

## Layout

- `packages/engine`: persistent TypeScript 7 native workspace and public analysis API.
- `apps/cli`: Effect-powered CLI protocol for agents and scripts.
- `apps/opencode-plugin`: OpenCode-specific tool registration, event hooks, logging, and session context behavior.

## Distribution

The repository is prepared for these release lanes:

- `@skastr0/quartz-engine`: npm package with built ESM output and TypeScript declarations.
- `@skastr0/quartz-opencode-plugin`: npm package with built ESM output and TypeScript declarations.
- `@skastr0/quartz`: npm CLI wrapper with per-platform prebuilt binary packages for `npx`, `bunx`, and `pnpm dlx`.
- `quartz`: standalone CLI binaries for GitHub Releases.

The workspace root and `@skastr0/quartz-cli` source app stay private and are not published. The public npm CLI package is `@skastr0/quartz`, which exposes the `quartz` command through a Node launcher and optional platform binary packages. Every platform package carries the matching TypeScript native executable required by the engine.

After the first npm release:

```bash
npx -y @skastr0/quartz capabilities
bunx @skastr0/quartz capabilities
pnpm dlx @skastr0/quartz capabilities
```

See `docs/publishing.md` before publishing packages, dispatching release workflows, or changing repository visibility.

## Install And Run Locally

```bash
bun install
bun run cli:build
bun run cli:install-local
quartz capabilities
```

During development, commands can also run through the source entrypoint:

```bash
bun run apps/cli/src/main.ts capabilities
```

## CLI Protocol

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

Architecture fitness checks are documented in `docs/architecture-fitness.md`, and `doctor` reports the same check inventory for agents that need executable obligations.

## Public Commands

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
| `why-error` | Explain a TypeScript diagnostic code or message. | `{"root":"test/fixtures","code":2322,"message":"Type 'UserInput' is not assignable to type 'User'."}` |
| `explain` | Show resolution steps for a type expression. | `{"root":"test/fixtures","expression":"Pick<User, \"id\" | \"name\">"}` |
| `transform-search` | Search functions by structural input/output type compatibility. | `{"root":"test/fixtures","from":"User","to":"UserDTO","limit":5}` |
| `verify-contract` | Compose compatibility, snippet, diagnostics, and transform evidence for a proposed contract. | `{"root":"test/fixtures","from":"User","to":"UserDTO","symbol":"toDTO"}` |
| `doctor` | Inspect local CLI health and project discovery. | `{"root":"test/fixtures"}` |

Use `schema show <command>` for exact payload fields. Artifact-capable commands are `expand`, `diagnostics`, `file`, `graph`, `refactor-preview`, `why-error`, `explain`, `transform-search`, and `verify-contract`.

### Verify Contract Evidence

`verify-contract` returns a versioned evidence packet with `schemaVersion: "verify-contract/v1"`. Its `ok` field means the configured Quartz checks found enough evidence for the requested contract shape; it is not a proof of runtime correctness or TypeScript soundness.

The command composes existing checks: direct assignability, optional snippet checking, package diagnostics, and verified transform search. Direct assignability can fail for a conversion contract while a verified transform still provides useful compiler-backed evidence.

### Transform Search Verification Trust Ladder

`transform-search` ranks structural transform candidates with TypeScript/compiler feedback, but Quartz does not make TypeScript sound. Treat verification status as a trust ladder:

- `verified`: candidate passed the requested compiler-backed checks.
- `unverified`: candidate was found structurally, but verification was not requested or did not have enough evidence to prove it.
- `unverifiable`: Quartz could not build a meaningful verification check for the candidate.

Use `verifiedOnly` to return only verified candidates. Use `minVerificationStatus` to set the lowest acceptable status. Use `includeDiagnostics` to include compiler feedback, `includeSyntheticCode` to include the generated verification snippet, and `includeFailedVerification` to keep candidates whose verification failed.

## Example Payload Files

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

## Batch Calls And Partial Failures

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

## OpenCode Plugin

The OpenCode plugin exposes the same analyzer through tool calls rooted at the OpenCode project directory.

After the first npm release, the package export is:

```ts
import plugin from "@skastr0/quartz-opencode-plugin/server"
```

Build the plugin bundle:

```bash
bun run --filter @skastr0/quartz-opencode-plugin build
```

Configure OpenCode to load `@skastr0/quartz-opencode-plugin/server` after the package is available to the project. The plugin creates one Effect runtime for the OpenCode workspace directory, reuses the analyzer across tool calls, and marks the project cache dirty after file-modifying tools such as `edit`, `write`, or `morph-mcp_edit_file`.

Plugin tools:

- Discovery: `type_packages`, `type_symbols`, `type_info`, `type_expand`, `type_related`, `type_search`
- Analysis: `type_eval`, `type_diagnostics`, `type_check_snippet`, `type_at_position`, `type_file`, `type_refresh`
- Relationships and refactors: `type_compatible`, `type_graph`, `type_refactor_preview`, `type_why_error`, `type_explain`, `type_transform_search`

Tool arguments mirror CLI payload fields except `root`, because the plugin root is the OpenCode workspace directory. Use `package` for multi-package workspaces.

## Validation

```bash
bun run verify
bun run pack:dry-run
bun run verify:docs-examples
bun run verify:regression-guard
```

`verify:docs-examples` backs the public examples in this README against `test/fixtures`.

`verify:regression-guard` is the compact pre-release guard for public-feature and severe legibility drift. It runs the Effect rewrite structural check, the documented CLI example smoke test, and focused CLI/plugin/refactor coverage. Use it before release-readiness work or after changing analyzer services, CLI envelopes, plugin tools, diagnostics/explanations, transform search, snippet checking, source-file inspection, or refactor preview behavior. A failure means either a public feature regressed or a structural guard detected a return to the old analyzer/runtime shape.

Release checks:

```bash
bun run release:check
```

Do not publish npm packages, create release tags, dispatch release workflows, or flip repository visibility until the public-release gates in `docs/publishing.md` have been completed.

## Community And Security

Quartz is solo-maintained. Use GitHub issues for reproducible bugs, documentation corrections, and scoped proposals. External code changes are not the default support path.

Please report suspected vulnerabilities privately through GitHub private vulnerability reporting for this repository. See `SECURITY.md` for scope and reporting details.

## License

MIT. See `LICENSE`.
