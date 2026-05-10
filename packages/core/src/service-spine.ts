import { resolve } from "node:path"
import { Context, Effect, Layer, ManagedRuntime } from "effect"
import { createTypeAnalyzer as createLegacyTypeAnalyzer, type TypeAnalyzer } from "./analyzer"
import { discoverPackages, type PackageInfo } from "./discovery"
import { QuartzError } from "./errors"
import { ProjectWorkspace as ProjectWorkspaceImplementation } from "./project-workspace"

export class AnalyzerConfig extends Context.Tag("@skastr0/quartz/AnalyzerConfig")<
  AnalyzerConfig,
  {
    readonly rootDirectory: string
  }
>() {
  static readonly layer = (rootDirectory: string) =>
    Layer.succeed(this, {
      rootDirectory: resolve(rootDirectory),
    })
}

export class PackageDiscovery extends Effect.Service<PackageDiscovery>()("@skastr0/quartz/PackageDiscovery", {
  accessors: true,
  effect: Effect.gen(function* () {
    const config = yield* AnalyzerConfig
    return {
      discover: () => discoverPackages(config.rootDirectory),
    }
  }),
}) {}

export class ProjectWorkspace extends Effect.Service<ProjectWorkspace>()("@skastr0/quartz/ProjectWorkspace", {
  accessors: true,
  effect: Effect.gen(function* () {
    const config = yield* AnalyzerConfig
    const workspace = new ProjectWorkspaceImplementation(config.rootDirectory)
    return {
      workspace,
      getPackages: (): Effect.Effect<readonly PackageInfo[], QuartzError> =>
        Effect.tryPromise({
          try: () => workspace.getPackages(),
          catch: (cause) =>
            new QuartzError({
              message: cause instanceof Error ? cause.message : "Could not read workspace packages",
              cause,
            }),
        }),
    }
  }),
}) {}

export class SourceProjectCache extends Effect.Service<SourceProjectCache>()("@skastr0/quartz/SourceProjectCache", {
  accessors: true,
  effect: Effect.gen(function* () {
    const workspace = yield* ProjectWorkspace
    return {
      markDirty: () => Effect.sync(() => workspace.workspace.markDirty()),
      refreshAll: () => Effect.sync(() => workspace.workspace.refreshAll()),
    }
  }),
}) {}

export class SymbolLookup extends Context.Tag("@skastr0/quartz/SymbolLookup")<
  SymbolLookup,
  {
    readonly _service: "SymbolLookup"
  }
>() {}

export class FileInspection extends Context.Tag("@skastr0/quartz/FileInspection")<
  FileInspection,
  {
    readonly _service: "FileInspection"
  }
>() {}

export class SnippetEvaluation extends Context.Tag("@skastr0/quartz/SnippetEvaluation")<
  SnippetEvaluation,
  {
    readonly _service: "SnippetEvaluation"
  }
>() {}

export class TypeRelations extends Context.Tag("@skastr0/quartz/TypeRelations")<
  TypeRelations,
  {
    readonly _service: "TypeRelations"
  }
>() {}

export class TypeExplainer extends Context.Tag("@skastr0/quartz/TypeExplainer")<
  TypeExplainer,
  {
    readonly _service: "TypeExplainer"
  }
>() {}

export class Diagnostics extends Context.Tag("@skastr0/quartz/Diagnostics")<
  Diagnostics,
  {
    readonly _service: "Diagnostics"
  }
>() {}

export class RefactorPreview extends Context.Tag("@skastr0/quartz/RefactorPreview")<
  RefactorPreview,
  {
    readonly _service: "RefactorPreview"
  }
>() {}

export class TypeGraph extends Context.Tag("@skastr0/quartz/TypeGraph")<
  TypeGraph,
  {
    readonly _service: "TypeGraph"
  }
>() {}

export class TransformSearch extends Context.Tag("@skastr0/quartz/TransformSearch")<
  TransformSearch,
  {
    readonly _service: "TransformSearch"
  }
>() {}

export class TypeAnalyzerService extends Effect.Service<TypeAnalyzerService>()("@skastr0/quartz/TypeAnalyzer", {
  accessors: true,
  effect: Effect.gen(function* () {
    const config = yield* AnalyzerConfig
    const analyzer = createLegacyTypeAnalyzer(config.rootDirectory)
    return analyzer
  }),
}) {}

export type CoreServices =
  | AnalyzerConfig
  | PackageDiscovery
  | ProjectWorkspace
  | SourceProjectCache
  | TypeAnalyzerService

export const CoreLayer = (rootDirectory: string): Layer.Layer<CoreServices> => {
  const configLayer = AnalyzerConfig.layer(rootDirectory)
  const workspaceLayer = ProjectWorkspace.Default.pipe(Layer.provide(configLayer))
  return Layer.mergeAll(
    configLayer,
    PackageDiscovery.Default.pipe(Layer.provide(configLayer)),
    workspaceLayer,
    SourceProjectCache.Default.pipe(Layer.provide(workspaceLayer)),
    TypeAnalyzerService.Default.pipe(Layer.provide(configLayer)),
  )
}

export const AppLayer = CoreLayer

export interface TypeAnalyzerRuntime {
  readonly analyzer: TypeAnalyzer
  readonly runtime: ManagedRuntime.ManagedRuntime<CoreServices, never>
  readonly dispose: () => Promise<void>
}

export const createTypeAnalyzerRuntime = (rootDirectory: string): TypeAnalyzerRuntime => {
  const runtime = ManagedRuntime.make(CoreLayer(rootDirectory))
  return {
    analyzer: createLegacyTypeAnalyzer(rootDirectory),
    runtime,
    dispose: runtime.dispose,
  }
}

export const effectRewriteDeletionLedger = [
  {
    symbol: "ProjectManager",
    ownerGlyph: "QZ-007",
    reason: "Old object coordinator. Domain services replace it and then delete it.",
  },
  {
    symbol: "fromProjectPromise",
    ownerGlyph: "QZ-007",
    reason: "Promise bridge kept only until all analyzer operations are service-native.",
  },
  {
    symbol: "discoverPackagesPromise/findTsconfigsPromise/walkForTsconfigsPromise",
    ownerGlyph: "QZ-003",
    reason: "Package discovery becomes Effect-native only.",
  },
  {
    symbol: "direct new service wiring",
    ownerGlyph: "QZ-003..QZ-006",
    reason: "Direct construction moves into Layer-owned service implementations.",
  },
] as const
