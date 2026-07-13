import { readdirSync, readFileSync, realpathSync, statSync, type Dirent } from "node:fs"
import { basename, dirname, join, resolve } from "node:path"
import type { FileSystem } from "typescript/unstable/fs"

export interface HybridFileSystem extends FileSystem {
  readonly virtualFiles: Map<string, string>
}

type EntryKind = "file" | "directory"

const entryKind = (directoryName: string, entry: Dirent): EntryKind | undefined => {
  if (entry.isFile()) return "file"
  if (entry.isDirectory()) return "directory"
  if (!entry.isSymbolicLink()) return undefined
  try {
    const target = statSync(join(directoryName, entry.name))
    if (target.isFile()) return "file"
    if (target.isDirectory()) return "directory"
  } catch {
    return undefined
  }
  return undefined
}

export const createHybridFileSystem = (): HybridFileSystem => {
  const virtualFiles = new Map<string, string>()
  const virtualAt = (path: string): string | undefined => virtualFiles.get(resolve(path))

  return {
    virtualFiles,
    readFile: (fileName) => {
      const injected = virtualAt(fileName)
      if (injected !== undefined) return injected
      try {
        return readFileSync(fileName, "utf8")
      } catch {
        return undefined
      }
    },
    fileExists: (fileName) => {
      if (virtualAt(fileName) !== undefined) return true
      try {
        return statSync(fileName).isFile()
      } catch {
        return false
      }
    },
    directoryExists: (directoryName) => {
      const resolvedDirectory = resolve(directoryName)
      if ([...virtualFiles].some(([fileName]) => dirname(fileName) === resolvedDirectory)) return true
      try {
        return statSync(directoryName).isDirectory()
      } catch {
        return false
      }
    },
    getAccessibleEntries: (directoryName) => {
      const resolvedDirectory = resolve(directoryName)
      const files = new Set<string>()
      const directories = new Set<string>()
      try {
        for (const entry of readdirSync(directoryName, { withFileTypes: true })) {
          const kind = entryKind(directoryName, entry)
          if (kind === "file") files.add(entry.name)
          else if (kind === "directory") directories.add(entry.name)
        }
      } catch {
        // A virtual-only directory can still be enumerated below.
      }
      for (const [fileName] of virtualFiles) {
        if (dirname(fileName) === resolvedDirectory) files.add(basename(fileName))
      }
      return files.size === 0 && directories.size === 0 ? undefined : { files: [...files], directories: [...directories] }
    },
    realpath: (path) => {
      const resolvedPath = resolve(path)
      if (virtualFiles.has(resolvedPath)) return resolvedPath
      try {
        return realpathSync.native(path)
      } catch {
        return undefined
      }
    },
  }
}
