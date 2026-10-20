import { readFile, stat } from "node:fs/promises"
import type { Project } from "tsrs/unstable/async"
import { mapBounded } from "./concurrency"
import { projectDiskView, type DiskView } from "./workspace"

/** Files above this size, and bytes beyond the total budget, are left to the snapshot's trees. */
const MAX_FILE_BYTES = 4 * 1024 * 1024
const MAX_RETAINED_BYTES = 256 * 1024 * 1024
const READ_FAN_OUT = 64

export interface DiskIndex {
  /** The files that may mention `needle`, in the order given; files the disk cannot vouch for are always kept. */
  readonly candidates: (needle: string, fileNames: readonly string[]) => readonly string[]
}

/** Text that is safe to search with a UTF-8 needle: not UTF-16, not binary, no `\u` identifier escapes. */
const searchable = (buffer: Buffer): boolean => {
  if (buffer.length >= 2 && ((buffer[0] === 0xff && buffer[1] === 0xfe) || (buffer[0] === 0xfe && buffer[1] === 0xff))) return false
  if (buffer.subarray(0, 1024).includes(0)) return false
  return !buffer.includes("\\u")
}

const readIfUnchanged = async (fileName: string, view: DiskView): Promise<Buffer | undefined> => {
  if (view.volatile.has(fileName)) return undefined
  try {
    const info = await stat(fileName)
    // Modified after the snapshot read it (or too close to tell): the snapshot's tree is the truth.
    if (!info.isFile() || info.mtimeMs > view.trustedAt || info.size > MAX_FILE_BYTES) return undefined
    const buffer = await readFile(fileName)
    return searchable(buffer) ? buffer : undefined
  } catch {
    return undefined
  }
}

const build = async (fileNames: readonly string[], view: DiskView): Promise<DiskIndex> => {
  const texts = new Map<string, Buffer>()
  let retained = 0
  await mapBounded(fileNames, READ_FAN_OUT, async (fileName) => {
    const buffer = await readIfUnchanged(fileName, view)
    if (buffer === undefined || retained + buffer.length > MAX_RETAINED_BYTES) return
    retained += buffer.length
    texts.set(fileName, buffer)
  })
  return {
    candidates: (needle, names) => {
      if (needle.length === 0) return names
      return names.filter((name) => {
        const buffer = texts.get(name)
        return buffer === undefined || buffer.includes(needle)
      })
    },
  }
}

const indexes = new WeakMap<object, Promise<DiskIndex | null>>()

/**
 * Disk text for the files of a base snapshot that provably match it, so a scan for a name can
 * skip fetching the trees of files that cannot mention it. Null when the project is not a base
 * snapshot (temporary snapshots carry overlays the disk does not have).
 */
export const diskIndexFor = (project: Project, fileNames: readonly string[]): Promise<DiskIndex | null> => {
  const view = projectDiskView(project)
  if (view === undefined) return Promise.resolve(null)
  let index = indexes.get(project)
  if (index === undefined) {
    index = build(fileNames, view)
    indexes.set(project, index)
  }
  return index
}
