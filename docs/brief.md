# Quartz — brief

updated: 2026-09-24 · version: 0.2.1 · maturity: usable-with-gaps

Why usable-with-gaps: 0.2.1 is on npm and Pulsar runs on it, but transform-search misses internal helpers in real repos (see Gaps).

## One line

Quartz answers an agent's TypeScript questions with the compiler's own answers.

## The pain

Your agent is changing TypeScript it can't see the types of.

- **It guesses types from text.** It greps for the declaration and rebuilds the type in its head, through generics and inference it can't see.
- **It finds out from `tsc`.** Write, run `tsc`, read the error, try again. Many turns go to "flailing on type errors".
- **It rewrites what exists.** Nothing tells it a `User → UserDTO` function is already two files over. (inferred)

Receipts: the quote is Guilherme, 2026-08-02, about agents writing Prism workflows (Quasar `claude:b93b1d1b…`). The origin is his 2025-12-08 ask for a tool so "the agent [can] pass in arbitrary type-level typescript … and have our plugin compute the type" (`amp:344c8282…`). That plugin moved into this repo on 2026-04-24 (`ca2f1b4`). No session shows the third bullet.

## What changes

The agent asks the compiler before it writes code.

| the agent wants to know | command | what it gets back |
|---|---|---|
| what this type contains | `info`, `expand` | resolved members and signatures |
| whether this code compiles | `check-snippet` | compiler errors with line and column; nothing written to disk |
| whether a converter exists | `transform-search` | matching functions, each marked `verified` by a test compile |
| whether a proposed change holds | `verify-contract` | one pass/fail packet: assignability, snippet, diagnostics, transform |

Every answer is JSON with a discoverable schema (`quartz schema show <command>`).

## Where it fits

Every agent in a TypeScript repo gets the same codebase facts, from the compiler, through the CLI or the OpenCode plugin. Pulsar builds its TypeScript signals on `@skastr0/quartz-engine` (`pulsar/packages/ts-pack/package.json:47`). Prism keeps a tsconfig package so workflow files can be checked with Quartz (`prism/packages/prism-workflow-authoring/package.json:4`).

## See it run

Run 2026-09-24, macOS arm64, `bunx @skastr0/quartz@0.2.1`. Output trimmed.

What does this type contain? (Quartz repo)

```console
$ quartz info '{"symbol":"TypeAnalyzer"}' --format pretty
"name": "TypeAnalyzer", "kind": "interface",
"location": { "file": "packages/engine/src/contracts.ts", "line": 463 },
"properties": [
  { "name": "getPackages", "type": "() => Promise<readonly PackageInfo[]>" },
  { "name": "getTypeInfo", "type": "(symbolName: string, packageName?: string) => Promise<TypeInfo | null>" },
  …
```

Will this compile? (Quartz repo; project types are in scope, no imports needed)

```console
$ quartz check-snippet '{"code":"declare const analyzer: TypeAnalyzer;\nconst count: string = (await analyzer.getPackages()).length;"}'
"valid": false,
"errors": [{ "message": "Type 'number' is not assignable to type 'string'.", "line": 2, "column": 7 }]
```

Is there already a `User → UserDTO` function? (bundled fixture repo)

```console
$ quartz transform-search '{"root":"test/fixtures","from":"User","to":"UserDTO","verifiedOnly":true}'
{ "signature": "toDTO(from: User): UserDTO",     "file": "types/transforms.ts", "line": 30,  "verification": { "status": "verified" } }
{ "signature": "transform(input: User): UserDTO", "file": "types/transforms.ts", "line": 211, "verification": { "status": "verified" } }
… 3 more verified: toDTO(user), saveUser, deprecatedToDTO
```

Does the change hold? (fixture repo)

```console
$ quartz verify-contract '{"root":"test/fixtures","from":"User","to":"UserDTO","symbol":"toDTO","snippet":"declare const u: User;\nconst dto: UserDTO = toDTO(u);"}'
"ok": true
compatibility  passed: false  "User is not directly assignable to UserDTO; verified transform evidence can still satisfy a conversion contract."
snippet        passed: true   "Snippet compiles under the package TypeScript project."
diagnostics    passed: true   "Package diagnostics are clean."
transform      passed: true   "A compiler-verified transform satisfies the requested contract."
```

## How it works

Quartz keeps one TypeScript 7 native compiler (TS-Go) open per project, through its async API (`typescript/unstable/async`, `packages/engine/src/workspace.ts:106`). Snippets and transform checks compile as temporary virtual files, so your files are never touched (`runWithTemporaryFileUpdate`, `workspace.ts:194`). The CLI reuses one compiler across a batch of payloads. The OpenCode plugin keeps it warm for the whole session and refreshes it on file edits (`apps/opencode-plugin/src/server.ts:403`).

Diagram spec:

```
agent (shell) ──JSON payload──▶ quartz CLI ─────────┐
agent (OpenCode) ──type_* tool call──▶ OpenCode plugin ─┤
pulsar ts-pack ──library import─────────────────────┤
                                                    ▼
                                    @skastr0/quartz-engine
                                    (createTypeAnalyzer → QuartzWorkspace)
                                      │                 │
                         project reads│                 │snippet / transform checks
                                      ▼                 ▼
                            TS-Go native compiler ◀── virtual files
                                      │
                                      ▼
                         tsconfig.json + sources
quartz CLI ──▶ JSON envelope (stdout) or artifact file
```

## Who it is for / not for

| for | not for |
|---|---|
| coding agents in TypeScript repos that need type facts, not text matches | proving runtime correctness: `verify-contract` passing means the checks found evidence, not that the code is sound |
| tools that want compiler answers as a library (`@skastr0/quartz-engine`) | projects without a `tsconfig.json`: Quartz won't open them |
| OpenCode users who want the same answers as tool calls | Windows: no build |
| | a person in an editor with a language server; they already have this |

## Install

```bash
bunx @skastr0/quartz capabilities
# or
npx -y @skastr0/quartz capabilities
```

- OpenCode plugin: `@skastr0/quartz-opencode-plugin/server`
- Library: `bun add @skastr0/quartz-engine`
- macOS and Linux, arm64 and x64. I ran macOS arm64 only; Linux unverified. No Windows.
- Point readers to npm. The 0.2.x GitHub Releases are drafts; publishing them is the operator's call.

## Proof

- **On npm:** `@skastr0/quartz` 0.1.0 (2026-06-03), 0.2.0 (2026-08-17), 0.2.1 (2026-09-07) (`npm view @skastr0/quartz time`).
- **Tests:** `bun run verify` → `Tests 92 passed (92)` in 11 files, run 2026-09-24.
- **Used by Pulsar:** "Scored TypeScript through Quartz 0.2.1 … instead of ts-morph" (`pulsar/CHANGELOG.md:38`).
- **Used by agents after edits:** "Now quartz diagnostics on the edited/new `.ts` files" (Quasar `claude:66cd9633…`, 2026-07-24).
- **Warm speed, one workload:** `refactor-preview` p50 went from 3,422 ms to 12 ms (3 samples, macOS arm64; `docs/bench/baseline-20260723.1-monorepo-hotpaths.json` → `docs/bench/post-hotpath-monorepo.json`). Which repo was benchmarked is not recorded.
- **Surface:** 18 analysis commands plus `doctor` in the CLI (`README.md:112-130`), 19 `type_*` tools in the plugin (`README.md:249-251`).

## Gaps

- **transform-search misses internal helpers.** In the Quartz repo, `createLeafOperations(context: AnalyzerContext): LeafOperations` is found but fails its test compile (`Cannot find name 'AnalyzerContext'`), so the default query returns `[]`. Fixtures look better than real repos.
- **check-snippet breaks on snippets with their own imports:** `Duplicate identifier`, and path aliases don't resolve (`docs/effect-v4-migration.md:41` hit the same).
- **`symbols` lists duplicates** in the Quartz repo (twice per file) and picks up `.d.ts` files from ignored `dist/`. Cause unverified.
- **README is stale:** it says "After the first npm release" (`README.md:28`) while 0.2.1 is on npm. GitHub's "Latest" release is still v0.1.0.
- **Cold start:** one-shot commands took 0.7 s (`diagnostics`) to 2.8 s (`info`) on the Quartz repo. Use batch mode or the plugin for warm speed.
- **Nightly compiler:** pinned to TypeScript `7.1.0-dev.20260905.1` on an API Microsoft marks unstable (`package.json:408`).

## Demo moments

1. **check-snippet, ~20 s.** An agent-style snippet returns one type error before anything is written. Proves: compile feedback without touching disk.
2. **transform-search then verify-contract, ~25 s.** `toDTO` comes back `verified`; the contract packet shows direct assignability failing and the transform passing. Proves: it finds the existing function and says how far to trust it.
3. **grep vs info, split screen, ~15 s.** `grep -rn "interface TypeAnalyzer"` shows one line; `quartz info` shows every resolved member. Proves: grep finds where a type is; Quartz shows what it is.

## Copy bank

- tagline: TypeScript answers for agents, from the compiler.
- short description: Compiler-backed TypeScript answers for coding agents: types, snippet checks, existing transforms, as JSON. CLI and OpenCode plugin.
- page lede: Quartz answers an agent's TypeScript questions with the compiler's own answers. Your agent checks a type or a snippet before it writes code, not after `tsc` fails.
- X post: An agent that greps for a TypeScript type still has to guess what it resolves to. Quartz asks the compiler instead: `info`, `check-snippet`, `transform-search`, all JSON, on the TypeScript 7 native compiler. bunx @skastr0/quartz capabilities
