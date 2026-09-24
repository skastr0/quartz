# quartz — brief

updated: 2026-09-24 · version: 0.2.1 · maturity: usable-with-gaps

Maturity argument: 0.2.1 is on npm and pulsar's TypeScript scoring runs on it, but transform-search misses non-exported helpers on a real repo and the GitHub 0.2.x releases are still drafts (see Gaps).

## One line

quartz answers an agent's TypeScript questions with the compiler's own answers.

## The pain

An agent is writing TypeScript against types it cannot see. It reads files to rebuild a type in its head, writes the call, runs `tsc`, reads the error, and goes around again. Guilherme described this on 2026-08-02, about agents authoring prism workflows: "the agent spends many turns trying to figure out how it works / flailing on type errors." Each lap costs turns and context. A guess that compiles can still duplicate a converter that already exists (inferred; no session shows this case).

Receipts (quasar sessions):
- The flailing quote: `claude:b93b1d1bdd3efaf8b8645e5df95be6f2`, user turn 2026-08-02T02:48.
- The origin request, 2025-12-08: "a tool that allows the agent to pass in arbitrary type-level typescript (no runtime execution) and have our plugin compute the type" (`amp:344c828277844ba13baf7bb418f19563`). That OpenCode plugin was `type-level-tools`, "deep TypeScript type system introspection for LLM agents" (its AGENTS.md, loaded in `opencode:4a3a6a01c9b6746648871433b9e7eca0`). It moved into this repo on 2026-04-24 (`ca2f1b4`, `6abeee9`).
- The current bar, September 2026: "It needs to be useful out of the box" (`amp:512028fc854533a376b843be9236a80d`, 2026-09-04). "We need quartz to use it in other projects so it needs to be fast and ready" (`amp:bed410d443cadcd3632f3fb6989fbfbd`, 2026-09-06).
- Agents already use it to close the loop: "Now quartz diagnostics on the edited/new `.ts` files" (`claude:66cd963365782e068b0a8801e387a204`, vellum, 2026-07-24). Also "quartz diagnostics on the changed protocol file" (`claude:3632c4559f684cfc7bdfe30fe56da0de`, quasar, 2026-08-18).

## What changes

The agent asks the compiler instead. `quartz info` returns the resolved members of a symbol, `check-snippet` type-checks proposed code against the project without writing a file, and `transform-search` finds existing functions whose signature turns one type into another, each candidate checked by a synthetic compile. Every answer is a JSON envelope with a schema the agent can discover (`quartz schema show <command>`), so the answer is data, not prose to re-parse.

## Where it fits

Every agent working in a TypeScript repo gets the same codebase facts from the compiler, through the CLI or the OpenCode plugin. pulsar builds its TypeScript signals on `@skastr0/quartz-engine` (`pulsar/packages/ts-pack/package.json:47`). prism keeps a tsconfig-only package, "Quartz/typecheck surface for workflow .ts files", so workflow files can be checked with quartz (`prism/packages/prism-workflow-authoring/package.json:4`).

## See it run

All runs 2026-09-24 on macOS arm64 with the published package, `bunx @skastr0/quartz@0.2.1`. Output trimmed where marked.

What does this type contain? (run in the quartz repo itself; 2.77 s cold)

```console
$ quartz info '{"symbol":"TypeAnalyzer"}' --format pretty
{
  "ok": true,
  "command": "info",
  "data": {
    "name": "TypeAnalyzer",
    "kind": "interface",
    "location": { "file": "packages/engine/src/contracts.ts", "line": 463 },
    "properties": [
      { "name": "getPackages", "type": "() => Promise<readonly PackageInfo[]>" },
      { "name": "listSymbols", "type": "(options?: ListSymbolsOptions) => Promise<SymbolListResult>" },
      { "name": "getTypeInfo", "type": "(symbolName: string, packageName?: string) => Promise<TypeInfo | null>" },
      …
```

Will this code compile before I write it to disk? (quartz repo; project types are in scope without imports)

```console
$ quartz check-snippet '{"code":"declare const analyzer: TypeAnalyzer;\nconst names: string[] = (await analyzer.getPackages()).map((p) => p.name);\nconst count: string = (await analyzer.getPackages()).length;"}' --format pretty
{
  "ok": true,
  "command": "check-snippet",
  "data": {
    "valid": false,
    "errors": [
      { "message": "Type 'number' is not assignable to type 'string'.", "line": 3, "column": 7, "severity": "error" }
    ]
  }
}
```

Does a `User → UserDTO` converter already exist? (bundled fixture repo)

```console
$ quartz transform-search '{"root":"test/fixtures","from":"User","to":"UserDTO","limit":3,"verifiedOnly":true}' --format pretty
      {
        "name": "toDTO",
        "signature": "toDTO(from: User): UserDTO",
        "file": "types/transforms.ts",
        "line": 30,
        "confidence": "high",
        "verification": { "status": "verified", "method": "synthetic", "reason": "synthetic_check_passed" },
      …
      {
        "name": "transform",
        "signature": "transform(input: User): UserDTO",
        "file": "types/transforms.ts",
        "line": 211,
      …
```

Is the contract I am proposing backed by evidence? (fixture repo; `evidence` field trimmed)

```console
$ quartz verify-contract '{"root":"test/fixtures","from":"User","to":"UserDTO","symbol":"toDTO","snippet":"declare const u: User;\nconst dto: UserDTO = toDTO(u);"}'
"schemaVersion": "verify-contract/v1",
"ok": true,
"checks": {
  "compatibility": { "passed": false, "blocking": false,
    "summary": "User is not directly assignable to UserDTO; verified transform evidence can still satisfy a conversion contract." },
  "snippet":     { "passed": true, "summary": "Snippet compiles under the package TypeScript project." },
  "diagnostics": { "passed": true, "summary": "Package diagnostics are clean." },
  "transform":   { "passed": true, "summary": "A compiler-verified transform satisfies the requested contract." }
}
```

## How it works

`@skastr0/quartz-engine` opens one persistent `QuartzWorkspace` per root on the TypeScript 7 native compiler (TS-Go) through its async API, `new API(...)` from `typescript/unstable/async` (`packages/engine/src/workspace.ts:7`, `:106`). `createTypeAnalyzer` wraps that workspace in a Promise API: leaf operations (info, expand, eval, at-position, file), reference operations (related, graph, refactor-preview), verification operations (check-snippet, compatible, verify-contract), and transform search (`packages/engine/src/index.ts:3`). Snippets and synthetic transform checks run as virtual files through `runWithTemporaryFileUpdate`, so the base snapshot never changes (`workspace.ts:194`). The CLI (`apps/cli/src/main.ts`) is an Effect v4 program that decodes JSON payloads, keeps analyzers in a scoped `CliAnalyzers` service for batch calls (`main.ts:413`), and writes `agentic-cli/v1` envelopes to stdout or stderr. The OpenCode plugin keeps one analyzer for the workspace and marks it dirty on `file.edited` / `file.watcher.updated` events (`apps/opencode-plugin/src/server.ts:362`, `:403`).

Diagram spec:

- nodes: `agent (shell)`, `agent (OpenCode)`, `pulsar ts-pack`, `quartz CLI (apps/cli)`, `OpenCode plugin (apps/opencode-plugin)`, `quartz-engine: createTypeAnalyzer`, `QuartzWorkspace`, `virtual files (runWithTemporaryFileUpdate)`, `TS-Go native compiler (typescript/unstable/async API)`, `project tsconfig.json + sources`, `JSON envelope / artifact`
- edges: `agent (shell)` → `quartz CLI` (JSON payload); `agent (OpenCode)` → `OpenCode plugin` (tool call `type_*`); `pulsar ts-pack` → `quartz-engine` (library import); `quartz CLI` → `quartz-engine`; `OpenCode plugin` → `quartz-engine`; `quartz-engine` → `QuartzWorkspace`; `QuartzWorkspace` → `TS-Go native compiler`; `TS-Go native compiler` → `project tsconfig.json + sources` (reads); `quartz-engine` → `virtual files` (snippet and synthetic checks) → `TS-Go native compiler`; `quartz CLI` → `JSON envelope / artifact`; `OpenCode plugin` → `quartz-engine` (`markDirty` on file events)

## Who it is for / not for

For:
- Coding agents working in TypeScript repos that need type facts, not text matches.
- Tools that want compiler answers as a library (pulsar does this through `@skastr0/quartz-engine`).
- OpenCode users who want the same analysis as tool calls with a warm analyzer.

Not for:
- Proving runtime correctness. `verify-contract` returning `ok` means the configured checks found evidence, not that the code is sound (`README.md:136`).
- JavaScript-only projects or projects without a `tsconfig.json`: the engine refuses to open (`WORKSPACE_OPEN_FAILED`, see Gaps).
- Windows: no platform package exists (`packages/npm/` ships darwin-arm64, darwin-x64, linux-arm64, linux-x64 only).
- Editor users who already have a language server open; quartz adds nothing a human in VS Code lacks.

## Install

```bash
bunx @skastr0/quartz capabilities
npx -y @skastr0/quartz capabilities
```

npm is the install channel to point readers at. The 0.2.x GitHub Releases are still drafts, and publishing them is the operator's call.

OpenCode plugin: add `@skastr0/quartz-opencode-plugin/server` to the OpenCode plugin config. Library: `bun add @skastr0/quartz-engine`.

Platforms: macOS and Linux, arm64 and x64. I ran the macOS arm64 path only; Linux is unverified by me today. No Windows build.

## Proof

- Published: `@skastr0/quartz` 0.1.0 (2026-06-03), 0.2.0 (2026-08-17), 0.2.1 (2026-09-07); `@skastr0/quartz-engine` 0.2.0, 0.2.1 (`npm view @skastr0/quartz time`).
- Tests: `bun run verify` → typecheck, build, `Test Files 11 passed (11)`, `Tests 92 passed (92)`, package boundaries passed (run 2026-09-24).
- Used by pulsar: `@skastr0/quartz-engine` 0.2.1 in `pulsar/packages/ts-pack/package.json:47`; pulsar 0.2.0 "Scored TypeScript through Quartz 0.2.1 … instead of ts-morph" (`pulsar/CHANGELOG.md:38`).
- Dogfood: during quartz's own Effect v4 migration, 30 batched `at-position` probes ran in about 2.6 s and `refactor-preview` on `runCli` found two safe locations (`docs/effect-v4-migration.md:30-37`).
- Speed, one workload: `refactor-preview` warm-analyzer p50 went from 3,422 ms to 12 ms after moving to the compiler-native reference API (3 samples, macOS arm64; `docs/bench/baseline-20260723.1-monorepo-hotpaths.json`, `docs/bench/post-hotpath-monorepo.json`). The benchmarked repo is recorded only as `root: "."`, so which monorepo it was is unverified.
- Surface: 18 analysis commands plus discovery (`capabilities`, `schema`, `examples`, `doctor`) in the CLI; 19 `type_*` tools in the OpenCode plugin (`README.md:249-251`).
- GitHub: public repo `skastr0/quartz`, 0 stars (`gh repo view`, 2026-09-24).

## Gaps

- transform-search misses helpers that are not re-exported from the package entry. In the quartz repo, `createLeafOperations(context: AnalyzerContext): LeafOperations` (`packages/engine/src/leaf-operations.ts:485`) is found as an assignable match, but its synthetic check fails with `Cannot find name 'AnalyzerContext'`, so the default query returns `"results": []` with `"assignableMatches": 2, "verifiedMatches": 0`. Fixture runs look better than real-repo runs.
- check-snippet injects `import type` for every project export, so a snippet that writes its own import gets `Duplicate identifier` errors, and the path alias `@skastr0/quartz-engine` did not resolve from the virtual file ("Cannot find module '@skastr0/quartz-engine'"). The Effect v4 dogfood hit the same wall: check-snippet "could not resolve the CLI-local `effect` package" (`docs/effect-v4-migration.md:41`). Importing every export was the first `evalType` design, and a review flagged the name collisions on 2025-12-08 (`amp:344c828277844ba13baf7bb418f19563`).
- `symbols` on the quartz repo listed `TypeAnalyzer` twice per file and included `.d.ts` files from ignored `dist/` folders; on the fixture repo it did not duplicate. Cause unverified.
- GitHub Releases: v0.2.0 and v0.2.1 are drafts; the visible "Latest" is v0.1.0, the old ts-morph core (`gh release list`).
- README is stale on distribution: it says "After the first npm release" (`README.md:28`, `:233`) while 0.2.1 is on npm.
- No `tsconfig.json` means no analysis: `doctor` in an empty directory returned `QuartzEngineError … No tsconfig.json found`.
- TypeScript is pinned to a nightly, `7.1.0-dev.20260905.1` (`package.json:408`); the engine builds on `typescript/unstable/async`, an API Microsoft marks unstable.
- One-shot commands pay a cold start: 0.7 s for `diagnostics` to 2.8 s for `info` on the quartz repo today. Warm speed needs batch mode or the plugin (`docs/performance.md`).
- Status in the repo is "Experimental … may change while the project is in `0.y.z`" (`README.md:9`).

## Demo moments

1. Terminal cast, ~20 s: an agent-style `check-snippet` on the quartz repo returns the one real type error (line 3, `number` into `string`) before any file is written. Proves: compile feedback without touching disk.
2. Terminal cast, ~25 s: `transform-search User → UserDTO` returns `toDTO` with `"status": "verified"`, then `verify-contract` shows compatibility failing but the transform check passing. Proves: quartz finds the existing function and says how much it trusts it.
3. Before/after split, ~15 s: `grep -rn "interface TypeAnalyzer"` shows a declaration line; `quartz info '{"symbol":"TypeAnalyzer"}'` shows every resolved member signature. Proves: text search finds where a type lives, quartz shows what it is.

## Copy bank

- tagline: TypeScript answers for agents, from the compiler.
- short description: quartz gives coding agents compiler-backed TypeScript answers: types, snippet checks, and existing transforms, as JSON. CLI and OpenCode plugin.
- page lede: quartz answers an agent's TypeScript questions with the compiler's own answers. It runs the TypeScript 7 native compiler behind a JSON CLI, so an agent checks a type or a snippet before it writes code, not after `tsc` fails.
- X post: An agent that greps for a TypeScript type still has to guess what it resolves to. quartz asks the compiler instead: `quartz info`, `check-snippet`, `transform-search`, all JSON. 0.2.1 runs on the TypeScript 7 native compiler. bunx @skastr0/quartz capabilities
