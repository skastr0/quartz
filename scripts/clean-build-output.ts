#!/usr/bin/env bun

import { rm } from "node:fs/promises"
import { basename, isAbsolute, relative, resolve } from "node:path"

const REPO_ROOT = resolve(import.meta.dir, "..")
const targets = {
  engine: resolve(REPO_ROOT, "packages", "engine", "dist"),
  "opencode-plugin": resolve(REPO_ROOT, "apps", "opencode-plugin", "dist"),
} as const

const targetName = Bun.argv[2] as keyof typeof targets | undefined
const target = targetName === undefined ? undefined : targets[targetName]
if (target === undefined) {
  throw new Error(`Unknown build output "${targetName ?? ""}". Expected one of: ${Object.keys(targets).join(", ")}`)
}

const repoRelative = relative(REPO_ROOT, target)
if (repoRelative.length === 0 || isAbsolute(repoRelative) || repoRelative.startsWith("..") || basename(target) !== "dist") {
  throw new Error(`Refusing to clean unsafe build output: ${target}`)
}

await rm(target, { recursive: true, force: true })
