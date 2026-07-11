import { isAbsolute, normalize, relative, resolve, sep } from "node:path"
import { Effect } from "effect"
import type { Node, SourceFile } from "typescript/unstable/ast"
import type { Program } from "typescript/unstable/sync"
import { discoverPackages, type PackageInfo } from "../discovery"
import { QuartzError } from "../errors"

export const resolveNativePackage = (
  rootDirectory: string,
  packageName?: string,
): Effect.Effect<PackageInfo, QuartzError> =>
  discoverPackages(rootDirectory).pipe(
    Effect.flatMap((packages) =>
      Effect.try({
        try: () => {
          if (packageName === undefined) {
            const rootPackage = packages.find((pkg) => pkg.name === "(root)")
            if (rootPackage !== undefined) return rootPackage
            if (packages.length === 1) return packages[0]!
            throw new Error(
              `Multiple packages found. Please specify a package: ${packages.map((pkg) => pkg.name).join(", ")}`,
            )
          }

          const normalizedName = packageName.replace(/^\//, "")
          const packageInfo = packages.find(
            (pkg) =>
              pkg.name === packageName ||
              pkg.name === normalizedName ||
              pkg.path.endsWith(packageName),
          )
          if (packageInfo !== undefined) return packageInfo
          throw new Error(`Package "${packageName}" not found. Available: ${packages.map((pkg) => pkg.name).join(", ")}`)
        },
        catch: (cause) =>
          new QuartzError({
            message: cause instanceof Error ? cause.message : "Could not resolve native TypeScript package",
            cause,
          }),
      }),
    ),
  )

export const findNativeSourceFile = (
  program: Program,
  rootDirectory: string,
  filePath: string,
): SourceFile | undefined => {
  const requested = normalize(isAbsolute(filePath) ? filePath : resolve(rootDirectory, filePath))
  const sourceFileName = program.getSourceFileNames().find((candidate) => {
    const normalizedCandidate = normalize(candidate)
    return normalizedCandidate === requested || normalizedCandidate.endsWith(normalize(filePath))
  })
  return sourceFileName === undefined ? undefined : program.getSourceFile(sourceFileName)
}

export const isWithinPackage = (fileName: string, packageInfo: PackageInfo): boolean => {
  const normalizedFileName = normalize(fileName)
  const normalizedPackagePath = normalize(packageInfo.path)
  return normalizedFileName === normalizedPackagePath || normalizedFileName.startsWith(`${normalizedPackagePath}${sep}`)
}

export const nativeRelativePath = (rootDirectory: string, absolutePath: string): string => {
  const path = relative(resolve(rootDirectory), absolutePath)
  return path === "" ? "." : path
}

export const findNativeNodeAtPosition = (sourceFile: SourceFile, position: number): Node | null => {
  let result: Node | null = null

  const visit = (node: Node): void => {
    if (position < node.getStart() || position > node.getEnd()) return
    result = node
    node.forEachChild(visit)
  }

  sourceFile.forEachChild(visit)
  return result
}

export const toNativeCommandError = (message: string, cause: unknown): QuartzError =>
  cause instanceof QuartzError
    ? cause
    : new QuartzError({
        message: cause instanceof Error ? cause.message : message,
        cause,
      })
