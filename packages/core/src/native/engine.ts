import { API } from "typescript/unstable/sync"
import type { Program, Project, Snapshot } from "typescript/unstable/sync"
import { nativeLoadFailure } from "./errors"
import { assertNativeRuntimeSupported } from "./runtime"
import { createHybridFileSystem, type HybridFileSystem } from "./vfs"

/**
 * Native session lifecycle. Mirrors the morph engine's `project-workspace.ts`:
 * a bounded, time-to-live cache over loaded projects, backed here by a single
 * `tsgo` server (one `API` instance). Projects are ref-counted opens on that
 * server; a fresh {@link Snapshot} is taken whenever the open set changes, and
 * the previous snapshot is disposed so its per-snapshot handles are released.
 *
 * The `API` is constructed lazily on first project load — constructing it spawns
 * the `tsgo` child process, so `doctor`, package discovery, and unimplemented
 * commands never pay for a server they don't use.
 */

/** Matches `project-workspace.ts` (morph): re-open a project older than this to pick up edits. */
const CACHE_TTL = 60_000
/** Matches `project-workspace.ts` (morph): most-recently-used projects kept open. */
const MAX_OPEN_PROJECTS = 5

export interface NativeEngine {
  /** Load (or reuse) the configured project for a tsconfig path. Throws {@link nativeLoadFailure} on failure. */
  readonly getProject: (tsconfigPath: string) => Project
  /** Convenience: the loaded project's program. */
  readonly getProgram: (tsconfigPath: string) => Program
  /** Load a temporary virtual file through the shared native server. */
  readonly createSnippetProject: (
    tsconfigPath: string,
    snippetPath: string,
    snippetContent: string,
  ) => {
    readonly api: API
    readonly snapshot: Snapshot
    readonly project: Project
    readonly program: Program
    readonly dispose: () => void
  }
  /** Close the server and release every open project. Idempotent. */
  readonly dispose: () => void
}

export const createNativeEngine = (rootDirectory: string): NativeEngine => {
  let api: API | null = null
  let snapshot: Snapshot | null = null
  let fileSystem: HybridFileSystem | null = null
  const openSnippetPaths = new Set<string>()
  // Insertion order == least-recently-used order; value is the last-access timestamp for TTL.
  const openedAt = new Map<string, number>()

  const ensureApi = (): API => {
    if (api === null) {
      assertNativeRuntimeSupported()
      try {
        fileSystem = createHybridFileSystem({})
        api = new API({ cwd: rootDirectory, fs: fileSystem })
      } catch (cause) {
        api = null
        fileSystem = null
        throw nativeLoadFailure(`Could not start the native TypeScript engine for ${rootDirectory}.`, cause)
      }
    }
    return api
  }

  const touch = (tsconfigPath: string): void => {
    openedAt.delete(tsconfigPath)
    openedAt.set(tsconfigPath, Date.now())
  }

  const evictOverflow = (activeApi: API): void => {
    while (openedAt.size > MAX_OPEN_PROJECTS) {
      const oldest = openedAt.keys().next().value
      if (oldest === undefined) break
      openedAt.delete(oldest)
      const next = activeApi.updateSnapshot({ closeProjects: [oldest] })
      snapshot?.dispose()
      snapshot = next
    }
  }

  const loadProject = (tsconfigPath: string): Project => {
    const activeApi = ensureApi()
    const openedTimestamp = openedAt.get(tsconfigPath)
    const isFresh = openedTimestamp !== undefined && Date.now() - openedTimestamp <= CACHE_TTL && snapshot !== null

    if (isFresh) {
      touch(tsconfigPath)
    } else {
      const next = activeApi.updateSnapshot({ openProjects: [tsconfigPath] })
      snapshot?.dispose()
      snapshot = next
      touch(tsconfigPath)
      evictOverflow(activeApi)
    }

    const active = snapshot
    if (active === null) {
      throw nativeLoadFailure(`Native snapshot was unavailable after loading ${tsconfigPath}.`)
    }
    const project = active.getProject(tsconfigPath)
    if (project === undefined) {
      throw nativeLoadFailure(
        `The native engine could not resolve a project for ${tsconfigPath}. ` +
          `The tsconfig may be unsupported by the native engine.`,
      )
    }
    return project
  }

  const createSnippetProject = (tsconfigPath: string, snippetPath: string, snippetContent: string) => {
    const activeApi = ensureApi()
    const activeFileSystem = fileSystem
    if (activeFileSystem === null) {
      throw nativeLoadFailure("Native virtual filesystem was unavailable for snippet analysis.")
    }

    activeFileSystem.virtualFiles.set(snippetPath, snippetContent)
    try {
      const closeFiles = [...openSnippetPaths]
      const next = activeApi.updateSnapshot({
        openProjects: [tsconfigPath],
        openFiles: [snippetPath],
        ...(closeFiles.length === 0 ? {} : { closeFiles }),
        fileChanges: { created: [snippetPath] },
      })
      snapshot?.dispose()
      snapshot = next
      touch(tsconfigPath)
      for (const openSnippetPath of closeFiles) {
        openSnippetPaths.delete(openSnippetPath)
        activeFileSystem.virtualFiles.delete(openSnippetPath)
      }
      openSnippetPaths.add(snippetPath)
      const project = next.getProject(tsconfigPath)
      if (project === undefined) {
        next.dispose()
        snapshot = null
        openSnippetPaths.delete(snippetPath)
        activeFileSystem.virtualFiles.delete(snippetPath)
        throw nativeLoadFailure(`The native engine could not resolve a project for ${tsconfigPath} during snippet analysis.`)
      }

      let disposed = false
      return {
        api: activeApi,
        snapshot: next,
        project,
        program: project.program,
        dispose: () => {
          if (disposed) return
          disposed = true
          try {
            next.dispose()
          } finally {
            if (snapshot === next) snapshot = null
            openSnippetPaths.delete(snippetPath)
            activeFileSystem.virtualFiles.delete(snippetPath)
          }
        },
      }
    } catch (cause) {
      openSnippetPaths.delete(snippetPath)
      activeFileSystem.virtualFiles.delete(snippetPath)
      throw cause
    }
  }

  return {
    getProject: loadProject,
    getProgram: (tsconfigPath: string) => loadProject(tsconfigPath).program,
    createSnippetProject,
    dispose: () => {
      try {
        snapshot?.dispose()
      } catch {
        // A failed snapshot dispose must not block closing the server.
      }
      snapshot = null
      openSnippetPaths.clear()
      fileSystem = null
      openedAt.clear()
      const activeApi = api
      api = null
      if (activeApi !== null) {
        try {
          activeApi.close()
        } catch {
          // Best-effort: the server may already be gone.
        }
      }
    },
  }
}
