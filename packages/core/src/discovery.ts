import { execFile } from "node:child_process"
import { readdir } from "node:fs/promises"
import { dirname, join, relative } from "node:path"
import { promisify } from "node:util"
import { Effect } from "effect"
import { QuartzError } from "./errors"

const execFileAsync = promisify(execFile)

export interface PackageInfo {
  readonly name: string
  readonly path: string
  readonly tsconfigPath: string
}

const ignoredDirectories = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  ".nuxt",
  ".output",
  "coverage",
  ".turbo",
  ".cache",
])

export const discoverPackages = (rootDirectory: string): Effect.Effect<readonly PackageInfo[], QuartzError> =>
  Effect.gen(function* () {
    const tsconfigPaths = yield* findTsconfigs(rootDirectory)
    return toPackageInfo(rootDirectory, tsconfigPaths)
  })

export const discoverPackagesPromise = (rootDirectory: string): Promise<readonly PackageInfo[]> =>
  findTsconfigsPromise(rootDirectory).then((tsconfigPaths) => toPackageInfo(rootDirectory, tsconfigPaths))

const findTsconfigs = (rootDirectory: string): Effect.Effect<readonly string[], QuartzError> =>
  Effect.gen(function* () {
    const trackedFiles = yield* getGitTrackedFiles(rootDirectory)
    if (trackedFiles.length > 0) {
      return trackedFiles
        .filter((file) => file.endsWith("tsconfig.json") && !file.includes("node_modules"))
        .map((file) => join(rootDirectory, file))
    }

    return yield* walkForTsconfigs(rootDirectory)
  })

const findTsconfigsPromise = async (rootDirectory: string): Promise<readonly string[]> => {
  const trackedFiles = await getGitTrackedFilesPromise(rootDirectory)
  if (trackedFiles.length > 0) {
    return trackedFiles
      .filter((file) => file.endsWith("tsconfig.json") && !file.includes("node_modules"))
      .map((file) => join(rootDirectory, file))
  }

  return walkForTsconfigsPromise(rootDirectory)
}

const getGitTrackedFiles = (rootDirectory: string): Effect.Effect<readonly string[], QuartzError> =>
  Effect.tryPromise({
    try: () => getGitTrackedFilesPromise(rootDirectory),
    catch: () => new QuartzError({ message: "git file discovery failed" }),
  }).pipe(Effect.catchAll(() => Effect.succeed([])))

const getGitTrackedFilesPromise = async (rootDirectory: string): Promise<readonly string[]> => {
  try {
    const { stdout } = await execFileAsync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], {
      cwd: rootDirectory,
    })
    return stdout
      .trim()
      .split("\n")
      .filter((file) => file.length > 0)
  } catch {
    return []
  }
}

const walkForTsconfigs = (directory: string): Effect.Effect<readonly string[], QuartzError> =>
  Effect.gen(function* () {
    const entries = yield* Effect.tryPromise({
      try: () => readdir(directory, { withFileTypes: true }),
      catch: (cause) => new QuartzError({ message: `Could not scan ${directory}`, cause }),
    }).pipe(Effect.catchAll(() => Effect.succeed([])))

    const nested = yield* Effect.forEach(entries, (entry) => {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) {
        return ignoredDirectories.has(entry.name) ? Effect.succeed([]) : walkForTsconfigs(path)
      }
      return Effect.succeed(entry.name === "tsconfig.json" ? [path] : [])
    })

    return nested.flat()
  })

const walkForTsconfigsPromise = async (directory: string): Promise<readonly string[]> => {
  try {
    const entries = await readdir(directory, { withFileTypes: true })
    const nested = await Promise.all(
      entries.map(async (entry) => {
        const path = join(directory, entry.name)
        if (entry.isDirectory()) {
          return ignoredDirectories.has(entry.name) ? [] : walkForTsconfigsPromise(path)
        }
        return entry.name === "tsconfig.json" ? [path] : []
      }),
    )
    return nested.flat()
  } catch {
    return []
  }
}

const toPackageInfo = (rootDirectory: string, tsconfigPaths: readonly string[]): readonly PackageInfo[] =>
  tsconfigPaths
    .map((tsconfigPath) => {
      const packagePath = dirname(tsconfigPath)
      const relativePath = relative(rootDirectory, packagePath)
      return {
        name: relativePath === "" ? "(root)" : relativePath,
        path: packagePath,
        tsconfigPath,
      }
    })
    .sort((a, b) => {
      if (a.name === "(root)") return -1
      if (b.name === "(root)") return 1
      return a.name.localeCompare(b.name)
    })
