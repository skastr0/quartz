# Full Idiomatic Effect Rewrite Glyphs

Status: Tower Control is canonical for project `quartz` / orbit `forge`.

- QZ-002 through QZ-007 are in `reviewing`.
- QZ-008 is the active final review and cleanup gate.
- QZ-009 holds migrated TLT triage outside the Effect rewrite completion gate.

## Current Architecture

Quartz core is now organized around a Layer-composed Effect service graph. Runtime ownership lives at executable and plugin boundaries; core internals expose Effect-returning services and no longer keep a parallel analyzer construction path.

The current completion gate is not "rewrite code until it looks different." It is evidence-based:

- `release:check` must pass.
- The automated Effect rewrite verification must pass.
- Independent reviewers must pass or every blocker must be fixed in follow-up commits.
- QZ-002 through QZ-008 stay out of `done` until QZ-008 clears.

## Rewrite Invariants

- One canonical implementation path: Layer-composed Effect services.
- No compatibility path for internal analyzer construction.
- No retired coordinator shell.
- No duplicate Promise API for core analyzer behavior.
- Service methods return `Effect.Effect<A, QuartzError | DomainError>`.
- Service method signatures should keep `R = never`; dependencies are acquired when constructing the service layer.
- Use `Effect.Service` for new service definitions unless an explicit contract/implementation split is clearer.
- Use `Layer` for runtime composition and test substitution.
- Use one edge-owned `ManagedRuntime.make(CoreLayer(root))` per executable/plugin lifecycle.
- Do not call `Effect.runPromise` in `packages/core/src`.
- Do not repeatedly provide the app layer inside core or app operation methods.
- Model recoverable failures with typed errors.
- Keep pure ts-morph algorithms as plain functions when no runtime dependency is needed.

## Tower Split

### QZ-002 - Effect Architecture And Service Contract Spine

Defines the service graph, composition root, runtime boundary shape, and documentation spine.

### QZ-003 - Package Discovery And Workspace Cache Layers

Moves discovery, package resolution, project cache, refresh, and dirty behavior into Effect services with invalidation and typed failure surfacing.

### QZ-004 - Symbol, File, And Snippet Services

Routes lookup, file inspection, type-at-position, type evaluation, and snippet checking through Layer-owned services.

### QZ-005 - Diagnostics, Explanations, Graph, And Refactor Services

Routes diagnostics, explanations, assignability, graph generation, and refactor preview through the service graph.

### QZ-006 - Transform Search As An Effect Service

Owns transform search lifecycle and engine caching inside the service graph while keeping pure ranking/token logic as plain functions.

### QZ-007 - Runtime Edges And Old Path Deletion

Deletes the previous analyzer construction path and moves runtime creation to CLI/plugin lifecycle boundaries.

### QZ-008 - Effect Native Review And Cleanup Gate

Runs final validation, proof searches, documentation cleanup, and independent review. This is the only glyph allowed to declare the full rewrite complete.

## QZ-008 Review Blockers Fixed In Commit `9c2b53a`

The first review pass found blockers that were fixed before QZ-008 moved back to review:

- Shared mutable ts-morph project access is serialized at public analyzer entrypoints.
- Transform search engine caching is bound to project identity.
- Package discovery cache invalidates on dirty/refresh operations.
- Discovery filesystem failures surface as typed Quartz errors.
- Type search resolves duplicate names by file-qualified identity.
- Documentation describes the current architecture rather than the migration plan.
- `release:check` includes an automated Effect rewrite proof gate.

## QZ-008 Review Blockers Fixed After Final Dispatch

- The exported app-layer alias was removed so `CoreLayer(root)` remains the only named composition root.
- The Effect rewrite verifier now fails on any remaining app-layer alias reference in core, apps, tests, scripts, or README.

## Completion Rule

The final answer may say the full idiomatic Effect rewrite is complete only after:

- QZ-008 validation passes.
- Reviewer blockers are fixed and re-reviewed.
- Tower notes record the final review evidence.
- QZ-002 through QZ-008 are transitioned to `done`.
