import { resolve } from "node:path"
import { Project, type SourceFile, SyntaxKind } from "ts-morph"
import { discoverPackagesSync, type PackageInfo } from "./discovery"

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

export class ProjectWorkspace {
  readonly rootDirectory: string
  private packages: PackageInfo[] | null = null
  private readonly projectCache = new LruCache<string, CachedProject>(MAX_CACHED_PROJECTS)
  private readonly projectErrors = new Map<string, string>()
  private dirty = false

  constructor(directory: string) {
    this.rootDirectory = resolve(directory)
  }

  markDirty(): void {
    this.dirty = true
  }

  refreshAll(): void {
    this.projectCache.clear()
    this.projectErrors.clear()
  }

  async refreshPackage(packageName: string): Promise<boolean> {
    const pkg = await this.resolvePackage(packageName)
    const deleted = this.projectCache.delete(pkg.tsconfigPath)
    this.projectErrors.delete(pkg.tsconfigPath)
    return deleted
  }

  async getPackages(): Promise<PackageInfo[]> {
    if (!this.packages) {
      this.packages = [...discoverPackagesSync(this.rootDirectory)]
    }
    return this.packages
  }

  async resolvePackage(packageName?: string): Promise<PackageInfo> {
    const packages = await this.getPackages()

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

  getProject(pkg: PackageInfo): Project {
    if (this.dirty) {
      this.projectCache.clear()
      this.projectErrors.clear()
      this.dirty = false
    }

    const cached = this.projectCache.get(pkg.tsconfigPath)
    if (cached !== undefined) {
      if (Date.now() - cached.timestamp <= CACHE_TTL) return cached.project
      this.projectCache.delete(pkg.tsconfigPath)
      this.projectErrors.delete(pkg.tsconfigPath)
    }

    const cachedError = this.projectErrors.get(pkg.tsconfigPath)
    if (cachedError !== undefined) throw new Error(cachedError)

    try {
      const project = new Project({
        tsConfigFilePath: pkg.tsconfigPath,
        skipAddingFilesFromTsConfig: false,
      })
      this.projectCache.set(pkg.tsconfigPath, { project, packageInfo: pkg, timestamp: Date.now() })
      return project
    } catch (cause) {
      const message = `Failed to initialize TypeScript project for ${pkg.name}: ${
        cause instanceof Error ? cause.message : String(cause)
      }`
      this.projectErrors.set(pkg.tsconfigPath, message)
      throw new Error(message)
    }
  }

  getSourceFiles(project: Project, pkg: PackageInfo): SourceFile[] {
    return project.getSourceFiles().filter((sourceFile) => {
      if (sourceFile.isInNodeModules()) return false
      return sourceFile.getFilePath().startsWith(pkg.path)
    })
  }

  getCachedProjects(): readonly CachedProject[] {
    return [...this.projectCache.values()]
  }

  relativePath(absolutePath: string): string {
    if (absolutePath.startsWith(this.rootDirectory)) {
      return absolutePath.slice(this.rootDirectory.length + 1)
    }
    return absolutePath
  }
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
