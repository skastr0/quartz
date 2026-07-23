import { existsSync } from "node:fs"
import { dirname, extname, join, relative, resolve } from "node:path"
import { SymbolFlags, type Project } from "typescript/unstable/async"
import type { SourceFile } from "typescript/unstable/ast"

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

const modulePathFor = (from: string, fileName: string): string => {
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

const packageSources = async (project: Project, packageRoot: string, virtualFilePath: string) => {
  const files = (await project.program.getSourceFileNames())
    .filter((fileName) =>
      fileName !== virtualFilePath
      && isSourceFileIn(fileName, packageRoot)
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

/**
 * Render imports for the package's public entrypoint into an ephemeral source.
 * Type-only exports are kept type-only so verbatimModuleSyntax remains valid.
 */
export const synthesizePackageImports = async (
  project: Project,
  packageRoot: string,
  virtualFilePath: string,
): Promise<VirtualPackageImports> => {
  const sources = await packageSources(project, packageRoot, virtualFilePath)
  if (sources.length === 0) return { content: "", lineOffset: 0 }
  const claimedNames = new Set<string>()
  const lines: string[] = []
  for (const source of sources) {
    const moduleSymbol = await project.checker.getSymbolAtLocation(source)
    if (moduleSymbol === undefined) continue
    const exported = await project.checker.getExportsOfModule(moduleSymbol)
    const typeNames: string[] = []
    const valueNames: string[] = []
    for (const symbol of exported) {
      if (
        symbol.name === "default"
        || claimedNames.has(symbol.name)
        || !/^[A-Za-z_$][\w$]*$/.test(symbol.name)
      ) continue
      claimedNames.add(symbol.name)
      if ((symbol.flags & SymbolFlags.Value) !== SymbolFlags.None) valueNames.push(symbol.name)
      else typeNames.push(symbol.name)
    }
    const modulePath = modulePathFor(virtualFilePath, source.fileName)
    if (typeNames.length > 0) lines.push(`import type { ${typeNames.sort().join(", ")} } from ${JSON.stringify(modulePath)}`)
    if (valueNames.length > 0) lines.push(`import { ${valueNames.sort().join(", ")} } from ${JSON.stringify(modulePath)}`)
  }
  return { content: lines.length === 0 ? "" : `${lines.join("\n")}\n`, lineOffset: lines.length }
}
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
