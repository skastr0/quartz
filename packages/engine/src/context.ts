import { resolve } from "node:path"
import type { Project } from "typescript/unstable/async"
import type { PackageInfo } from "./contracts"
import { discoverPackages } from "./discovery"
import { QuartzEngineError } from "./errors"
import type { WorkspaceFileChanges, WorkspaceMetadata, WorkspaceOptions } from "./types"
import { openQuartzWorkspace, type QuartzWorkspace } from "./workspace"

export class AnalyzerContext {
  readonly root: string
  readonly packages: readonly PackageInfo[]
  readonly workspace: QuartzWorkspace
  #dirty = false
  #dirtyRefresh: Promise<WorkspaceMetadata> | null = null
  #revisionCache = new Map<string, { readonly revision: number; readonly value: unknown }>()

  private constructor(
    root: string,
    packages: readonly PackageInfo[],
    workspace: QuartzWorkspace,
    private readonly defaultConfigPath?: string,
  ) {
    this.root = root
    this.packages = packages
    this.workspace = workspace
  }

  static async open(root: string, options: WorkspaceOptions = {}): Promise<AnalyzerContext> {
    const resolvedRoot = resolve(root)
    const selectedTsconfigPaths =
      options.tsconfigPath !== undefined
        ? [options.tsconfigPath, ...(options.tsconfigPaths ?? [])]
        : options.tsconfigPaths === undefined
          ? undefined
          : ["tsconfig.json", ...options.tsconfigPaths]
    const packages = discoverPackages(resolvedRoot, selectedTsconfigPaths)
    if (packages.length === 0) {
      throw new QuartzEngineError("WORKSPACE_OPEN_FAILED", `No tsconfig.json found under ${resolvedRoot}`)
    }

    const primaryConfig =
      options.tsconfigPath === undefined
        ? (packages.find((pkg) => pkg.name === "(root)") ?? packages[0]!).tsconfigPath
        : resolve(resolvedRoot, options.tsconfigPath)
    const defaultConfigPath =
      options.tsconfigPath === undefined
        ? packages.length === 1 || packages.some((pkg) => pkg.name === "(root)")
          ? primaryConfig
          : undefined
        : primaryConfig
    const workspace = await openQuartzWorkspace(resolvedRoot, {
      ...options,
      tsconfigPath: primaryConfig,
      tsconfigPaths: packages.map((pkg) => pkg.tsconfigPath),
    })
    return new AnalyzerContext(resolvedRoot, packages, workspace, defaultConfigPath)
  }

  package(packageName?: string): PackageInfo {
    if (packageName === undefined || packageName.length === 0) {
      const defaultPackage =
        this.defaultConfigPath === undefined
          ? undefined
          : this.packages.find((pkg) => pkg.tsconfigPath === this.defaultConfigPath)
      if (defaultPackage !== undefined) return defaultPackage
      if (this.packages.length === 1) return this.packages[0]!
      throw new QuartzEngineError(
        "WORKSPACE_OPEN_FAILED",
        `Multiple packages found. Please specify a package: ${this.packages.map((pkg) => pkg.name).join(", ")}`,
      )
    }

    const normalized = packageName.replace(/^\//, "")
    const pkg = this.packages.find(
      (candidate) =>
        candidate.name === packageName || candidate.name === normalized || candidate.path.endsWith(packageName),
    )
    if (pkg === undefined) {
      throw new QuartzEngineError(
        "WORKSPACE_OPEN_FAILED",
        `Unknown TypeScript package: ${packageName}. Available: ${this.packages.map((candidate) => candidate.name).join(", ")}`,
      )
    }
    return pkg
  }


  async withProject<T>(
    operation: (project: Project, pkg: PackageInfo, revision: number) => Promise<T>,
    packageName?: string,
  ): Promise<T> {
    await this.#ensureFresh()
    const pkg = this.package(packageName)
    return this.workspace.withProject((project, revision) => operation(project, pkg, revision), pkg.tsconfigPath)
  }

  cacheForRevision<T>(key: string, revision: number, load: () => T): T {
    const cached = this.#revisionCache.get(key)
    if (cached?.revision === revision) return cached.value as T
    const value = load()
    this.#revisionCache.set(key, { revision, value })
    return value
  }

  async refresh(changes?: WorkspaceFileChanges): Promise<WorkspaceMetadata> {
    const metadata = await this.workspace.refresh(changes)
    this.#revisionCache.clear()
    this.#dirty = false
    return metadata
  }

  refreshPackage(packageName: string): Promise<WorkspaceMetadata> {
    const pkg = this.package(packageName)
    return this.refresh({ changed: [pkg.tsconfigPath] })
  }

  markDirty(): void {
    this.#dirty = true
  }

  async #ensureFresh(): Promise<void> {
    if (!this.#dirty) return
    this.#dirtyRefresh ??= this.refresh()
    try {
      await this.#dirtyRefresh
    } finally {
      this.#dirtyRefresh = null
    }
  }

  close(): Promise<void> {
    return this.workspace.close()
  }
}

export const openAnalyzerContext = (root: string, options?: WorkspaceOptions): Promise<AnalyzerContext> =>
  AnalyzerContext.open(root, options)
