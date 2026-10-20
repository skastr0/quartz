# Quartz on tsrs: verification findings

Base: `feat/tsrs-backend` at a38299f. tsrs 0.18.0 (TS 7.1.0-dev.20260929) against TS-Go 7.1.0-dev.20260930.4,
selected with `TSRS_BINARY=<path to typescript-darwin-arm64/lib/tsc>`.

## Coverage

| Target | Jobs | Notes |
| --- | --- | --- |
| `test/fixtures` | 89 | 10 symbols across kinds, all symbol commands plus eval, snippets, transform-search, why-error |
| scratch edge repo | 217 | re-export barrel, `export *`, `export as`, namespace import, enum, const enum, merged interfaces, overloads, abstract class, conditional and recursive types, JSX, JS, `.d.ts`, unicode paths, syntax errors, tsconfig `paths` |
| `~/Projects/junto` | 105 | 10,467 exported symbols |
| `~/Projects/pulsar` `packages/core`, `packages/cli` | 210 | root tsconfig is solution-style, so the sweep scopes by package |
| `~/Projects/vortex` `packages/auth`, `packages/agent`, `apps/web`, `apps/worker` | 420 | |
| 33 targeted probes | 33 | snippet with project imports, global augmentation, 3000-line snippet, bad roots, missing files, EOF positions, unicode, DOT graphs |
| in-process stress | 7 scenarios | edit/revert and create/delete on disk with `markDirty`, 40 concurrent snippets, 150 sequential snippets, queries racing two `refresh()` calls, snippet after race, dispose |

Result: 1,041 sweep jobs, 0 result differences against TS-Go, 0 hangs, 0 tsrs panics on stderr, 0 `api: unsupported`.
Normalized before comparing: timings, the stdlib `lib.*.d.ts` install path, checker symbol ids in `__@name@N`.
Latency is comparable (fixtures median 821 ms tsrs vs 865 ms TS-Go; pulsar core 2146 vs 1996), measured under
load from concurrent jobs, so treat it as no-regression evidence only.
The in-process stress also matched TS-Go, which covers the `ensurePrograms` refresh change and the synthetic program for snippets.

## Findings: Quartz (identical on tsrs and TS-Go)

1. **Rename collisions are reported safe.** `previewRefactor` only flags `.d.ts` and out-of-package files
   (`reference-operations.ts:719`). Renaming `Repo` to the existing `Core` returns `safe: true`, `predictedErrors: []`;
   `tsc` on the renamed copy reports TS2428 and TS2314. Test: `engine-rename-collisions.test.ts` (`it.fails`).
2. **`related` leaks checker-internal names.** `symbol: "__@iterator@100"`, `context: "property \"__@iterator@100\""`.
   The suffix is a per-program id (tsrs `@93`, TS-Go `@137` for the same query), so output is not stable across backends.
   **Fixed** in 1b1963f (`[Symbol.iterator]`, `[uniqueKey]`; also `info` properties and compatibility messages). Test: `engine-related-symbol-names.test.ts`.
3. **Cross-package declarations are not reachable by file.** In vortex, `symbols`/`info` with `package: packages/agent` report
   `Actor` at `packages/plugin/src/actor.ts`; `file` and `at-position` on that path with the same package return NotFound
   (they work with `package: packages/plugin`). **Fixed** in f286667. Test: `engine-cross-package-files.test.ts`.
4. **Renaming a re-export alias rewrites the source declaration.** `refactor-preview` on `RenamedCore` (`export { Core as RenamedCore }`)
   renames `Core` in `lib/core.ts` and rewrites the specifier to `RenamedCoreRenamed as RenamedCore`. A rename of the alias name
   alone is the usual expectation. Behavior choice; no test.
5. **`info` on `keyof` types lists `String` members with absolute paths.** `info KeyAlias` (`keyof Core`) returns `toString`,
   `charAt`, ... with `from` set to an absolute `node_modules/.../lib.es5.d.ts`, which is neither portable nor useful. No test.
6. **`check-snippet` cannot contain JSX.** In a `jsx: react-jsx` project, `const x = <div/>;` yields "Cannot find name 'div'" and
   "'>' expected" (the virtual file is parsed as `.ts`). No test.
7. **Namespaces are not indexed.** `export namespace Util` and `export { NS }` (namespace import) give `info` NotFound; `symbols`
   kinds are class, enum, function, interface, type, variable only. Scope decision; no test.
8. **tsconfig option errors are not surfaced.** An invalid config (`baseUrl` removed in TS 7, TS5102, and TS5090) produced no
   entry from `diagnostics`.
9. **Solution-style root returns an empty answer without a hint.** pulsar root `symbols` gives `total: 0` under `(root)`; the code is in 14 sub-packages.
10. **`doctor` on a directory without a tsconfig walks the whole tree** (113 packages under `/tmp`).
11. **`leaf-operations.ts:186` calls `getAliasedSymbol(exportedSymbol)` without the alias-flag check** the other call sites now have.
    It sits behind an `isExportSpecifier` branch, so it is low risk, but it is the one remaining path to the panic below.
12. **A symlinked workspace root yields absolute paths.** When the root is reached through a symlink (macOS `/tmp` and `/var`),
    TypeScript reports the realpath of workspace dependencies, which is not under `context.root`, so `symbols` returns absolute
    file paths and the cross-package fallback in `findSourceFile` does not apply. Resolve the root with `realpath` to fix. No test.
13. **`compatible` accepts symbol names only.** `from: "{a: string}"` returns `Symbol "{a: string}" not found`.

## Findings: tsrs

No new tsrs defect. One correction to the brief and one low-severity difference:

- TS-Go does **not** tolerate `getAliasedSymbol` on a non-alias symbol. Both backends reject the request with
  `Error: panic: Should only get alias here` (TS-Go includes a Go stack in the message). The only difference is stderr: tsrs also writes
  the Rust panic (210 bytes) to its stderr, TS-Go writes nothing. Quartz's alias guard is correct for both.
- Standalone repro (no Quartz): see below.

## Draft upstream issue (tsrs, optional, low severity)

**Title:** `getAliasedSymbol` on a non-alias symbol prints a panic to stderr (request already returns an error)

**Body:**
`checker.getAliasedSymbol(symbol)` on a symbol without `SymbolFlags.Alias` fails the request with
`panic: Should only get alias here` (`crates/tsrs_checker/src/checker_08.rs:2155`). The process survives and the next call works,
which matches TS-Go 7.1.0-dev.20260930.4 (the Go server returns the same message plus a stack in the error).
The difference is that tsrs additionally writes the default Rust panic report to the server's stderr:

```
thread 'tsrs-api-getAliasedSymbol' (N) panicked at crates/tsrs_checker/src/checker_08.rs:2155:9:
Should only get alias here
note: run with `RUST_BACKTRACE=1` environment variable to display a backtrace
```

Embedders that treat any stderr output as a failure signal (CLIs with strict stdout/stderr contracts) see this even though the request error is handled.
Suggested: install a panic hook for API request threads that routes the report into the error response only, or return an error value instead of panicking
for non-alias input.

Repro (tsrs 0.18.0-ts7.1.0-dev.20260929):

```ts
import { API } from "tsrs/unstable/async"
const cwd = "/path/to/proj" // tsconfig.json + a.ts containing: export const a = 1
const api = new API({ cwd, tsserverPath: "/path/to/@tsrs/darwin-arm64/tsrs" })
const snapshot = await api.createSnapshot({ openProjects: [`${cwd}/tsconfig.json`] })
const project = snapshot.getConfiguredProject(`${cwd}/tsconfig.json`)!
const moduleSymbol = await project.checker.getSymbolOfSourceFile(`${cwd}/a.ts`)
const [a] = await project.checker.getExportsOfModule(moduleSymbol!) // flags: 2, not Alias
await project.checker.getAliasedSymbol(a!) // rejects: panic: Should only get alias here; stderr gets the Rust panic report
```

If you would rather the call return the symbol itself for non-alias input, that diverges from TS-Go and should be raised upstream there first.
