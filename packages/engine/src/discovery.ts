import { execFileSync } from "node:child_process"
import { basename, dirname, join, relative, resolve } from "node:path"
import { readdirSync } from "node:fs"
import type { PackageInfo } from "./contracts"
import { QuartzEngineError } from "./errors"

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

export const discoverPackages = (
  rootDirectory: string,
  selectedTsconfigPaths?: readonly string[],
): readonly PackageInfo[] => {
  const resolvedRoot = resolve(rootDirectory)
  try {
    const tsconfigPaths =
      selectedTsconfigPaths === undefined
        ? findTsconfigs(resolvedRoot)
        : selectedTsconfigPaths.map((tsconfigPath) => resolve(resolvedRoot, tsconfigPath))
    return toPackageInfo(resolvedRoot, tsconfigPaths)
  } catch (cause) {
    throw new QuartzEngineError(
      "WORKSPACE_OPEN_FAILED",
      `Could not discover TypeScript packages under ${resolvedRoot}`,
      cause,
    )
  }
}

const findTsconfigs = (rootDirectory: string): readonly string[] => {
  const trackedFiles = getGitTrackedFiles(rootDirectory)
  if (trackedFiles.length > 0) {
    return trackedFiles
      .filter((file) => basename(file) === "tsconfig.json" && !file.includes("node_modules"))
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

const walkForTsconfigs = (directory: string): readonly string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return ignoredDirectories.has(entry.name) ? [] : walkForTsconfigs(path)
    return entry.name === "tsconfig.json" ? [path] : []
  })

const toPackageInfo = (rootDirectory: string, tsconfigPaths: readonly string[]): readonly PackageInfo[] =>
  [...new Set(tsconfigPaths.map((tsconfigPath) => resolve(rootDirectory, tsconfigPath)))]
    .map((tsconfigPath) => {
      const packagePath = dirname(tsconfigPath)
      const relativePath = relative(rootDirectory, packagePath)
      return {
        name: relativePath === "" ? "(root)" : relativePath,
        path: packagePath,
        tsconfigPath,
      }
    })
    .sort((left, right) => {
      if (left.name === "(root)") return -1
      if (right.name === "(root)") return 1
      return left.name.localeCompare(right.name)
    })
