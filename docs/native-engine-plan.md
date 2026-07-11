# Native engine plan (quartz-next)

Quartz runs a second `TypeAnalyzer` backend on the TypeScript **native** API
(`typescript@next`, the `tsgo` port) alongside the existing ts-morph engine.
Both implement the same `TypeAnalyzer` contract (`packages/core/src/analyzer.ts`);
the CLI and plugin only ever see plain data envelopes, never engine types.

This file is the **source of truth for the native engine's layout and rules**.
Read it before writing any native code. The P0 seam commit established the
skeleton below; command builders extend it without reshaping it.

---

## Goal & status

- Morph stays the **default** engine until an explicit flip decision.
- Native is opt-in via `QUARTZ_ENGINE=native`; unknown values → morph.
- P0 delivered: engine session lifecycle, error helpers, runtime guard, the
  frozen delegator, an implemented `getPackages`, engine selection + fallback,
  doctor/capabilities reporting, and a smoke test. **Every type-analysis command
  is still a stub** returning the engine-not-supported error.

---

## Module layout

```
packages/core/src/native/
  index.ts                 FROZEN delegator — wires TypeAnalyzer → commands/*. Do not edit to add a command.
  engine.ts                Native session lifecycle: one tsgo server (API), LRU/TTL project cache, dispose.
  context.ts               NativeCommandContext { rootDirectory, engine } passed to every command factory.
  errors.ts                engineNotSupported / nativeLoadFailure helpers + cause discriminants + isNativeLoadFailure.
  runtime.ts               Runtime capability guard (Node-only; see quirks) — isNativeRuntimeSupported / assertNativeRuntimeSupported.
  version.ts               nativeAnalysisTypescriptVersion() — the pinned nightly.
  typescript-version.d.ts  Ambient types for the bare `typescript` version export (its exports map ships no types).
  commands/
    <command>.ts           One file per TypeAnalyzer method. Builders own these.
```

Engine selection lives in `packages/core/src/service-spine.ts`
(`resolveRequestedEngine`, `selectEngine`, `createAnalyzerRuntime`, `EngineMeta`).
The CLI (`apps/cli/src/main.ts`) consumes `createAnalyzerRuntime` and surfaces
`meta` in `doctor`/`capabilities`.

### Churn firewall (hard rule)

**All `typescript/unstable/*` imports must stay inside `packages/core/src/native/`.**
Today only `engine.ts` imports `typescript/unstable/sync`. When the native API
changes shape between nightlies, the blast radius stays in this directory. Do not
import `typescript/unstable/*` from anywhere else — wrap what you need behind an
engine method or a helper in `native/`.

### The frozen delegator

`native/index.ts` maps each `TypeAnalyzer` method to `commands/<command>.ts`:

```ts
listSymbols: listSymbols(context),   // context: NativeCommandContext
```

Each command module exports a **factory** `(_ctx) => (…args) => Effect<…>`. To
implement a capability, replace the body of that command file — **never edit
`index.ts`**. This is what lets many builders work in parallel without colliding.

---

## Per-command ownership map

`get-packages.ts` is implemented (package discovery is engine-agnostic — it walks
tsconfig files and needs neither ts-morph nor tsgo). Everything else is a stub.
Each row is an independent unit of work; one builder per file, no shared edits.

| command file (`native/commands/`) | TypeAnalyzer method | status | notes for the builder |
| --- | --- | --- | --- |
| `get-packages.ts` | `getPackages` | **done (P0)** | delegates to shared `discoverPackages`; leave as-is. |
| `get-diagnostics.ts` | `getDiagnostics` | stub | `program.getSemanticDiagnostics()` + `getSyntacticDiagnostics()`; map positions (UTF-16) to line/col. |
| `check-snippet.ts` | `checkSnippet` | stub | compile an in-memory file via the VFS; return diagnostics. |
| `get-type-info.ts` | `getTypeInfo` | stub | resolve symbol via AST + `getSymbolAtLocation`, `checker.getTypeOfSymbol`, `typeToString`. |
| `expand-type.ts` | `expandType` | stub | `NodeBuilderFlags` for full expansion. |
| `get-type-at-position.ts` | `getTypeAtPosition` | stub | `checker.getTypeAtPosition(file, offset)`; offset is UTF-16. |
| `check-compatibility.ts` | `checkCompatibility` | stub | `checker.isTypeAssignableTo(source, target)`. |
| `list-symbols.ts` | `listSymbols` | stub | walk exports via AST (`getExportsOfModule`). |
| `search-types.ts` | `searchTypes` | stub | builds on `listSymbols` + property/base checks. |
| `find-related.ts` | `findRelated` | stub | reference graph via `getReferencedSymbolsForNode`. |
| `generate-graph.ts` | `generateGraph` | stub | reuse `findRelated`; format mermaid/dot. |
| `eval-type.ts` | `evalType` | stub | synthesize a snippet, resolve the alias type. |
| `explain-error.ts` | `explainError` | stub | diagnostic → explanation. |
| `explain-type.ts` | `explainType` | stub | resolution walk. |
| `get-file-declarations.ts` | `getFileDeclarations` | stub | AST traversal via `typescript/unstable/ast` + `/visitor`. |
| `preview-refactor.ts` | `previewRefactor` | stub | rename via `getReferencesToSymbolInFile`. |
| `transform-search.ts` | `transformSearch` | stub | structural input/output search. |
| `verify-contract.ts` | `verifyContract` | stub | compose compatibility + snippet + diagnostics + transform. |
| `refresh.ts` | `refresh` | stub | invalidate the engine cache (see `engine.ts`). |
| `mark-dirty.ts` | `markDirty` | stub | mark the engine cache dirty. |

When a native result **legitimately differs** from morph (e.g. native fixes a
documented morph bug), do **not** edit tests/fixtures to force parity — record the
difference for the parity harness to classify.

If a capability is **genuinely infeasible** on the native API, do not fake it:
keep the stub returning the engine-not-supported error and document the
infeasibility.

---

## Engine selection & fallback

- `resolveRequestedEngine(env)` → `"native" | "morph"` (default morph; trims and
  lowercases `QUARTZ_ENGINE`).
- `selectEngine({ requestedEngine, nativeRuntimeSupported })` is the pure decision
  and returns `{ engine, requestedEngine, fellBack, fallbackReason? }`.
- `createAnalyzerRuntime(root, env)` constructs the selected analyzer and returns
  `{ analyzer, meta, dispose }`. Native construction failure also falls back to morph.
- **doctor** reports the *effective* engine (post-fallback): `engine`,
  `requested_engine`, `analysis_typescript_version`, `engine_fallback`,
  `engine_fallback_reason?`.
- **capabilities** reports the *configured* engine (`resolveRequestedEngine()`)
  and its analysis TypeScript version.

Two fallback levels:

1. **Coarse (implemented):** unsupported runtime (or native construction failure)
   → morph, recorded in `meta`. This is what keeps the Bun-hosted CLI safe.
2. **Fine (pattern for builders):** a native project-load failure on a legacy
   tsconfig should fall back to morph *for that operation* with a note in the
   envelope's `meta`. The engine raises `nativeLoadFailure` (use
   `isNativeLoadFailure`); the command decides whether to fall back. Legacy
   triggers: `moduleResolution node/node10`, `baseUrl`, `target es5`,
   `module amd/umd/system`.

---

## Native API quirks (verified)

Grounded by direct execution against `typescript@7.1.0-dev.20260711.1`. Trust
these over intuition; several are surprising.

1. **Node-only runtime.** The sync API (`typescript/unstable/sync`) spawns a
   `tsgo` child and, on POSIX, reads `child.stdout._handle.fd` to build its RPC
   channel. Bun does not expose that Node internal, so `new API(...)` throws (and
   can strand a child) under Bun. **Importing** the modules is safe on any
   runtime; only **constructing** the API is Node-only. `runtime.ts` guards on
   `process.versions.bun` and never attempts construction under Bun.
   - Consequence: `bun test`/vitest run under **Node**, so native works in tests.
     The production CLI is built `--target bun`, so under it native falls back to
     morph. Making native run under Bun is a separate, out-of-scope effort.
2. **Load flow:**
   `new API({ cwd })` → `api.updateSnapshot({ openProjects: [tsconfigPath] })` →
   `snapshot.getProject(tsconfigPath)` → `project.program` / `project.checker`.
   Dispose: `snapshot.dispose()` then `api.close()` (reaps the child).
3. **Diagnostics live on `Program`:** `getSemanticDiagnostics`,
   `getSyntacticDiagnostics`, `getBindDiagnostics`, `getConfigFileParsingDiagnostics`.
   The `Checker` holds the type methods (`getTypeAtLocation`, `getTypeOfSymbol`,
   `isTypeAssignableTo`, `typeToString`, …).
4. **Diagnostic positions are UTF-16 code units** — map to line/column against
   the source text, do not assume byte offsets.
5. **`DocumentIdentifier` is `string | { uri }`** — a path string or `{ uri }`,
   **never** `{ fileName }`. `openProjects`/`getProject` take the tsconfig path.
6. **Prefer AST + `getSymbolAtLocation`** over `resolveName` without a location
   (it misses). Traverse with `typescript/unstable/ast` (+ `/is`, `/utils`,
   `/visitor`).
7. **Snapshots are per-view; opens are ref-counted.** A `Project`/`Program`
   handle is tied to the snapshot that produced it — do not cache it across an
   `updateSnapshot`. Cache the tsconfig path and re-fetch from the current
   snapshot (this is what `engine.ts` does). Opened projects persist across
   snapshots until closed.
8. **Enums import, never hard-code.** Import `NodeBuilderFlags`, `SymbolFlags`,
   `TypeFlags`, `SignatureKind`, etc. from `typescript/unstable/sync`. Numeric
   enum values change between versions.
9. **Analysis TS version:** `import { version } from "typescript"` (the main entry
   is a tiny version-only module; safe on any runtime, bundle-light). ts-morph's
   version is `ts.version` from `ts-morph`.
10. **Native binary:** the spawned child is `tsgo`, resolved from the optional
    `@typescript/typescript-<platform>-<arch>` package. Detect the child in tests
    via `pgrep -P <pid>` (direct children), not by name.

---

## How to implement a command

```ts
// native/commands/get-diagnostics.ts
import { Effect } from "effect"
import type { TypeAnalyzer } from "../../analyzer"
import type { NativeCommandContext } from "../context"
// import anything native from within native/ only — never typescript/unstable/* here directly

export const getDiagnostics =
  (ctx: NativeCommandContext): TypeAnalyzer["getDiagnostics"] =>
  (packageNameOrOptions) =>
    Effect.gen(function* () {
      const packages = yield* ctx.engine // resolve the target tsconfig, then:
      // const program = ctx.engine.getProgram(tsconfigPath)
      // const diagnostics = program.getSemanticDiagnostics()
      // map to the envelope shape declared in analyzer.ts / project-types.ts
    })
```

- Use `ctx.engine.getProject(tsconfigPath)` / `getProgram(tsconfigPath)`.
- Resolve the tsconfig path from the package (mirror how the morph spine resolves
  packages) — `getPackages` already returns `PackageInfo.tsconfigPath`.
- Return the **exact** envelope types from `analyzer.ts` / `project-types.ts`.
  Envelopes are plain data — no engine types cross the boundary.
- Wrap native calls so a load failure surfaces as `nativeLoadFailure`, and decide
  the fine-grained morph fallback per the contract above.

---

## Constraints (review blockers)

1. Never import ts-morph inside `native/`. Never change morph's behavior; it stays
   the default.
2. No hard-coded numeric enum values from any TypeScript version — import enums.
3. Follow this file's module layout; edit only your own `commands/<command>.ts`.
4. Never weaken/skip/edit existing tests or fixtures to force green. Record
   legitimate native-vs-morph differences instead.
5. Keep `typescript/unstable/*` imports inside `native/` (churn firewall).
6. Do not fake infeasible capabilities — stub + document.
7. Verify before claiming: `bun run typecheck` and the tests you add must pass.

---

## Known tradeoffs / open items

- **CLI bundle size:** the seam statically imports the native module into the
  spine, so `bun build --target bun` bundles the `typescript/unstable` client into
  the default (morph) CLI (~14 MB main.js). It builds and runs. If this matters
  before the flip, switch `createAnalyzerRuntime` to load the native module via
  dynamic import in the native branch only (turns construction async — ripples
  into the CLI's sync analyzer cache).
- **Fine-grained legacy-tsconfig fallback** is a documented pattern, not yet
  wired per command (the stubs don't load projects). Implement it alongside the
  first real command that loads a project.
- **opencode plugin** still constructs the morph analyzer directly
  (`CoreLayer`/`TypeAnalyzerService`). Route it through `createAnalyzerRuntime`
  when native graduates past opt-in.
