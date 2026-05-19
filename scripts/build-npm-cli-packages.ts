#!/usr/bin/env bun

import { chmod, copyFile, mkdir } from "node:fs/promises"
import { join, resolve } from "node:path"

const REPO_ROOT = resolve(import.meta.dir, "..")
const LICENSE_PATH = join(REPO_ROOT, "LICENSE")

const npmPackageDirs = [
  "packages/npm/quartz",
  "packages/npm/quartz-darwin-arm64",
  "packages/npm/quartz-darwin-x64",
  "packages/npm/quartz-linux-arm64",
  "packages/npm/quartz-linux-x64",
] as const

const platformPackages = [
  { target: "darwin-arm64", packageDir: "packages/npm/quartz-darwin-arm64" },
  { target: "darwin-x64", packageDir: "packages/npm/quartz-darwin-x64" },
  { target: "linux-arm64", packageDir: "packages/npm/quartz-linux-arm64" },
  { target: "linux-x64", packageDir: "packages/npm/quartz-linux-x64" },
] as const

const run = async (label: string, command: ReadonlyArray<string>): Promise<void> => {
  console.log(`\n${label}`)
  const proc = Bun.spawn([...command], {
    cwd: REPO_ROOT,
    stdout: "inherit",
    stderr: "inherit",
  })
  const exitCode = await proc.exited
  if (exitCode !== 0) {
    console.error(`${label} failed with exit code ${exitCode}`)
    process.exit(exitCode)
  }
}

await run("Building standalone CLI binaries", ["bun", "run", "build:cli"])

for (const packageDir of npmPackageDirs) {
  await copyFile(LICENSE_PATH, join(REPO_ROOT, packageDir, "LICENSE"))
}

for (const { target, packageDir } of platformPackages) {
  const source = join(REPO_ROOT, "dist", `quartz-${target}`)
  const binDir = join(REPO_ROOT, packageDir, "bin")
  const destination = join(binDir, "quartz")

  await mkdir(binDir, { recursive: true })
  await copyFile(source, destination)
  await chmod(destination, 0o755)

  console.log(`Copied ${source} -> ${destination}`)
}
