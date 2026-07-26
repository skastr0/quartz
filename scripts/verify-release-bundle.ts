#!/usr/bin/env bun

import { cp, mkdtemp, readFile, rename, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const REPO_ROOT = resolve(import.meta.dir, "..")
const DIST_DIR = join(REPO_ROOT, "dist")
const hostTarget = `${process.platform}-${process.arch}`
const supportedTargets = new Set(["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"])

interface RootManifest {
  readonly version?: string
  readonly devDependencies?: Record<string, string>
}

interface CliRun {
  readonly status: number
  readonly stdout: string
  readonly stderr: string
}

interface DoctorData {
  readonly version?: string
  readonly analysis_typescript_version?: string
  readonly ok?: boolean
  readonly package_count?: number
}

const runCapture = async (command: readonly string[], cwd: string): Promise<CliRun> => {
  const env: Record<string, string | undefined> = {
    ...process.env,
    QUARTZ_HOME: join(cwd, ".quartz-home"),
  }
  delete env.NODE_PATH
  const proc = Bun.spawn([...command], {
    cwd,
    env,
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, status] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { status, stdout: stdout.trim(), stderr: stderr.trim() }
}

const parseEnvelope = (text: string): Record<string, unknown> => {
  const line = text.split("\n").filter((part) => part.trim().length > 0).at(-1)
  if (line === undefined) throw new Error("Quartz did not emit a JSON envelope")
  return JSON.parse(line) as Record<string, unknown>
}

const verifyArchiveShape = async (
  archive: string,
  bundleName: string,
  nativePackageRelative: string,
  work: string,
): Promise<void> => {
  const listing = await runCapture(["tar", "-tzf", archive], work)
  if (listing.status !== 0) throw new Error(`Could not inspect ${archive}: ${listing.stderr}`)
  const entries = listing.stdout.split("\n").filter((entry) => entry.length > 0)
  const outsideRoot = entries.some(
    (entry) =>
      entry.startsWith("/")
      || entry.split("/").includes("..")
      || (entry !== `${bundleName}/` && !entry.startsWith(`${bundleName}/`)),
  )
  if (outsideRoot) throw new Error("Release archive must contain one relative top-level directory")

  const verboseListing = await runCapture(["tar", "-tvzf", archive], work)
  if (verboseListing.status !== 0) throw new Error(`Could not inspect archive modes: ${verboseListing.stderr}`)
  if (verboseListing.stdout.split("\n").some((entry) => entry.startsWith("l"))) {
    throw new Error("Release archive must not contain symbolic links")
  }

  for (const required of [
    `${bundleName}/bin/quartz`,
    `${bundleName}/LICENSE`,
    `${bundleName}/${nativePackageRelative}/package.json`,
    `${bundleName}/${nativePackageRelative}/lib/tsc`,
  ]) {
    if (!entries.includes(required)) throw new Error(`Release archive is missing ${required}`)
  }
}

const verifyNativePackage = async (
  nativePackageRoot: string,
  nativePackageName: string,
  typescriptVersion: string,
): Promise<void> => {
  const nativeManifest = JSON.parse(
    await readFile(join(nativePackageRoot, "package.json"), "utf8"),
  ) as { readonly name?: string; readonly version?: string }
  if (
    nativeManifest.name !== `@typescript/${nativePackageName}`
    || nativeManifest.version !== typescriptVersion
  ) {
    throw new Error(`Release archive contains the wrong native TypeScript payload for ${hostTarget}`)
  }
}

const verifyDoctor = async (
  binary: string,
  payload: string,
  work: string,
  quartzVersion: string,
  typescriptVersion: string,
): Promise<void> => {
  const result = await runCapture([binary, "doctor", payload, "--format", "json"], work)
  const envelope = parseEnvelope(result.stdout)
  const data = envelope.data as DoctorData | undefined
  if (
    result.status !== 0
    || envelope.ok !== true
    || envelope.command !== "doctor"
    || data?.version !== quartzVersion
    || data.analysis_typescript_version !== typescriptVersion
    || data.ok !== true
    || data.package_count !== 1
  ) {
    throw new Error(`Extracted release smoke failed: ${result.stderr || result.stdout}`)
  }
}

const verifyMissingPayloadFailure = async (
  binary: string,
  payload: string,
  nativePackageRoot: string,
  work: string,
): Promise<void> => {
  await rename(nativePackageRoot, `${nativePackageRoot}.missing`)
  const result = await runCapture([binary, "diagnostics", payload, "--format", "json"], work)
  const envelope = parseEnvelope(result.stderr)
  const error = envelope.error as
    | { readonly type?: string; readonly details?: { readonly code?: string } }
    | undefined
  if (
    result.status !== 1
    || envelope.ok !== false
    || error?.type !== "QuartzEngineError"
    || error.details?.code !== "WORKSPACE_OPEN_FAILED"
  ) {
    throw new Error(`Missing-payload smoke did not fail closed: ${result.stderr || result.stdout}`)
  }
}

const main = async (): Promise<void> => {
  if (!supportedTargets.has(hostTarget)) throw new Error(`Unsupported release host: ${hostTarget}`)
  const manifest = JSON.parse(await readFile(join(REPO_ROOT, "package.json"), "utf8")) as RootManifest
  const quartzVersion = manifest.version
  const typescriptVersion = manifest.devDependencies?.typescript
  if (quartzVersion === undefined) throw new Error("Root package version is missing")
  if (typescriptVersion === undefined) throw new Error("Root TypeScript pin is missing")

  const bundleName = `quartz-${quartzVersion}-${hostTarget}`
  const archive = join(DIST_DIR, `${bundleName}.tar.gz`)
  const nativePackageName = `typescript-${hostTarget}`
  const nativePackageRelative = join("node_modules", "@typescript", nativePackageName)
  const work = await mkdtemp(join(tmpdir(), "quartz-release-smoke-"))

  try {
    await verifyArchiveShape(archive, bundleName, nativePackageRelative, work)
    const extraction = await runCapture(["tar", "-xzf", archive, "-C", work], work)
    if (extraction.status !== 0) throw new Error(`Could not extract ${archive}: ${extraction.stderr}`)

    const bundleRoot = join(work, bundleName)
    const binary = join(bundleRoot, "bin", "quartz")
    const nativePackageRoot = join(bundleRoot, nativePackageRelative)
    await verifyNativePackage(nativePackageRoot, nativePackageName, typescriptVersion)

    const fixture = join(work, "fixture")
    await cp(join(REPO_ROOT, "test", "fixtures"), fixture, { recursive: true })
    const payload = JSON.stringify({ root: fixture })
    await verifyDoctor(binary, payload, work, quartzVersion, typescriptVersion)
    await verifyMissingPayloadFailure(binary, payload, nativePackageRoot, work)

    process.stdout.write(
      `${JSON.stringify(
        {
          ok: true,
          archive,
          target: hostTarget,
          typescriptVersion,
          positive: "doctor_passed",
          negative: "WORKSPACE_OPEN_FAILED",
        },
        null,
        2,
      )}\n`,
    )
  } finally {
    await rm(work, { recursive: true, force: true })
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
