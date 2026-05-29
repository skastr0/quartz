# Goal: Type-Driven Verification Upgrades For Quartz

## Objective

Turn the type-driven-verification research in
`/Users/guilhermecastro/Projects/research-knowledge-base` into direct Quartz
upgrades that make Quartz a stronger agent-facing verification system, not only
a TypeScript inspection toolkit.

Quartz should help agents answer:

- What is the checked contract surface?
- Which result is compiler-verified, merely assignability-based, or unverifiable?
- What evidence supports this result?
- What should be checked next before an edit or refactor is trusted?

## Current Workspace Note

An implementation attempt was interrupted after a few transform-search files were
modified. Treat those changes as draft work and review them before continuing.
The goal artifact is the source of truth for the next implementation pass.

## Research Basis

The strongest local knowledge-base themes that matter for Quartz:

- Compiler/typechecker/static-analysis feedback loops are more useful than vague
  "type safety" claims when exposed as machine-readable agent feedback.
  Source: `wiki/type-driven-verification/compiler-typechecker-static-analysis-feedback.md`

- AI-generated code quality improves when external verifiers provide concrete
  repair signals.
  Source: `wiki/type-driven-verification/ai-code-generation-constraint-verifier-feedback.md`

- Parse-don't-validate means weak user input should be constructed into stronger
  domain values at boundaries.
  Source: `wiki/type-driven-verification/parse-dont-validate-boundary-construction.md`

- TypeScript needs explicit runtime/schema/effect boundaries because compiler
  safety, parser safety, and effect safety are separate claims.
  Source: `wiki/type-driven-verification/schema-driven-typescript-effect-runtime-boundaries.md`

- Effect/functional architecture makes requirements, errors, dependencies, and
  ports visible.
  Source: `wiki/type-driven-verification/effects-functional-architecture-ports.md`

- Agent-readable architecture works best through executable fitness functions,
  not prose-only conventions.
  Source: `wiki/type-driven-verification/agent-readable-architecture-fitness-functions.md`

- Property-based tests are executable specifications below formal proof.
  Source: `wiki/type-driven-verification/property-based-testing-executable-specifications.md`

- Stronger verification methods have adoption costs; prefer low-friction
  schemas, checks, contracts, PBT, and fitness functions before proof assistants
  or model checkers.
  Source: `wiki/type-driven-verification/economics-adoption-human-factors-constraint-systems.md`

## Quartz Baseline

Quartz already has the right substrate:

- Agent-native CLI protocol with schemas, examples, batch handling, artifacts,
  and stable envelopes.
- Reusable core analyzer around ts-morph and TypeScript compiler feedback.
- OpenCode plugin surface over the same analyzer.
- Transform search pipeline:
  callable enumeration -> index selection -> signature resolution ->
  assignability filtering -> synthetic call-site verification -> ranking.
- Existing verification scripts:
  `verify-doc-examples`, `verify-regression-guard`,
  `verify-package-boundaries`, and `verify-effect-rewrite`.

Main gap:

Quartz has strong primitives, but not yet a first-class evidence workflow that
says: "for this proposed change or transform, here is the checked surface, trust
level, evidence, gaps, and next checks."

## Non-Goals

- Do not claim Quartz makes TypeScript sound.
- Do not claim typed languages make AI-generated code correct.
- Do not add proof assistants, model checkers, Dafny, Lean, or TLA+ as default
  machinery.
- Do not treat property-based tests as proof.
- Do not build broad abstractions unless they reduce raw-string boundary leakage
  or improve machine-readable verification evidence.

## Plan

### Phase 1: Make Transform Verification Evidence First-Class

Goal:
Expose the evidence Quartz already computes in transform search so agents can
filter and act on trust levels.

Work:

- Add stable public transform-search verification types:
  `VerificationStatus`, `VerificationReason`, `VerificationMeta`,
  `TransformSearchResult`, `TransformSearchResponse`.
- Ensure every transform-search result includes:
  `verification.status`, `verification.method`, `verification.reason`.
- Add optional evidence fields:
  `includeDiagnostics`
  `includeSyntheticCode`
  `includeFailedVerification`
- Add trust filters:
  `verifiedOnly`
  `minVerificationStatus`
- Update CLI schema for `transform-search`.
- Update OpenCode plugin tool args for `type_transform_search`.
- Update README docs with the trust ladder:
  `verified > unverified > unverifiable`.
- Add regression tests for:
  verified synthetic pass
  partial-query unverified result
  failed synthetic check surfaced only when requested
  verified-only filtering

Acceptance:

- `quartz transform-search '{"root":"test/fixtures","from":"User","to":"UserDTO"}'`
  returns result verification metadata.
- `verifiedOnly: true` returns only `verification.status === "verified"`.
- Failed synthetic diagnostics remain hidden by default but appear when
  `includeFailedVerification` and `includeDiagnostics` are true.
- Plugin output preserves the same fields.
- Existing callers still receive valid JSON and the normal default result set.

Likely files:

- `packages/core/src/transform-search/types.ts`
- `packages/core/src/transform-search/search-engine.ts`
- `packages/core/src/transform-search/ranking.ts`
- `packages/core/src/transform-search/index.ts`
- `packages/core/src/index.ts`
- `apps/cli/src/main.ts`
- `apps/opencode-plugin/src/server.ts`
- `README.md`
- `test/refactor-coverage.test.ts`
- `test/core.test.ts`
- `test/opencode-plugin.test.ts`
- `scripts/verify-doc-examples.ts`

### Phase 2: Add A Composed Verification Command

Goal:
Create an agent-facing command that composes existing Quartz primitives into one
evidence packet for a proposed type-level claim.

Candidate command:

- CLI: `verify-contract`
- Plugin: `type_verify_contract`

Payload shape:

```json
{
  "root": "test/fixtures",
  "from": "User",
  "to": "UserDTO",
  "symbol": "toDTO",
  "snippet": "const dto: UserDTO = toDTO(user);",
  "package": "(root)"
}
```

Composed checks:

- `compatible(from, to)` when both are provided.
- `check-snippet(snippet)` when provided.
- `diagnostics` for the package.
- `transform-search(from, to, verifiedOnly: true)` when both are provided.
- Optional `explain` or `why-error` suggestions when checks fail.

Output shape:

- `ok`
- `contract`
- `checks`
- `evidence`
- `gaps`
- `next_steps`

Acceptance:

- One command gives an agent enough information to decide whether a proposed
  conversion/contract is compiler-backed, assignability-only, or blocked.
- The command is mostly orchestration over existing services, not new analysis.

Likely files:

- `packages/core/src/analyzer.ts`
- `packages/core/src/service-spine.ts`
- `packages/core/src/project-types.ts`
- `apps/cli/src/main.ts`
- `apps/opencode-plugin/src/server.ts`
- tests and README command table

### Phase 3: Strengthen Boundary Construction

Goal:
Reduce raw-string leakage across command and core boundaries.

Work:

- Introduce small parsed domain refs where they reduce ambiguity:
  `ProjectRoot`, `PackageRef`, `SymbolRef`, `FileRef`, `TypeExpression`,
  `SourcePosition`.
- Keep CLI Effect Schema as the first parse boundary.
- Avoid invasive refactors at first; start with exported/shared types and
  helper constructors used by new commands.

Acceptance:

- New command surfaces do not pass anonymous raw strings deep into core logic
  when a parsed value carries stronger meaning.
- Existing command behavior stays compatible.

Likely files:

- `apps/cli/src/main.ts`
- `packages/core/src/project-types.ts`
- `packages/core/src/analyzer.ts`

### Phase 4: Architecture Fitness Suite

Goal:
Promote current verification scripts into explicit agent-readable fitness
checks.

Work:

- Add `docs/architecture-fitness.md`.
- Extend or document the existing fitness checks:
  package boundaries
  service-spine ownership
  no accidental runtime creation in core
  docs examples freshness
  regression guard coverage
- Optionally add `quartz doctor` output that reports local fitness check names
  and how to run them.

Acceptance:

- Agents can discover the repo's architectural obligations without reading all
  scripts.
- Fitness checks remain executable through existing scripts.

Likely files:

- `docs/architecture-fitness.md`
- `README.md`
- `scripts/verify-regression-guard.ts`
- `scripts/verify-package-boundaries.ts`
- `apps/cli/src/main.ts`

### Phase 5: Property-Based Regression Coverage

Goal:
Use PBT where it gives durable signal on protocol and verification invariants.

Candidate properties:

- Batch responses preserve input order.
- CLI schema examples round-trip through `schema show` and command execution.
- Transform-search trust filters never return a result below the requested
  status.
- `includeFailedVerification: false` excludes failed synthetic checks.
- `includeFailedVerification: true` exposes failed evidence without marking it
  verified.
- Refactor preview never reports file edits outside discovered project files.
- Artifact output writes valid JSON and reports a real path.

Acceptance:

- Add focused properties only where fixtures can stay fast and deterministic.
- PBT supplements existing examples; it does not replace direct regression tests.

Likely files:

- `test/cli.test.ts`
- `test/refactor-coverage.test.ts`
- `test/core.test.ts`
- possibly `package.json` if adding a PBT dependency

## Recommended Execution Order

1. Review the interrupted transform-search draft edits and either keep, repair,
   or revert only the draft lines.
2. Finish Phase 1.
3. Run focused tests:
   `bun test test/refactor-coverage.test.ts test/core.test.ts test/opencode-plugin.test.ts`
4. Run CLI docs smoke:
   `bun run verify:docs-examples`
5. Update README trust-ladder docs.
6. Run broader verification:
   `bun run typecheck`
   `bun run verify:regression-guard`
7. Implement Phase 2 as a separate slice.
8. Defer Phases 3-5 until Phase 1 and Phase 2 are stable.

## Final Acceptance Criteria

- Quartz outputs make verification status explicit enough for agents to use as a
  control signal.
- The public CLI/plugin docs explain the difference between verified,
  unverified, and unverifiable results.
- At least one composed verification workflow exists or is specified with clear
  acceptance criteria.
- Regression tests protect the transform-search trust ladder.
- The implementation stays conservative: no heavy formal-methods dependency, no
  broad redesign, no unsupported soundness claims.
