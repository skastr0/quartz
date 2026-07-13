# Architecture Fitness Checks

Quartz keeps its architecture obligations executable. Agents should treat these
checks as the source of truth before trusting broad changes.

## Fitness Suite

| Check | Command | Protects |
| --- | --- | --- |
| Native engine structure | `bun run verify:native-engine` | The persistent compiler-native engine remains the only analysis implementation; legacy core, ts-morph, fallback switches, and engine-selection fields stay deleted. |
| Package boundaries | `bun run verify:package-boundaries` | Published package export maps, packed files, README/LICENSE presence, native TypeScript platform dependencies, and CLI/plugin build boundaries stay coherent. |
| Docs examples | `bun run verify:docs-examples` | Public command examples, schemas, input modes, artifact output, batch semantics, transform verification metadata, and `verify-contract` output stay executable. |
| Regression guard | `bun run verify:regression-guard` | The main agent-facing guard composes native-engine, docs-example, CLI/plugin, refactor, diagnostics, explanation, transform-search, and property-style invariant coverage. |

## When To Run

Use the smallest check that covers the risk:

- CLI schema, examples, artifacts, or public docs: `bun run verify:docs-examples`
- Engine lifecycle, native-analysis ownership, and deleted legacy paths: `bun run verify:native-engine`
- Package exports or publish shape: `bun run verify:package-boundaries`
- Agent-facing behavior across the main workflows: `bun run verify:regression-guard`

Run `bun run typecheck` before review for any TypeScript change.
Run `bun run verify:regression-guard` before promoting a glyph that changes
the engine, CLI, plugin, docs examples, refactors, diagnostics, or transform search.

## Discoverability

`quartz doctor '{"root":"test/fixtures"}'` reports the same fitness check
inventory under `fitness_checks`. This lets agents discover what to run without
reading this document first.
