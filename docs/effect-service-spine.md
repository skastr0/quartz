# Effect Service Spine

This is the canonical direction for the full Effect rewrite.

## Service Graph

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
- `TypeAnalyzerService`

New internal services should use `Effect.Service` by default. Use `Context.Tag` plus explicit `Layer` definitions only when a stable exported contract or separate implementation file is clearer.

## Runtime Ownership

`createTypeAnalyzerRuntime(root)` creates one `ManagedRuntime.make(CoreLayer(root))` for a root. CLI and plugin code cache that runtime per lifecycle/root instead of repeatedly providing an app layer.

## Deletion Ledger

- `ProjectManager` dies in QZ-007.
- `fromProjectPromise` dies in QZ-007.
- `discoverPackagesPromise`, `findTsconfigsPromise`, and `walkForTsconfigsPromise` die in QZ-003.
- Direct `new` service wiring dies across QZ-003 through QZ-006 as each domain moves into Layer-owned services.
- Promise-shaped core analyzer methods die before QZ-008 can pass review.

## Non-Goals

- No compatibility layer is a permitted end state.
- No old analyzer path survives the full rewrite.
- No repeated `Effect.provide(AppLayer)` calls should be introduced.
