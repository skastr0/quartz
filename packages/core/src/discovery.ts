import { execFileSync } from "node:child_process"
import { readdirSync } from "node:fs"
import { dirname, join, relative } from "node:path"
import { Effect } from "effect"
import { QuartzError } from "./errors"

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
  Effect.try({
    try: () => discoverPackagesSync(rootDirectory),
    catch: (cause) =>
      new QuartzError({
        message: cause instanceof Error ? cause.message : "Could not discover TypeScript packages",
        cause,
      }),
  })

export const discoverPackagesSync = (rootDirectory: string): readonly PackageInfo[] =>
  toPackageInfo(rootDirectory, findTsconfigs(rootDirectory))

const findTsconfigs = (rootDirectory: string): readonly string[] => {
  const trackedFiles = getGitTrackedFiles(rootDirectory)
  if (trackedFiles.length > 0) {
    return trackedFiles
      .filter((file) => file.endsWith("tsconfig.json") && !file.includes("node_modules"))
      .map((file) => join(rootDirectory, file))
  }

  return walkForTsconfigs(rootDirectory)
}

const getGitTrackedFiles = (rootDirectory: string): readonly string[] => {
  try {
    const stdout = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], {
      cwd: rootDirectory,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })
    return stdout
      .trim()
      .split("\n")
      .filter((file) => file.length > 0)
  } catch {
    return []
  }
}

const walkForTsconfigs = (directory: string): readonly string[] => {
  const entries = readdirSync(directory, { withFileTypes: true })
  const nested = entries.map((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      return ignoredDirectories.has(entry.name) ? [] : walkForTsconfigs(path)
    }
    return entry.name === "tsconfig.json" ? [path] : []
  })
  return nested.flat()
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
