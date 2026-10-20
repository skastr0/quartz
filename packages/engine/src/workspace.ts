import { existsSync } from "node:fs"
import { AsyncLocalStorage } from "node:async_hooks"
import { createRequire } from "node:module"
import { dirname, join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { typescriptVersion } from "tsrs"
import { API, type Project, type Snapshot } from "tsrs/unstable/async"
import { QuartzEngineError } from "./errors"
import { collectDiagnostics } from "./diagnostics"
import type { EngineDiagnostic, WorkspaceFileChanges, WorkspaceMetadata, WorkspaceOptions, WorkspaceVirtualFile } from "./types"

// tsrs ships its native binary in a per-platform package, GNU-suffixed on Linux.
const tsrsPlatformPackage = (): string =>
  `@tsrs/${process.platform}-${process.arch}${process.platform === "linux" ? "-gnu" : ""}`

const resolveTsrsExecutable = (): string => {
  const override = process.env.TSRS_BINARY
  if (override !== undefined && override.length > 0) return override
  const platformPackage = tsrsPlatformPackage()
  const executableName = process.platform === "win32" ? "tsrs.exe" : "tsrs"
  const executableBase = pathToFileURL(join(dirname(process.execPath), "__quartz_resolver.cjs")).href
  const resolvers = [createRequire(import.meta.url), createRequire(executableBase)]

  for (const resolver of resolvers) {
    const packageJsonCandidates: string[] = []
    try {
      const tsrsPackageJson = resolver.resolve("tsrs/package.json")
      packageJsonCandidates.push(createRequire(pathToFileURL(tsrsPackageJson)).resolve(`${platformPackage}/package.json`))
    } catch {
      // A compiled Quartz binary does not expose the bundled tsrs package.
    }
    try {
      packageJsonCandidates.push(resolver.resolve(`${platformPackage}/package.json`))
    } catch {
      // Continue to the next resolver base.
    }

    for (const packageJson of packageJsonCandidates) {
      const executable = join(dirname(packageJson), executableName)
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

interface RevisionLease {
  readonly state: RevisionState
  active: boolean
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
  /** Request-local lease keeps nested virtual work on its caller's revision. */
  #revisionLease = new AsyncLocalStorage<RevisionLease>()

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
    // Native tsrs filesystem only — temporary analysis uses runWithTemporaryFileUpdate,
    // so a JS hybrid FS is not on the normal project-read path.
    const api = new API({
      cwd: resolvedRoot,
      tsserverPath: options.tsserverPath ?? resolveTsrsExecutable(),
      ...(options.collectTiming === undefined ? {} : { collectTiming: options.collectTiming }),
    })

    try {
      const snapshot = await api.createSnapshot({ openProjects: configFiles })
      const missingConfig = configFiles.find((configFile) => snapshot.getConfiguredProject(configFile) === undefined)
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
      analysisTypescriptVersion: typescriptVersion,
      closed: this.#closed,
    }
  }

  async diagnostics(configFile: string = this.configFile): Promise<readonly EngineDiagnostic[]> {
    return this.withProject((project) => collectDiagnostics(project), configFile)
  }

  /** tsrs client/server timing snapshot when collectTiming was enabled at open. */
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
      const project = state.snapshot.getConfiguredProject(resolvedConfig)
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
    // Prefer the caller's request-local lease so synthetic/snippet work cannot
    // drift onto a newer #current advanced by a concurrent refresh.
    const inheritedLease = this.#revisionLease.getStore()
    const base = inheritedLease?.active === true ? inheritedLease.state : this.#requireCurrent()
    const lease: RevisionLease = { state: base, active: true }
    base.readers += 1
    try {
      return await this.#revisionLease.run(lease, async () => {
        const baseProject = base.snapshot.getConfiguredProject(resolvedConfig)
        if (baseProject === undefined) {
          throw new QuartzEngineError("WORKSPACE_OPEN_FAILED", `Project is not open at ${resolvedConfig}`)
        }
        const { fileNames, options } = baseProject.parsedCommandLine
        // A layered file outside the tsconfig's include globs joins no configured
        // program, so check it in a synthetic program with the package's options.
        const included = fileNames.some((fileName) => resolve(fileName) === resolvedFile)
        const temporarySnapshot = await base.snapshot.update({
          fileSystem: { kind: "layer", files: { [resolvedFile]: content } },
          ensurePrograms: true,
          ...(included ? {} : { createPrograms: [{ rootFiles: [...fileNames, resolvedFile], compilerOptions: options }] }),
        })
        try {
          this.#assertAcceptingWork()
          const syntheticProgram = temporarySnapshot.operation.createdPrograms?.[0]
          const project = included || syntheticProgram === undefined
            ? temporarySnapshot.getConfiguredProject(resolvedConfig)
            : temporarySnapshot.getProject(syntheticProgram.id)
          if (project === undefined) {
            throw new QuartzEngineError(
              "WORKSPACE_REFRESH_FAILED",
              `TypeScript did not load a project for temporary file ${resolvedFile}`,
            )
          }
          return await operation(project, resolvedFile)
        } finally {
          await temporarySnapshot.dispose()
        }
      })
    } catch (cause) {
      if (cause instanceof QuartzEngineError) throw cause
      throw new QuartzEngineError(
        "WORKSPACE_REFRESH_FAILED",
        `Temporary file analysis failed for ${resolvedFile}`,
        cause,
      )
    } finally {
      lease.active = false
      this.#releaseState(base)
      this.#endOperation()
    }
  }

  /**
   * Run analysis against several temporary file updates in one snapshot without
   * mutating the base snapshot or revision. Every file lands in the same layered
   * filesystem, so imports between them resolve; files outside the tsconfig
   * include join one synthetic program built from the package's options.
   */
  async withVirtualFiles<T>(
    tsconfigPath: string,
    files: readonly WorkspaceVirtualFile[],
    operation: (project: Project, paths: readonly string[]) => Promise<T>,
  ): Promise<T> {
    if (files.length === 0) {
      throw new QuartzEngineError("WORKSPACE_REFRESH_FAILED", "withVirtualFiles requires at least one file")
    }
    this.#assertAcceptingWork()
    this.#beginOperation()
    const resolvedConfig = resolve(tsconfigPath)
    const resolvedFiles = files.map((file) => resolve(file.path))
    if (new Set(resolvedFiles).size !== resolvedFiles.length) {
      throw new QuartzEngineError("WORKSPACE_REFRESH_FAILED", "withVirtualFiles received the same path more than once")
    }
    // Prefer the caller's request-local lease so this work cannot drift onto a
    // newer #current advanced by a concurrent refresh.
    const inheritedLease = this.#revisionLease.getStore()
    const base = inheritedLease?.active === true ? inheritedLease.state : this.#requireCurrent()
    const lease: RevisionLease = { state: base, active: true }
    base.readers += 1
    try {
      return await this.#revisionLease.run(lease, async () => {
        const baseProject = base.snapshot.getConfiguredProject(resolvedConfig)
        if (baseProject === undefined) {
          throw new QuartzEngineError("WORKSPACE_OPEN_FAILED", `Project is not open at ${resolvedConfig}`)
        }
        const { fileNames, options } = baseProject.parsedCommandLine
        const included = resolvedFiles.every((file) => fileNames.some((fileName) => resolve(fileName) === file))
        const layered: Record<string, string> = {}
        for (let index = 0; index < resolvedFiles.length; index += 1) {
          layered[resolvedFiles[index]!] = files[index]!.content
        }
        const temporarySnapshot = await base.snapshot.update({
          fileSystem: { kind: "layer", files: layered },
          ensurePrograms: true,
          ...(included ? {} : { createPrograms: [{ rootFiles: [...fileNames, ...resolvedFiles], compilerOptions: options }] }),
        })
        try {
          this.#assertAcceptingWork()
          const syntheticProgram = temporarySnapshot.operation.createdPrograms?.[0]
          const project = included || syntheticProgram === undefined
            ? temporarySnapshot.getConfiguredProject(resolvedConfig)
            : temporarySnapshot.getProject(syntheticProgram.id)
          if (project === undefined) {
            throw new QuartzEngineError(
              "WORKSPACE_REFRESH_FAILED",
              `TypeScript did not load a project for temporary files under ${resolvedConfig}`,
            )
          }
          return await operation(project, resolvedFiles)
        } finally {
          await temporarySnapshot.dispose()
        }
      })
    } catch (cause) {
      if (cause instanceof QuartzEngineError) throw cause
      throw new QuartzEngineError(
        "WORKSPACE_REFRESH_FAILED",
        `Temporary file analysis failed for ${resolvedFiles.length} files under ${resolvedConfig}`,
        cause,
      )
    } finally {
      lease.active = false
      this.#releaseState(base)
      this.#endOperation()
    }
  }

  refresh(changes?: WorkspaceFileChanges): Promise<WorkspaceMetadata> {
    this.#assertAcceptingWork()
    return this.#enqueueMutation(async () => {
      try {
        const previous = this.#requireCurrent()
        // Without ensurePrograms the new snapshot keeps the stale programs.
        const snapshot = await previous.snapshot.update({
          ensurePrograms: true,
          fileNotifications:
            changes === undefined
              ? { invalidateAll: true }
              : {
                  ...(changes.changed === undefined ? {} : { changed: changes.changed.map((path) => resolve(path)) }),
                  ...(changes.created === undefined ? {} : { created: changes.created.map((path) => resolve(path)) }),
                  ...(changes.deleted === undefined ? {} : { deleted: changes.deleted.map((path) => resolve(path)) }),
                },
        })
        const missingConfig = this.configFiles.find((configFile) => snapshot.getConfiguredProject(configFile) === undefined)
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
    const lease: RevisionLease = { state, active: true }
    state.readers += 1
    try {
      return await this.#revisionLease.run(lease, () => operation(state))
    } finally {
      lease.active = false
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
