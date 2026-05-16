# Architecture Fitness Checks

Quartz keeps its architecture obligations executable. Agents should treat these
checks as the source of truth before trusting broad changes.

## Fitness Suite

| Check | Command | Protects |
| --- | --- | --- |
| Effect rewrite structure | `bun run verify:effect-rewrite` | Core code does not regain `Effect.runPromise`; old analyzer/project-manager paths stay deleted; runtime ownership remains at CLI and plugin edges. |
| Package boundaries | `bun run verify:package-boundaries` | Published package export maps, packed files, README/LICENSE presence, and CLI/plugin build boundaries stay coherent. |
| Docs examples | `bun run verify:docs-examples` | Public command examples, schemas, input modes, artifact output, batch semantics, transform verification metadata, and `verify-contract` output stay executable. |
| Regression guard | `bun run verify:regression-guard` | The main agent-facing guard composes effect-structure, docs-example, CLI/plugin, refactor, diagnostics, explanation, transform-search, and property-style invariant coverage. |
| External feature matrix | `bun run verify:external-matrix` | Quartz commands keep working on representative external TypeScript repositories, with failures classified as Quartz bugs, repo preconditions, timeouts, or matrix harness issues. |

## When To Run

Use the smallest check that covers the risk:

- CLI schema, examples, artifacts, or public docs: `bun run verify:docs-examples`
- Core/service-spine/runtime ownership: `bun run verify:effect-rewrite`
- Package exports or publish shape: `bun run verify:package-boundaries`
- Agent-facing behavior across the main workflows: `bun run verify:regression-guard`
- Cross-repository behavior: `bun run verify:external-matrix`

Run `bun run typecheck` before review for any TypeScript change.
Run `bun run verify:regression-guard` before promoting a glyph that changes
core, CLI, plugin, docs examples, refactors, diagnostics, or transform search.

## Discoverability

`quartz doctor '{"root":"test/fixtures"}'` reports the same fitness check
inventory under `fitness_checks`. This lets agents discover what to run without
reading this document first.
