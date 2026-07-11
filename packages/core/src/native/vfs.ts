import { readdirSync, readFileSync, statSync } from "node:fs"
import { basename, dirname } from "node:path"
import type { FileSystem } from "typescript/unstable/fs"

/**
 * A hybrid virtual filesystem that overlays one or more in-memory files on top
 * of the real filesystem. Used by the native snippet/eval commands so each
 * snippet gets an isolated in-memory file while relative imports still resolve
 * against the real package source.
 *
 * `createVirtualFileSystem` alone is not enough: it reports `fileExists` and
 * `directoryExists` as `false` for any path not explicitly injected, which
 * breaks module resolution for real source files. This helper merges virtual
 * file knowledge with real directory entries and falls back to `readFile` on
 * disk for paths that are not injected.
 */
export interface HybridFileSystem extends FileSystem {
  readonly virtualFiles: ReadonlyMap<string, string>
}

export const createHybridFileSystem = (files: Record<string, string>): HybridFileSystem => {
  const virtualFiles = new Map<string, string>(Object.entries(files))
  const virtualFileNames = new Set(virtualFiles.keys())

  const virtualNamesInDirectory = (directoryName: string): readonly string[] => {
    const names: string[] = []
    for (const [path] of virtualFiles) {
      if (dirname(path) === directoryName) {
        names.push(basename(path))
      }
    }
    return names
  }

  const readFile: FileSystem["readFile"] = (fileName) => {
    const injected = virtualFiles.get(fileName)
    if (injected !== undefined) return injected
    try {
      return readFileSync(fileName, "utf8")
    } catch {
      return undefined
    }
  }

  const fileExists: FileSystem["fileExists"] = (fileName) => {
    if (virtualFileNames.has(fileName)) return true
    try {
      return statSync(fileName).isFile()
    } catch {
      return false
    }
  }

  const directoryExists: FileSystem["directoryExists"] = (directoryName) => {
    try {
      return statSync(directoryName).isDirectory()
    } catch {
      return false
    }
  }

  const getAccessibleEntries: FileSystem["getAccessibleEntries"] = (directoryName) => {
    try {
      const entries = readdirSync(directoryName, { withFileTypes: true })
      const files = new Set(entries.filter((entry) => entry.isFile()).map((entry) => entry.name))
      const directories = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)
      for (const name of virtualNamesInDirectory(directoryName)) {
        files.add(name)
      }
      return { files: [...files], directories }
    } catch {
      return undefined
    }
  }

  return {
    readFile,
    fileExists,
    directoryExists,
    getAccessibleEntries,
    realpath: (path) => path,
    virtualFiles,
  }
}
