# Effect Service Spine

Quartz core is owned by one Layer-composed service graph. Executable and plugin edges create a runtime for that graph; core internals stay inside `Effect`.

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

Internal services use `Effect.Service` by default. Stable exported contracts may use explicit `Context.Tag` and `Layer` definitions when that keeps the boundary clearer.

## Runtime Ownership

`CoreLayer(root)` is the canonical composition root for analyzer behavior. The CLI and OpenCode plugin each create `ManagedRuntime.make(CoreLayer(root))` at their lifecycle boundary, reuse that runtime for analyzer operations, and dispose it when the boundary closes.

Core code does not create runtimes and does not repeatedly provide the app layer. Public analyzer behavior is reached by running `TypeAnalyzerService` effects through the edge-owned runtime.

## Cache And Mutation Ownership

`SourceProjectCache` owns the mutable ts-morph project instances. Public analyzer methods serialize access through the cache semaphore before reading or mutating cached projects, including snippet evaluation and transform search.

`PackageDiscovery` owns package enumeration. `ProjectWorkspace` keeps the current discovered package set, invalidates it on dirty/refresh operations, and repopulates through the discovery service.

`TransformSearch` caches engines with the project object they were built from and recreates the engine when the project cache returns a different project instance.

## Consolidation State

The former object coordinator, Promise bridge helpers, and parallel analyzer construction path have been deleted. The remaining accepted path is the Layer service graph plus executable/plugin runtime ownership.
