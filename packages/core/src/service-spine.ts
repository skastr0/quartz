import { resolve } from "node:path"
import type { Project, SourceFile } from "ts-morph"
import { Context, Effect, Layer, ManagedRuntime, Ref } from "effect"
import { createTypeAnalyzerWithWorkspace, type TypeAnalyzer } from "./analyzer"
import { discoverPackages, type PackageInfo } from "./discovery"
import { QuartzError } from "./errors"
import {
  createProjectWorkspaceState,
  getCachedProject,
  getWorkspacePackages,
  getWorkspaceSourceFiles,
  markWorkspaceDirty,
  refreshAllProjects,
  refreshPackageProject,
  resolveWorkspacePackage,
  type ProjectWorkspaceState,
  workspaceRelativePath,
} from "./project-workspace"

const toQuartzError = (message: string) => (cause: unknown) =>
  new QuartzError({
    message: cause instanceof Error ? cause.message : message,
    cause,
  })

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
    const state = yield* Ref.make(createProjectWorkspaceState(config.rootDirectory))
    const withState = <A>(f: (workspace: ProjectWorkspaceState) => A, message: string): Effect.Effect<A, QuartzError> =>
      Ref.get(state).pipe(
        Effect.flatMap((workspace) =>
          Effect.try({
            try: () => f(workspace),
            catch: toQuartzError(message),
          }),
        ),
      )

    return {
      state,
      rootDirectory: config.rootDirectory,
      getPackages: () => withState(getWorkspacePackages, "Could not read workspace packages"),
      resolvePackage: (packageName?: string) =>
        withState((workspace) => resolveWorkspacePackage(workspace, packageName), "Could not resolve package"),
      relativePath: (absolutePath: string) =>
        withState((workspace) => workspaceRelativePath(workspace, absolutePath), "Could not resolve relative path"),
    }
  }),
}) {}

export class SourceProjectCache extends Effect.Service<SourceProjectCache>()("@skastr0/quartz/SourceProjectCache", {
  accessors: true,
  effect: Effect.gen(function* () {
    const workspace = yield* ProjectWorkspace
    const withWorkspace = <A>(
      f: (state: ProjectWorkspaceState) => A,
      message: string,
    ): Effect.Effect<A, QuartzError> =>
      Ref.get(workspace.state).pipe(
        Effect.flatMap((state) =>
          Effect.try({
            try: () => f(state),
            catch: toQuartzError(message),
          }),
        ),
      )
    return {
      getProject: (pkg: PackageInfo): Effect.Effect<Project, QuartzError> =>
        withWorkspace((state) => getCachedProject(state, pkg), "Could not load TypeScript project"),
      getSourceFiles: (project: Project, pkg: PackageInfo): Effect.Effect<readonly SourceFile[], QuartzError> =>
        Effect.sync(() => getWorkspaceSourceFiles(project, pkg)),
      markDirty: () => withWorkspace(markWorkspaceDirty, "Could not mark workspace dirty"),
      refreshAll: () => withWorkspace(refreshAllProjects, "Could not refresh workspace cache"),
      refreshPackage: (packageName: string) =>
        withWorkspace((state) => refreshPackageProject(state, packageName), "Could not refresh package cache"),
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
    const workspace = yield* ProjectWorkspace
    const state = yield* Ref.get(workspace.state)
    const analyzer = createTypeAnalyzerWithWorkspace(config.rootDirectory, state)
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
    TypeAnalyzerService.Default.pipe(Layer.provide(Layer.mergeAll(configLayer, workspaceLayer))),
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
  const workspace = createProjectWorkspaceState(rootDirectory)
  return {
    analyzer: createTypeAnalyzerWithWorkspace(rootDirectory, workspace),
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
    symbol: "removed promise-shaped discovery helpers",
    ownerGlyph: "QZ-003",
    reason: "Package discovery becomes Effect-native only.",
  },
  {
    symbol: "direct new service wiring",
    ownerGlyph: "QZ-003..QZ-006",
    reason: "Direct construction moves into Layer-owned service implementations.",
  },
] as const
