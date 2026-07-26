#!/usr/bin/env bun

import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join, resolve } from "node:path"

const REPO_ROOT = resolve(import.meta.dir, "..")
const DIST_DIR = join(REPO_ROOT, "dist")
const LICENSE_PATH = join(REPO_ROOT, "LICENSE")

const targets = ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"] as const
type Target = (typeof targets)[number]

interface RootManifest {
  readonly version?: string
  readonly devDependencies?: Record<string, string>
}

interface PackedPackage {
  readonly filename?: string
}

interface NativePackageManifest {
  readonly name?: string
  readonly version?: string
  readonly os?: readonly string[]
  readonly cpu?: readonly string[]
}

const parseTargets = (args: readonly string[]): readonly Target[] => {
  const selected: Target[] = []
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg !== "--target") throw new Error(`Unknown argument: ${arg}`)
    const value = args[index + 1]
    if (value === undefined || !targets.includes(value as Target)) {
      throw new Error(`--target must be one of: ${targets.join(", ")}`)
    }
    selected.push(value as Target)
    index += 1
  }
  return selected.length === 0 ? targets : [...new Set(selected)]
}

const run = async (
  label: string,
  command: readonly string[],
  cwd: string,
  env: Record<string, string | undefined> = process.env,
): Promise<string> => {
  const proc = Bun.spawn([...command], {
    cwd,
    env,
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  if (exitCode !== 0) {
    throw new Error(`${label} failed with exit ${exitCode}${stderr.length === 0 ? "" : `\n${stderr.trim()}`}`)
  }
  return stdout
}

const rejectSymlinks = async (root: string): Promise<void> => {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    if (entry.isSymbolicLink()) throw new Error(`Native payload contains a symbolic link: ${path}`)
    if (entry.isDirectory()) await rejectSymlinks(path)
  }
}

const validateNativePackage = async (
  packageRoot: string,
  target: Target,
  version: string,
): Promise<void> => {
  const [platform, arch] = target.split("-") as [string, string]
  const expectedName = `@typescript/typescript-${target}`
  const manifest = JSON.parse(
    await readFile(join(packageRoot, "package.json"), "utf8"),
  ) as NativePackageManifest

  if (
    manifest.name !== expectedName
    || manifest.version !== version
    || !manifest.os?.includes(platform)
    || !manifest.cpu?.includes(arch)
  ) {
    throw new Error(
      `Packed native payload mismatch for ${target}: expected ${expectedName}@${version} (${platform}/${arch})`,
    )
  }

  await rejectSymlinks(packageRoot)
  const executable = join(packageRoot, "lib", platform === "win32" ? "tsc.exe" : "tsc")
  await chmod(executable, 0o755)
}

const main = async (): Promise<void> => {
  const selectedTargets = parseTargets(Bun.argv.slice(2))
  const rootManifest = JSON.parse(await readFile(join(REPO_ROOT, "package.json"), "utf8")) as RootManifest
  const quartzVersion = rootManifest.version
  const typescriptVersion = rootManifest.devDependencies?.typescript
  if (quartzVersion === undefined) throw new Error("Root package version is missing")
  if (typescriptVersion === undefined) throw new Error("Root TypeScript pin is missing")

  const work = await mkdtemp(join(tmpdir(), "quartz-release-bundles-"))
  try {
    for (const target of selectedTargets) {
      const bundleName = `quartz-${quartzVersion}-${target}`
      const bundleRoot = join(work, bundleName)
      const nativePackageName = `typescript-${target}`
      const nativePackageRoot = join(bundleRoot, "node_modules", "@typescript", nativePackageName)
      const binarySource = join(DIST_DIR, `quartz-${target}`)
      const binaryDestination = join(bundleRoot, "bin", "quartz")
      const packDirectory = join(work, `pack-${target}`)

      await mkdir(join(bundleRoot, "bin"), { recursive: true })
      await mkdir(nativePackageRoot, { recursive: true })
      await mkdir(packDirectory, { recursive: true })
      await copyFile(binarySource, binaryDestination)
      await chmod(binaryDestination, 0o755)
      await copyFile(LICENSE_PATH, join(bundleRoot, "LICENSE"))

      const packageSpec = `@typescript/${nativePackageName}@${typescriptVersion}`
      const packOutput = await run(
        `Packing ${packageSpec}`,
        ["npm", "pack", packageSpec, "--json", "--ignore-scripts", "--pack-destination", packDirectory],
        REPO_ROOT,
      )
      const packed = JSON.parse(packOutput) as readonly PackedPackage[]
      const tarball = packed[0]?.filename
      if (tarball === undefined || basename(tarball) !== tarball) {
        throw new Error(`npm pack did not report a safe tarball name for ${packageSpec}`)
      }

      await run(
        `Extracting ${packageSpec}`,
        ["tar", "-xzf", join(packDirectory, tarball), "--strip-components=1", "-C", nativePackageRoot],
        REPO_ROOT,
      )
      await validateNativePackage(nativePackageRoot, target, typescriptVersion)

      const archive = join(DIST_DIR, `${bundleName}.tar.gz`)
      await run(
        `Archiving ${bundleName}`,
        ["tar", "-czf", archive, "-C", work, bundleName],
        REPO_ROOT,
        { ...process.env, COPYFILE_DISABLE: "1" },
      )
      process.stdout.write(`${archive}\n`)
      await rm(bundleRoot, { recursive: true, force: true })
      await rm(packDirectory, { recursive: true, force: true })
    }
  } finally {
    await rm(work, { recursive: true, force: true })
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
