import { resolve } from "node:path"
import { Project, type SourceFile, SyntaxKind } from "ts-morph"
import type { PackageInfo } from "./discovery"

export interface CachedProject {
  readonly project: Project
  readonly packageInfo: PackageInfo
  readonly timestamp: number
}

const CACHE_TTL = 60_000
const MAX_CACHED_PROJECTS = 5

class LruCache<K, V> {
  private readonly cache = new Map<K, V>()

  constructor(private readonly maxSize: number) {}

  get(key: K): V | undefined {
    const value = this.cache.get(key)
    if (value !== undefined) {
      this.cache.delete(key)
      this.cache.set(key, value)
    }
    return value
  }

  set(key: K, value: V): void {
    if (this.cache.has(key)) {
      this.cache.delete(key)
    } else if (this.cache.size >= this.maxSize) {
      const oldest = this.cache.keys().next().value
      if (oldest !== undefined) this.cache.delete(oldest)
    }
    this.cache.set(key, value)
  }

  delete(key: K): boolean {
    return this.cache.delete(key)
  }

  clear(): void {
    this.cache.clear()
  }

  values(): IterableIterator<V> {
    return this.cache.values()
  }
}

export interface ProjectWorkspaceState {
  readonly rootDirectory: string
  packages: PackageInfo[] | null
  readonly projectCache: LruCache<string, CachedProject>
  readonly projectErrors: Map<string, string>
  dirty: boolean
}

export const createProjectWorkspaceState = (directory: string): ProjectWorkspaceState => ({
  rootDirectory: resolve(directory),
  packages: null,
  projectCache: new LruCache<string, CachedProject>(MAX_CACHED_PROJECTS),
  projectErrors: new Map<string, string>(),
  dirty: false,
})

export const markWorkspaceDirty = (state: ProjectWorkspaceState): void => {
  state.dirty = true
  state.packages = null
}

export const refreshAllProjects = (state: ProjectWorkspaceState): void => {
  state.packages = null
  state.projectCache.clear()
  state.projectErrors.clear()
}

export const refreshPackageProject = (state: ProjectWorkspaceState, pkg: PackageInfo): boolean => {
  const deleted = state.projectCache.delete(pkg.tsconfigPath)
  state.projectErrors.delete(pkg.tsconfigPath)
  return deleted
}

export const setWorkspacePackages = (state: ProjectWorkspaceState, packages: readonly PackageInfo[]): readonly PackageInfo[] => {
  state.packages = [...packages]
  return state.packages
}

export const getWorkspacePackages = (state: ProjectWorkspaceState): readonly PackageInfo[] => {
  if (!state.packages) {
    throw new Error("Workspace packages have not been discovered")
  }
  return state.packages
}

export const resolveWorkspacePackage = (state: ProjectWorkspaceState, packageName?: string): PackageInfo => {
  const packages = getWorkspacePackages(state)

  if (!packageName) {
    const rootPkg = packages.find((pkg) => pkg.name === "(root)")
    if (rootPkg) return rootPkg
    if (packages.length === 1) return packages[0]!
    throw new Error(`Multiple packages found. Please specify a package: ${packages.map((pkg) => pkg.name).join(", ")}`)
  }

  const normalized = packageName.replace(/^\//, "")
  const pkg = packages.find((candidate) =>
    candidate.name === packageName || candidate.name === normalized || candidate.path.endsWith(packageName)
  )

  if (!pkg) {
    throw new Error(`Package "${packageName}" not found. Available: ${packages.map((item) => item.name).join(", ")}`)
  }

  return pkg
}

export const getCachedProject = (state: ProjectWorkspaceState, pkg: PackageInfo): Project => {
  if (state.dirty) {
    state.projectCache.clear()
    state.projectErrors.clear()
    state.dirty = false
  }

  const cached = state.projectCache.get(pkg.tsconfigPath)
  if (cached !== undefined) {
    if (Date.now() - cached.timestamp <= CACHE_TTL) return cached.project
    state.projectCache.delete(pkg.tsconfigPath)
    state.projectErrors.delete(pkg.tsconfigPath)
  }

  const cachedError = state.projectErrors.get(pkg.tsconfigPath)
  if (cachedError !== undefined) throw new Error(cachedError)

  try {
    const project = new Project({
      tsConfigFilePath: pkg.tsconfigPath,
      skipAddingFilesFromTsConfig: false,
    })
    state.projectCache.set(pkg.tsconfigPath, { project, packageInfo: pkg, timestamp: Date.now() })
    return project
  } catch (cause) {
    const message = `Failed to initialize TypeScript project for ${pkg.name}: ${
      cause instanceof Error ? cause.message : String(cause)
    }`
    state.projectErrors.set(pkg.tsconfigPath, message)
    throw new Error(message)
  }
}

export const getWorkspaceSourceFiles = (project: Project, pkg: PackageInfo): SourceFile[] =>
  project.getSourceFiles().filter((sourceFile) => {
    if (sourceFile.isInNodeModules()) return false
    return sourceFile.getFilePath().startsWith(pkg.path)
  })

export const getWorkspaceCachedProjects = (state: ProjectWorkspaceState): readonly CachedProject[] => [
  ...state.projectCache.values(),
]

export const workspaceRelativePath = (state: ProjectWorkspaceState, absolutePath: string): string => {
  if (absolutePath.startsWith(state.rootDirectory)) {
    return absolutePath.slice(state.rootDirectory.length + 1)
  }
  return absolutePath
}

export const kindToString = (kind: SyntaxKind): string => {
  switch (kind) {
    case SyntaxKind.InterfaceDeclaration:
      return "interface"
    case SyntaxKind.TypeAliasDeclaration:
      return "type"
    case SyntaxKind.ClassDeclaration:
      return "class"
    case SyntaxKind.FunctionDeclaration:
      return "function"
    case SyntaxKind.VariableDeclaration:
      return "variable"
    case SyntaxKind.EnumDeclaration:
      return "enum"
    case SyntaxKind.ModuleDeclaration:
      return "module"
    default:
      return SyntaxKind[kind] ?? "unknown"
  }
}
