# Native engine — parity & performance evidence (P6)

Evidence produced by `scripts/native-parity.ts` and `scripts/native-bench.ts`,
comparing the native TypeScript engine (`typescript@7.1.0-dev.20260711.1`, the
`tsgo` port) against the default ts-morph engine (`typescript@5.9.2`) behind the
same `TypeAnalyzer` contract.

- **Analysis compilers:** ts-morph engine → TypeScript **5.9.2**; native engine
  → TypeScript **7.1.0-dev.20260711.1**.
- **Target project:** `test/fixtures` (the repo's dual-engine fixture project —
  the reliable in-repo target both engines load; it isolates per-call behavior).
- **Parity verdict:** **`parityPassed = false`** — 3 regressions, all in the
  native reference-graph command family (`findRelated`, `generateGraph`).
- **Performance:** native is faster only on `check-snippet` (~5×); on the cheap
  cached reads it is slower because the `tsgo` RPC round-trip dominates on a
  tiny project. Details below — stated plainly, not estimated.

> **Why these scripts don't run under `bun scripts/…`.** The native sync client
> spawns a `tsgo` child and reads Node-only child fds, so it needs **Node** (Bun
> falls back to morph). It also resolves the `tsgo` binary relative to its own
> module location, so `typescript/unstable/sync` must load **unbundled** — the
> repo's Vitest/Vite host (Node + source resolution) satisfies both. Running the
> bundled `dist` under `node` fails tsgo binary resolution; running under `bun`
> silently falls back to morph. Reproduction command is at the bottom.

## Parity

Every implemented `TypeAnalyzer` command is run through both engines over
`test/fixtures` and the `payloads/` inputs, then classified:

| classification | meaning | blocks parity? |
| --- | --- | --- |
| identical | normalized envelopes match | no |
| improvement | native is more correct (documented, cited) | no |
| difference | native diverges symmetrically; load-bearing output preserved (documented) | no |
| regression | any other divergence — fails closed | **yes** |
| unsupported | native returns engine-not-supported (a stub or infeasible sub-mode) | no |

`parityPassed` is true iff **regression count is 0**.

**Normalization** matches the repo's native test suite: union members are
order-insensitive, object keys are sorted, and fields carrying compiler prose
that legitimately differs across the two TypeScript versions (diagnostic
message wording/positions; compatibility `reason`) are compared on their
load-bearing structure, exactly as `test/native-*.test.ts` do.

### Results — 28 comparisons

| command | case | source | classification |
| --- | --- | --- | --- |
| getPackages | packages | fixtures | identical |
| listSymbols | symbols | fixtures | identical |
| getTypeInfo | info:User | fixtures | identical |
| expandType | expand:User | fixtures | identical |
| findRelated | related:ExtendedUser | fixtures | **regression** |
| searchTypes | search:Role | fixtures | identical |
| evalType | eval:PickUser | fixtures | difference |
| evalType | eval:InternalConfig | fixtures | improvement |
| checkSnippet | check-snippet:invalid | fixtures | identical |
| checkSnippet | check-snippet:valid | fixtures | identical |
| getFileDeclarations | file:basic | fixtures | identical |
| checkCompatibility | compatible:ExtendedUser-User | fixtures | identical |
| getDiagnostics | diagnostics | fixtures | identical |
| getTypeAtPosition | at-position:basic | fixtures | identical |
| generateGraph | graph:ExtendedUser | fixtures | **regression** |
| previewRefactor | refactor:RefactorUser | fixtures | identical |
| explainError | why-error:2322 | fixtures | identical |
| explainType | explain:PickUser | fixtures | identical |
| transformSearch | transform-search:User-UserDTO | fixtures | identical |
| verifyContract | verify-contract:User-UserDTO | fixtures | identical |
| generateGraph | payload:graph.json | payloads | **regression** |
| getTypeInfo | payload:info-batch.json[0] | payloads | identical |
| getTypeInfo | payload:info-batch.json[1] | payloads | identical |
| getTypeInfo | payload:info.json | payloads | identical |
| transformSearch | payload:transform-search.json | payloads | identical |
| refresh | refresh | fixtures | unsupported |
| markDirty | markDirty | fixtures | unsupported |
| getDiagnostics(explain) | diagnostics:explain | fixtures | unsupported |

**Counts:** identical 20 · improvement 1 · difference 1 · regression 3 ·
unsupported 3 · total 28 → **`parityPassed = false`**.

### Regressions (block parity) — the native reference-graph family

All three regressions share one root cause: native resolves references with
different semantics than ts-morph. Both engines load the *same* project (every
other command is identical), so this is genuine engine behavior, not a loading
artifact. The repo's `test/native-references.test.ts` only asserts structural
invariants for these commands (root symbol / `root`+`format`+`depth`), so this
divergence was previously unpinned.

**`findRelated("ExtendedUser")` — native under-reports `referencedBy`.**

- ts-morph `referencedBy`: **7** entries — the `basic.ts` usage plus the
  cross-file type references `getUserWithAddress`, `createUserWithRole`,
  `addTimestamp`, `ExtendedUserBasics`, `UserWithoutEmail`,
  `CreateExtendedUserDTO`.
- native `referencedBy`: **1** entry — only the `basic.ts` usage. Native misses
  the six cross-file type-position references ts-morph correctly finds.
- native `references`: **6** vs ts-morph **3** — native additionally emits
  `usage`-context duplicates (`User`, `Date`, `Role`).

Native is measurably **less complete** on `referencedBy`, so this is a
regression, not a symmetric difference.

**`generateGraph("ExtendedUser", depth 2, mermaid)` — native emits a noisier
graph** (same in the direct case and the `payloads/graph.json` case).

- ts-morph nodes: `[ExtendedUser, Role, User]`; 2 edges (`extends`,
  `property "role"`).
- native nodes: `[ExtendedUser, Role, toUpperCase, User]`; 6 edges — it traverses
  into the string primitive member `toUpperCase` (because `Role` is a
  string-literal union) and adds `usage`-labeled edges that duplicate the
  `extends`/`property` edges. `toUpperCase` is noise for a type-dependency graph.

### Improvement (does not block)

**`evalType("InternalConfig")`** — native surfaces the semantic diagnostic as an
error where ts-morph returns the unresolved type text. This is a documented
native improvement (see `test/native-engine.test.ts:213-221`).

### Difference (does not block)

**`evalType('Pick<User, "id" | "name">')`** — native returns the alias in
`result` (`Pick<User, "id" | "name">`) and the resolved literal in `expanded`;
ts-morph resolves *both* fields. The evaluated type (`expanded`,
`{ id: string; name: string; }`) is **byte-identical** — only the `result` echo
differs. Load-bearing output preserved, so non-blocking.

### Unsupported (documented gaps, not regressions)

`refresh`, `markDirty`, and `getDiagnostics({ explain: true })` return
engine-not-supported (verified via the stable `engine-not-supported` cause
discriminant, not a message match). `refresh`/`markDirty` are cache-management
stubs; the diagnostics `explain` sub-mode is not yet ported. All three refuse
cleanly with an actionable message.

## Performance

`scripts/native-bench.ts`, target `test/fixtures`, **2 warm-up + 5 timed** runs
per command per engine, median milliseconds. `speedup = morph / native`
(> 1 means native is faster).

| command | ts-morph median (ms) | native median (ms) | speedup | ≥ 2× target |
| --- | --- | --- | --- | --- |
| diagnostics | 0.082 | 11.252 | 0.007× | no |
| expand | 0.398 | 11.669 | 0.034× | no |
| check-snippet | 90.788 | 16.747 | **5.42×** | **yes** |
| transform-search | 1.849 | 27.134 | 0.068× | no |

**Native under-delivers (< 2×) on 3 of the 4 commands, and by a wide margin.**
Stated plainly:

- **`check-snippet` is native's win (5.42×).** It is the compile-heavy command —
  materialize an in-memory file and type-check it fresh. `tsgo` type-checks
  faster than ts-morph's snippet evaluator, and the one-time RPC cost is
  amortized by the real compile work.
- **`diagnostics`, `expand`, `transform-search` are much slower on native**
  (morph is 15×–140× faster). These are cheap, cache-warm reads: after the
  project is loaded, ts-morph answers in-process in microseconds-to-low-ms,
  while every native call pays a `tsgo` RPC round-trip (~11–27 ms floor here).
  On this tiny fixture the per-call RPC overhead dwarfs the query.
- **Variance:** native medians carry RPC/GC jitter (e.g. `transform-search`
  ranged ~27–54 ms across runs); the qualitative picture — native wins only on
  compile-heavy work, loses on cheap warm reads — is stable. On a large project
  the balance would shift toward native as real type-checking cost grows to
  dominate the fixed RPC overhead; this fixture deliberately isolates per-call
  behavior and is not that regime.

## Reproduce

The native engine needs Node + an unbundled `typescript/unstable` client, which
the repo's Vitest/Vite host provides. A gated runner drives both scripts (skipped
in the normal suite):

```sh
QUARTZ_P6=1 ./node_modules/.bin/vitest run \
  test/native-parity-bench.run.test.ts --disable-console-intercept
```

It prints the full `runParity` and `runBench` JSON reports (`PARITY_JSON_*` /
`BENCH_JSON_*` markers) that back the tables above. The scripts also export
`runParity(root)` / `runBench(root)` for any compatible Node host.
