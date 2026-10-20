import { existsSync } from "node:fs"
import { dirname, extname, join, relative, resolve } from "node:path"
import { SymbolFlags, type Project } from "tsrs/unstable/async"
import type { SourceFile } from "tsrs/unstable/ast"

/**
 * Prefer a source directory that is typically covered by tsconfig include
 * globs (`types/**`, `src/**`, …). Temporary file updates for paths outside
 * include patterns work but are dramatically slower in TS-Go.
 */
export const resolveVirtualFileDirectory = (packageRoot: string): string => {
  const root = resolve(packageRoot)
  for (const candidate of ["types", "src", "lib", "source"]) {
    const directory = join(root, candidate)
    if (existsSync(directory)) return directory
  }
  return root
}

export const modulePathFor = (from: string, fileName: string): string => {
  const withoutExtension = fileName.slice(0, -extname(fileName).length)
  const path = relative(dirname(from), withoutExtension).replaceAll("\\", "/")
  return path.startsWith(".") ? path : `./${path}`
}

const isSourceFileIn = (fileName: string, root: string): boolean => {
  const resolved = resolve(fileName)
  const base = resolve(root)
  return resolved === base || resolved.startsWith(`${base}/`)
}

const isIndexFile = (fileName: string): boolean => /(?:^|\/)index\.[cm]?[jt]sx?$/.test(fileName.replaceAll("\\", "/"))

const packageSources = async (project: Project, packageRoot: string) => {
  const files = (await project.program.getSourceFileNames())
    .filter((fileName) =>
      isSourceFileIn(fileName, packageRoot)
      && !fileName.endsWith(".d.ts")
      && /\.[cm]?[jt]sx?$/.test(fileName))
    .sort((left, right) => {
      const leftRelative = relative(packageRoot, left)
      const rightRelative = relative(packageRoot, right)
      const rank = (value: string) => value === "index.ts" || value === "index.tsx" ? 0 : value.startsWith("src/") ? 1 : 2
      return rank(leftRelative) - rank(rightRelative) || leftRelative.localeCompare(rightRelative)
    })
  const loaded = (await Promise.all(files.map((fileName) => project.program.getSourceFile(fileName))))
    .filter((source): source is SourceFile => source !== undefined)
  const entry = loaded.find((source) => isIndexFile(source.fileName))
  return entry === undefined ? loaded : [entry]
}

export interface VirtualPackageImports {
  readonly content: string
  readonly lineOffset: number
}

/** One public module of a package: its file and the importable names it exports. */
export interface PackageModuleExports {
  readonly fileName: string
  readonly names: readonly { readonly name: string; readonly value: boolean }[]
}

/**
 * Read the public entrypoint exports of a package. Holds plain data only, so it can be
 * cached for the life of a revision; the module symbols and export lists are fetched as
 * two batched round trips instead of two per source file.
 */
export const loadPackageExports = async (
  project: Project,
  packageRoot: string,
): Promise<readonly PackageModuleExports[]> => {
  const sources = await packageSources(project, packageRoot)
  if (sources.length === 0) return []
  const moduleSymbols = await project.checker.getSymbolAtLocation(sources)
  const present = sources.flatMap((source, index) => {
    const symbol = moduleSymbols[index]
    return symbol === undefined ? [] : [{ source, symbol }]
  })
  const exported = await Promise.all(present.map(({ symbol }) => project.checker.getExportsOfModule(symbol)))
  return present.map(({ source }, index) => ({
    fileName: source.fileName,
    names: exported[index]!
      .filter((symbol) => symbol.name !== "default" && /^[A-Za-z_$][\w$]*$/.test(symbol.name))
      .map((symbol) => ({ name: symbol.name, value: (symbol.flags & SymbolFlags.Value) !== SymbolFlags.None })),
  }))
}

/**
 * Render imports for the package's public entrypoint into an ephemeral source.
 * Type-only exports are kept type-only so verbatimModuleSyntax remains valid.
 * Names in `reserved` are bound by the source itself and are not imported.
 */
export const renderPackageImports = (
  modules: readonly PackageModuleExports[],
  virtualFilePath: string,
  reserved: ReadonlySet<string> = new Set(),
): VirtualPackageImports => {
  const claimedNames = new Set<string>(reserved)
  const lines: string[] = []
  for (const module of modules) {
    if (module.fileName === virtualFilePath) continue
    const typeNames: string[] = []
    const valueNames: string[] = []
    for (const { name, value } of module.names) {
      if (claimedNames.has(name)) continue
      claimedNames.add(name)
      if (value) valueNames.push(name)
      else typeNames.push(name)
    }
    const modulePath = modulePathFor(virtualFilePath, module.fileName)
    if (typeNames.length > 0) lines.push(`import type { ${typeNames.sort().join(", ")} } from ${JSON.stringify(modulePath)}`)
    if (valueNames.length > 0) lines.push(`import { ${valueNames.sort().join(", ")} } from ${JSON.stringify(modulePath)}`)
  }
  return { content: lines.length === 0 ? "" : `${lines.join("\n")}\n`, lineOffset: lines.length }
}

export const synthesizePackageImports = async (
  project: Project,
  packageRoot: string,
  virtualFilePath: string,
  reserved: ReadonlySet<string> = new Set(),
  modules: Promise<readonly PackageModuleExports[]> = loadPackageExports(project, packageRoot),
): Promise<VirtualPackageImports> => renderPackageImports(await modules, virtualFilePath, reserved)

export interface VirtualFileLease {
  readonly path: string
  readonly content: string
  readonly token: symbol
  dispose(): void
}

export interface VirtualFileEntry {
  readonly path: string
  readonly content: string
  readonly token: symbol
}

export interface VirtualFileRegistry {
  acquire(content: string, extension?: ".ts" | ".tsx"): VirtualFileLease
  create(content: string, extension?: ".ts" | ".tsx"): VirtualFileLease
  get(path: string): string | undefined
  has(path: string): boolean
  entries(): readonly VirtualFileEntry[]
  readonly size: number
  clear(): void
}

/**
 * A per-context registry for ephemeral source files. A lease owns exactly one
 * entry; disposing an old lease can never remove a newer entry at the same
 * path, which makes cleanup safe even when callers race.
 */
export const createVirtualFileRegistry = (root: string, prefix = "__quartz_snippet_"): VirtualFileRegistry => {
  const directory = resolve(root)
  const files = new Map<string, VirtualFileEntry>()
  let sequence = 0

  const acquire = (content: string, extension: ".ts" | ".tsx" = ".ts"): VirtualFileLease => {
    const token = Symbol("virtual-file")
    const id = `${Date.now().toString(36)}_${(sequence++).toString(36)}`
    const path = join(directory, `${prefix}${id}${extension}`)
    const entry: VirtualFileEntry = { path, content, token }
    files.set(path, entry)
    let disposed = false
    return {
      ...entry,
      dispose: () => {
        if (disposed) return
        disposed = true
        const current = files.get(path)
        if (current?.token === token) files.delete(path)
      },
    }
  }

  return {
    acquire,
    create: acquire,
    get: (path) => files.get(path)?.content,
    has: (path) => files.has(path),
    entries: () => [...files.values()],
    get size() {
      return files.size
    },
    clear: () => files.clear(),
  }
}

export const withVirtualFile = async <T>(
  registry: VirtualFileRegistry,
  content: string,
  operation: (lease: VirtualFileLease) => Promise<T>,
  extension: ".ts" | ".tsx" = ".ts",
): Promise<T> => {
  const lease = registry.acquire(content, extension)
  try {
    return await operation(lease)
  } finally {
    lease.dispose()
  }
}
