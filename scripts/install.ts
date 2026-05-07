#!/usr/bin/env bun

import { existsSync, mkdirSync } from "node:fs"
import { arch, homedir, platform } from "node:os"
import { join, resolve } from "node:path"

const REPO_ROOT = resolve(import.meta.dir, "..")
const INSTALL_DIR = process.env.INSTALL_DIR || join(homedir(), ".local", "bin")
const BINARY_NAME = "quartz"
const DESTINATION = join(INSTALL_DIR, BINARY_NAME)

const detectPlatform = (): string => {
  const os = platform()
  const cpu = arch()

  let platformStr: string
  switch (os) {
    case "darwin":
      platformStr = "darwin"
      break
    case "linux":
      platformStr = "linux"
      break
    default:
      console.error(`Unsupported operating system: ${os}`)
      process.exit(1)
  }

  let archStr: string
  switch (cpu) {
    case "x64":
      archStr = "x64"
      break
    case "arm64":
      archStr = "arm64"
      break
    default:
      console.error(`Unsupported architecture: ${cpu}`)
      process.exit(1)
  }

  return `${platformStr}-${archStr}`
}

const main = async (): Promise<void> => {
  const platformArch = detectPlatform()
  console.log(`Detected platform: ${platformArch}`)

  const binaryPath = join(REPO_ROOT, "dist", `quartz-${platformArch}`)
  if (!existsSync(binaryPath)) {
    console.error(`Binary not found: ${binaryPath}`)
    console.error("Run 'bun run build:cli' first to build the local CLI binary.")
    process.exit(1)
  }

  mkdirSync(INSTALL_DIR, { recursive: true })

  console.log(`Installing to ${DESTINATION}...`)
  await Bun.$`cp ${binaryPath} ${DESTINATION}`
  await Bun.$`chmod +x ${DESTINATION}`

  if (platform() === "darwin") {
    await Bun.$`codesign --sign - --force ${DESTINATION}`
    console.log("Binary signed (ad-hoc)")
  }

  console.log(`\nInstalled ${BINARY_NAME} to ${DESTINATION}`)

  const pathDirs = (process.env.PATH || "").split(":")
  if (!pathDirs.includes(INSTALL_DIR)) {
    console.log(`
Note: ${INSTALL_DIR} is not in your PATH.
Add it to your shell configuration:

  export PATH="$HOME/.local/bin:$PATH"
`)
  }

  console.log(`\nRun '${BINARY_NAME} capabilities' to get started.`)
}

await main()
