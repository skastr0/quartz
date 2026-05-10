# Full Idiomatic Effect Rewrite Glyphs

Status: Tower creation pending. `orbit_create_glyph` timed out on 2026-05-10 with "Unable to connect"; sync these glyphs to Tower project `quartz` / orbit `forge` when the service is reachable.

## Current Diagnosis

The codebase is Effect-compatible, not fully Effect-native.

- `Effect.runPromise` is restricted to CLI/plugin/test edges, which is good.
- Core still uses `ProjectManager` as an object-oriented coordinator.
- Core services are instantiated with `new`, not `Context.Tag`, `Effect.Service`, or `Layer`.
- `analyzer.ts` still bridges Promise APIs into Effect with `Effect.tryPromise`.
- There is no `ManagedRuntime.make(AppLayer)` at executable/plugin edges.

The real rewrite is complete only when core is built as a Layer-composed service graph and runtime ownership lives at executable boundaries.

## Rewrite Invariants

- Core modules expose service methods returning `Effect.Effect<A, QuartzError | DomainError>`.
- Service method signatures should have `R = never`; dependencies are acquired when constructing the service layer.
- Use `Effect.Service` for new service definitions unless separate contract/implementation files are clearer.
- Use `Layer` for runtime composition and test substitution.
- Use one `ManagedRuntime.make(AppLayer)` per executable/plugin runtime boundary.
- Do not call `Effect.provide(AppLayer)` repeatedly.
- Do not use `Effect.runPromise` in `packages/core/src`.
- Do not hide recoverable failures in thrown exceptions; model them with typed errors.
- Keep pure ts-morph algorithms as plain functions when no dependency injection or runtime behavior is needed.

## QZ-002 - Effect Architecture And Service Contract Spine

Desired Tower state: `committed`.

Create the service graph and runtime shape before migrating behavior.

Acceptance criteria:

- Define the canonical service graph using `Context.Tag` or `Effect.Service`:
  - `AnalyzerConfig`
  - `PackageDiscovery`
  - `ProjectWorkspace`
  - `SourceProjectCache`
  - `SymbolLookup`
  - `FileInspection`
  - `SnippetEvaluation`
  - `TypeRelations`
  - `TypeExplainer`
  - `Diagnostics`
  - `RefactorPreview`
  - `TypeGraph`
  - `TransformSearch`
  - `TypeAnalyzer`
- Add `CoreLayer` / `AppLayer` composition modules.
- Add test layer scaffolding for at least config, discovery, and workspace/cache.
- Keep current `createTypeAnalyzer(root)` public API working through a compatibility adapter.
- Document the service dependency graph so later glyphs cannot create parallel wiring.
- Validation passes:
  - `bun run typecheck`
  - `bun run test`
  - `bun run verify:package-boundaries`

Not done until:

- `rg -n "Context\\.Tag|Effect\\.Service|Layer\\." packages/core/src` returns meaningful service definitions.
- `rg -n "ManagedRuntime\\.make" apps packages` shows planned runtime ownership, even if later glyphs wire it fully.

## QZ-003 - Package Discovery And Workspace Cache Layers

Desired Tower state: `backlog`.

Migrate discovery, package resolution, project cache, and refresh/dirty behavior into Effect services.

Acceptance criteria:

- `PackageDiscovery` exposes Effect-native discovery and tsconfig walking.
- `ProjectWorkspace` becomes an Effect service, not a directly constructed mutable class.
- `SourceProjectCache` owns ts-morph `Project` lifecycle and cache invalidation with explicit state, likely `Ref`.
- `refresh`, `markDirty`, package resolution, and source-file access are service methods.
- Filesystem/subprocess failures are typed, not generic thrown errors.
- Existing analyzer behavior remains compatible.
- Validation passes:
  - `bun run test`
  - `bun run verify`

Not done until:

- `packages/core/src/project-workspace.ts` no longer exports an OO cache coordinator as the primary runtime abstraction.
- `packages/core/src/discovery.ts` has Effect-native APIs as primary and Promise APIs only as compatibility shims if still necessary.

## QZ-004 - Symbol, File, And Snippet Services

Desired Tower state: `backlog`.

Move symbol lookup, file inspection, type-at-position, eval-type, and snippet checking behind Effect services.

Acceptance criteria:

- `SymbolLookup` is a Layer-backed service with `Effect.fn` methods.
- `FileInspection` is a service or pure module consumed by a service, depending on dependency needs.
- `SnippetEvaluation` is Effect-native and uses typed errors for temporary source-file failures.
- `getTypeInfo`, `expandType`, `getTypeAtPosition`, `getFileDeclarations`, `evalType`, and `checkSnippet` are implemented through service composition.
- Tests cover at least one test-layer substitution for symbol/workspace behavior.
- Validation passes:
  - `bun run test test/core.test.ts`
  - `bun run verify`

Not done until:

- These behaviors no longer route through `ProjectManager` Promise methods.
- `rg -n "new SymbolLookup|new SnippetEvaluator" packages/core/src` is empty or only appears in layer construction.

## QZ-005 - Diagnostics, Explanations, Graph, And Refactor Services

Desired Tower state: `backlog`.

Migrate the higher-level analysis domains onto services after lookup/workspace are Layer-native.

Acceptance criteria:

- `Diagnostics` service owns package diagnostics and explained diagnostics.
- `TypeExplainer` service depends on diagnostics, compatibility, symbol lookup, and eval-type via service contracts.
- `TypeRelations`, `TypeGraph`, and `RefactorPreview` are service-backed where they need dependencies and pure where they do not.
- Compatibility checking is Effect-native with structured issue data.
- Existing diagnostics, graph, related-symbol, explanation, and refactor tests pass.
- Validation passes:
  - `bun run test test/refactor-coverage.test.ts`
  - `bun run verify`

Not done until:

- `packages/core/src/type-explanations.ts` has no Promise-shaped context callbacks.
- Graph/refactor/explanation code can be tested with service test layers rather than a full `ProjectManager`.

## QZ-006 - Transform Search As An Effect Service

Desired Tower state: `backlog`.

Move transform search orchestration, index construction, and search execution into the service graph while keeping pure ranking/token logic plain.

Acceptance criteria:

- `TransformSearch` is an Effect service.
- Search engine lifecycle and any index/cache state are explicit.
- Cancellation and typed failures flow through Effect.
- Pure tokenization, ranking, query parsing, and assignability helpers remain plain functions unless they need dependencies.
- CLI/plugin transform search behavior is unchanged.
- Validation passes:
  - transform search tests
  - `bun run verify`

Not done until:

- `new TransformSearchEngine` is not created inside `analyzer.ts`.
- Transform search is reachable through the Layer-composed analyzer service.

## QZ-007 - Runtime Edges And Compatibility Adapter Removal

Desired Tower state: `backlog`.

Replace the Promise bridge and object coordinator with Layer-composed runtime ownership.

Acceptance criteria:

- CLI owns a single `ManagedRuntime.make(CliLayer)` or equivalent runtime module.
- OpenCode plugin owns a single runtime per plugin server/context lifecycle.
- `createTypeAnalyzer(root)` either returns a Layer-backed analyzer adapter or is replaced by a new explicit API with backwards compatibility documented.
- `ProjectManager` is removed or reduced to a deprecated compatibility facade with no unique logic.
- `fromProjectPromise` is removed.
- Core internals no longer expose Promise APIs except deliberate interop boundaries documented in code.
- Validation passes:
  - `bun run release:check`

Not done until:

- `rg -n "class ProjectManager|new ProjectManager|fromProjectPromise" packages/core/src apps test` is empty, or remaining matches are explicitly deprecated test/compatibility adapters with no domain logic.
- `rg -n "Effect\\.runPromise" packages/core/src` is empty.
- `rg -n "ManagedRuntime\\.make" apps packages` shows runtime ownership at executable/plugin edges.

## QZ-008 - Effect-Native Review And Cleanup Gate

Desired Tower state: `backlog`.

Final review glyph. This exists to prevent another premature completion claim.

Acceptance criteria:

- Run `bun run release:check`.
- Run code searches proving:
  - no core `Effect.runPromise`
  - no unplanned `Effect.provide(AppLayer)` repetition
  - Layer/service definitions exist for every dependencyful domain
  - no `ProjectManager` domain logic remains
- Dispatch at least these reviewers:
  - contract reviewer
  - simplicity reviewer
  - verification reviewer
  - performance reviewer
  - security reviewer
- Each reviewer returns pass or all blockers are fixed in follow-up commits.
- Update Tower review findings and self-assessment.

Not done until:

- Reviewers explicitly assess the codebase as idiomatic Effect/Layers-native.
- The final answer says "full idiomatic Effect rework complete" only if every criterion above is true.

## Execution Order

1. QZ-002: Service contract spine.
2. QZ-003: Workspace/cache/discovery Layers.
3. QZ-004: Symbol/file/snippet services.
4. QZ-005: Diagnostics/explanations/graph/refactor services.
5. QZ-006: Transform search service.
6. QZ-007: Runtime edges and ProjectManager removal.
7. QZ-008: Review and cleanup gate.

## First Build Target

Start with QZ-002. It should be small enough to land without moving all behavior, but strong enough to make every later migration compile against the final service graph.
