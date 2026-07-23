import { existsSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { version } from "typescript"
import { API, type Project, type Snapshot } from "typescript/unstable/async"
import { QuartzEngineError } from "./errors"
import { collectDiagnostics } from "./diagnostics"
import type { EngineDiagnostic, WorkspaceFileChanges, WorkspaceMetadata, WorkspaceOptions } from "./types"

const resolveTypeScriptExecutable = (): string => {
  const platformPackage = `@typescript/typescript-${process.platform}-${process.arch}`
  const executableName = process.platform === "win32" ? "tsc.exe" : "tsc"
  const executableBase = pathToFileURL(join(dirname(process.execPath), "__quartz_resolver.cjs")).href
  const resolvers = [createRequire(import.meta.url), createRequire(executableBase)]

  for (const resolver of resolvers) {
    const packageJsonCandidates: string[] = []
    try {
      const typescriptPackageJson = resolver.resolve("typescript/package.json")
      packageJsonCandidates.push(createRequire(pathToFileURL(typescriptPackageJson)).resolve(`${platformPackage}/package.json`))
    } catch {
      // A compiled Quartz binary does not expose the bundled TypeScript package.
    }
    try {
      packageJsonCandidates.push(resolver.resolve(`${platformPackage}/package.json`))
    } catch {
      // Continue to the next resolver base.
    }

    for (const packageJson of packageJsonCandidates) {
      const executable = join(dirname(packageJson), "lib", executableName)
      if (existsSync(executable)) return executable
    }
  }

  throw new QuartzEngineError(
    "WORKSPACE_OPEN_FAILED",
    `Unable to resolve ${platformPackage}. Reinstall Quartz with platform dependencies enabled.`,
  )
}

interface RevisionState {
  readonly snapshot: Snapshot
  readonly revision: number
  readonly drained: PromiseWithResolvers<void>
  readers: number
  retired: boolean
  disposePromise: Promise<void> | null
}

const createRevisionState = (snapshot: Snapshot, revision: number): RevisionState => ({
  snapshot,
  revision,
  drained: Promise.withResolvers<void>(),
  readers: 0,
  retired: false,
  disposePromise: null,
})

export class QuartzWorkspace {
  readonly root: string
  readonly configFile: string
  readonly configFiles: readonly string[]

  readonly #api: API
  #current: RevisionState | null
  #mutationTail: Promise<void> = Promise.resolve()
  #closing = false
  #closed = false
  #closePromise: Promise<void> | null = null
  #retirements = new Set<Promise<void>>()
  #activeOperations = 0
  #operationsDrained: PromiseWithResolvers<void> | null = null

  private constructor(
    root: string,
    configFiles: readonly string[],
    api: API,
    state: RevisionState,
  ) {
    this.root = root
    this.configFiles = configFiles
    this.configFile = configFiles[0]!
    this.#api = api
    this.#current = state
  }

  static async open(root: string, options: WorkspaceOptions = {}): Promise<QuartzWorkspace> {
    const resolvedRoot = resolve(root)
    const primaryConfig = resolve(resolvedRoot, options.tsconfigPath ?? "tsconfig.json")
    const configFiles = [
      primaryConfig,
      ...(options.tsconfigPaths ?? []).map((configFile) => resolve(resolvedRoot, configFile)),
    ].filter((configFile, index, all) => all.indexOf(configFile) === index)
    // Native TS-Go filesystem only — temporary analysis uses runWithTemporaryFileUpdate,
    // so a JS hybrid FS is not on the normal project-read path.
    const api = new API({
      cwd: resolvedRoot,
      tsserverPath: options.tsserverPath ?? resolveTypeScriptExecutable(),
      ...(options.collectTiming === undefined ? {} : { collectTiming: options.collectTiming }),
    })

    try {
      const snapshot = await api.updateSnapshot({ openProjects: configFiles })
      const missingConfig = configFiles.find((configFile) => snapshot.getProject(configFile) === undefined)
      if (missingConfig !== undefined) {
        await snapshot.dispose()
        throw new QuartzEngineError(
          "WORKSPACE_OPEN_FAILED",
          `TypeScript did not load the configured project at ${missingConfig}`,
        )
      }
      return new QuartzWorkspace(resolvedRoot, configFiles, api, createRevisionState(snapshot, 1))
    } catch (cause) {
      await api.close().catch(() => undefined)
      if (cause instanceof QuartzEngineError) throw cause
      throw new QuartzEngineError("WORKSPACE_OPEN_FAILED", `Failed to open Quartz workspace at ${resolvedRoot}`, cause)
    }
  }

  get metadata(): WorkspaceMetadata {
    return {
      root: this.root,
      configFile: this.configFile,
      configFiles: this.configFiles,
      revision: this.#current?.revision ?? 0,
      analysisTypescriptVersion: version,
      closed: this.#closed,
    }
  }

  async diagnostics(configFile: string = this.configFile): Promise<readonly EngineDiagnostic[]> {
    return this.withProject((project) => collectDiagnostics(project), configFile)
  }

  /** TS-Go client/server timing snapshot when collectTiming was enabled at open. */
  getTimingInfo(): Promise<unknown> {
    this.#assertAcceptingWork()
    return this.#api.getTimingInfo()
  }

  resetTimingInfo(): Promise<void> {
    this.#assertAcceptingWork()
    return this.#api.resetTimingInfo()
  }

  withProject<T>(
    operation: (project: Project, revision: number) => Promise<T>,
    configFile: string = this.configFile,
  ): Promise<T> {
    const resolvedConfig = resolve(configFile)
    return this.#withProject((state) => {
      const project = state.snapshot.getProject(resolvedConfig)
      if (project === undefined) {
        throw new QuartzEngineError("WORKSPACE_OPEN_FAILED", `Project is not open at ${resolvedConfig}`)
      }
      return operation(project, state.revision)
    })
  }

  /**
   * Run analysis against a temporary file update without mutating the base
   * snapshot or revision. Concurrent temporary operations are isolated and may
   * proceed in parallel against the same immutable base.
   */
  async withVirtualFile<T>(
    tsconfigPath: string,
    filePath: string,
    content: string,
    operation: (project: Project, filePath: string) => Promise<T>,
  ): Promise<T> {
    this.#assertAcceptingWork()
    this.#beginOperation()
    const resolvedConfig = resolve(tsconfigPath)
    const resolvedFile = resolve(filePath)
    const base = this.#requireCurrent()
    base.readers += 1
    try {
      let result!: T
      await this.#api.runWithTemporaryFileUpdate(base.snapshot, resolvedFile, content, async (temporarySnapshot) => {
        this.#assertAcceptingWork()
        // Concurrent refresh may retire this base; the leased snapshot remains
        // valid for the temporary callback, and later work uses the new current.
        const project =
          (await temporarySnapshot.getDefaultProjectForFile(resolvedFile)) ??
          temporarySnapshot.getProject(resolvedConfig)
        if (project === undefined) {
          throw new QuartzEngineError(
            "WORKSPACE_REFRESH_FAILED",
            `TypeScript did not load a project for temporary file ${resolvedFile}`,
          )
        }
        result = await operation(project, resolvedFile)
      })
      return result
    } catch (cause) {
      if (cause instanceof QuartzEngineError) throw cause
      throw new QuartzEngineError(
        "WORKSPACE_REFRESH_FAILED",
        `Temporary file analysis failed for ${resolvedFile}`,
        cause,
      )
    } finally {
      this.#releaseState(base)
      this.#endOperation()
    }
  }

  refresh(changes?: WorkspaceFileChanges): Promise<WorkspaceMetadata> {
    this.#assertAcceptingWork()
    return this.#enqueueMutation(async () => {
      try {
        const previous = this.#requireCurrent()
        const snapshot = await this.#api.updateSnapshot({
          fileChanges:
            changes === undefined
              ? { invalidateAll: true }
              : {
                  ...(changes.changed === undefined ? {} : { changed: changes.changed.map((path) => resolve(path)) }),
                  ...(changes.created === undefined ? {} : { created: changes.created.map((path) => resolve(path)) }),
                  ...(changes.deleted === undefined ? {} : { deleted: changes.deleted.map((path) => resolve(path)) }),
                },
        })
        const missingConfig = this.configFiles.find((configFile) => snapshot.getProject(configFile) === undefined)
        if (missingConfig !== undefined) {
          await snapshot.dispose()
          throw new QuartzEngineError(
            "WORKSPACE_REFRESH_FAILED",
            `TypeScript lost the configured project at ${missingConfig}`,
          )
        }

        this.#current = createRevisionState(snapshot, previous.revision + 1)
        this.#retire(previous)
        return this.metadata
      } catch (cause) {
        if (cause instanceof QuartzEngineError) throw cause
        throw new QuartzEngineError("WORKSPACE_REFRESH_FAILED", `Failed to refresh ${this.root}`, cause)
      }
    })
  }

  close(): Promise<void> {
    if (this.#closePromise !== null) return this.#closePromise
    this.#closing = true
    this.#closePromise = (async () => {
      await this.#operationsDrained?.promise
      await this.#enqueueMutation(async () => {
        const current = this.#current
        this.#current = null
        if (current !== null) this.#retire(current)
        await Promise.all([...this.#retirements])
        await this.#api.close()
        this.#closed = true
      })
    })()
    return this.#closePromise
  }

  async #withProject<T>(operation: (state: RevisionState) => Promise<T>): Promise<T> {
    this.#assertAcceptingWork()
    this.#beginOperation()
    const state = this.#requireCurrent()
    state.readers += 1
    try {
      return await operation(state)
    } finally {
      this.#releaseState(state)
      this.#endOperation()
    }
  }

  #beginOperation(): void {
    if (this.#activeOperations === 0) this.#operationsDrained = Promise.withResolvers<void>()
    this.#activeOperations += 1
  }

  #endOperation(): void {
    this.#activeOperations -= 1
    if (this.#activeOperations === 0) {
      this.#operationsDrained?.resolve()
      this.#operationsDrained = null
    }
  }

  #releaseState(state: RevisionState): void {
    state.readers -= 1
    if (state.retired && state.readers === 0) state.drained.resolve()
  }

  #enqueueMutation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#mutationTail.then(operation)
    this.#mutationTail = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  #retire(state: RevisionState): void {
    if (state.disposePromise !== null) return
    state.retired = true
    if (state.readers === 0) state.drained.resolve()
    const retirement = state.drained.promise.then(() => state.snapshot.dispose())
    state.disposePromise = retirement
    this.#retirements.add(retirement)
    retirement.then(
      () => this.#retirements.delete(retirement),
      () => this.#retirements.delete(retirement),
    )
  }

  #assertAcceptingWork(): void {
    if (this.#closing || this.#closed) {
      throw new QuartzEngineError("WORKSPACE_CLOSED", `Quartz workspace at ${this.root} is closed`)
    }
  }

  #requireCurrent(): RevisionState {
    const current = this.#current
    if (current === null) {
      throw new QuartzEngineError("WORKSPACE_CLOSED", `Quartz workspace at ${this.root} is closed`)
    }
    return current
  }
}

export const openQuartzWorkspace = (root: string, options?: WorkspaceOptions): Promise<QuartzWorkspace> =>
  QuartzWorkspace.open(root, options)
