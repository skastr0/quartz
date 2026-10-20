#!/usr/bin/env bun

import { cp, mkdtemp, readFile, rename, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const REPO_ROOT = resolve(import.meta.dir, "..")
const DIST_DIR = join(REPO_ROOT, "dist")
const hostTarget = `${process.platform}-${process.arch}`
const supportedTargets = new Set(["darwin-arm64", "linux-arm64", "linux-x64"])

// tsrs publishes one package per platform, GNU-suffixed on Linux, and no Intel macOS build.
const nativePackageNameFor = (target: string): string => {
  const [os, cpu] = target.split("-") as [string, string]
  return `@tsrs/${os}-${cpu}${os === "linux" ? "-gnu" : ""}`
}

interface RootManifest {
  readonly version?: string
  readonly devDependencies?: Record<string, string>
}

interface TsrsManifest {
  readonly name?: string
  readonly version?: string
  readonly tsrs?: { readonly typescriptVersion?: string }
}

interface CliRun {
  readonly status: number
  readonly stdout: string
  readonly stderr: string
}

interface DoctorData {
  readonly version?: string
  readonly backend?: string
  readonly tsrs_version?: string
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
    `${bundleName}/${nativePackageRelative}/tsrs`,
  ]) {
    if (!entries.includes(required)) throw new Error(`Release archive is missing ${required}`)
  }
}

const cString = (bytes: Uint8Array, start: number, length: number): string => {
  const field = Buffer.from(bytes.subarray(start, start + length))
  const end = field.indexOf(0)
  return field.subarray(0, end === -1 ? field.length : end).toString("latin1")
}

// Extended attributes live in pax ("x") headers, not in file payloads. The compiled CLI
// embeds libarchive, whose strings include the same markers, so only header records count.
const verifyArchiveMetadata = async (archive: string): Promise<void> => {
  const tar = Bun.gunzipSync(await readFile(archive))
  let offset = 0
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512)
    if (header.every((byte) => byte === 0)) return
    const sizeField = cString(header, 124, 12).trim()
    const size = sizeField === "" ? 0 : Number.parseInt(sizeField, 8)
    if (!Number.isFinite(size) || size < 0) throw new Error(`Release archive has an unreadable header at byte ${offset}`)
    const typeflag = String.fromCharCode(header[156] ?? 0)
    const dataStart = offset + 512
    if (typeflag === "x" || typeflag === "g") {
      const payload = Buffer.from(tar.subarray(dataStart, dataStart + size)).toString("latin1")
      for (const marker of ["LIBARCHIVE.xattr.", "SCHILY.xattr."]) {
        if (payload.includes(marker)) {
          throw new Error(`Release archive carries extended attribute headers (${marker}); rebuild with --no-xattrs`)
        }
      }
    }
    offset = dataStart + Math.ceil(size / 512) * 512
  }
}

const verifyNativePackage = async (
  nativePackageRoot: string,
  nativePackageName: string,
  tsrsVersion: string,
): Promise<void> => {
  const nativeManifest = JSON.parse(
    await readFile(join(nativePackageRoot, "package.json"), "utf8"),
  ) as { readonly name?: string; readonly version?: string }
  if (
    nativeManifest.name !== nativePackageName
    || nativeManifest.version !== tsrsVersion
  ) {
    throw new Error(`Release archive contains the wrong native tsrs payload for ${hostTarget}`)
  }
}

const verifyDoctor = async (
  binary: string,
  payload: string,
  work: string,
  quartzVersion: string,
  tsrsVersion: string,
  typescriptVersion: string,
): Promise<void> => {
  const result = await runCapture([binary, "doctor", payload, "--format", "json"], work)
  const envelope = parseEnvelope(result.stdout)
  const data = envelope.data as DoctorData | undefined
  if (
    result.status !== 0
    || envelope.ok !== true
    || envelope.command !== "doctor"
    || envelope.backend !== "tsrs"
    || envelope.tsrs_version !== tsrsVersion
    || data?.version !== quartzVersion
    || data.backend !== "tsrs"
    || data.tsrs_version !== tsrsVersion
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
  const tsrsVersion = manifest.devDependencies?.tsrs
  if (quartzVersion === undefined) throw new Error("Root package version is missing")
  if (tsrsVersion === undefined) throw new Error("Root tsrs pin is missing")
  const installedTsrs = JSON.parse(
    await readFile(join(REPO_ROOT, "node_modules", "tsrs", "package.json"), "utf8"),
  ) as TsrsManifest
  const typescriptVersion = installedTsrs.tsrs?.typescriptVersion
  if (installedTsrs.version !== tsrsVersion || typescriptVersion === undefined) {
    throw new Error(`node_modules/tsrs is ${installedTsrs.version ?? "missing"}; run bun install for tsrs@${tsrsVersion}`)
  }

  const bundleName = `quartz-${quartzVersion}-${hostTarget}`
  const archive = join(DIST_DIR, `${bundleName}.tar.gz`)
  const nativePackageName = nativePackageNameFor(hostTarget)
  const nativePackageRelative = join("node_modules", ...nativePackageName.split("/"))
  const work = await mkdtemp(join(tmpdir(), "quartz-release-smoke-"))

  try {
    await verifyArchiveShape(archive, bundleName, nativePackageRelative, work)
    await verifyArchiveMetadata(archive)
    const extraction = await runCapture(["tar", "-xzf", archive, "-C", work], work)
    if (extraction.status !== 0) throw new Error(`Could not extract ${archive}: ${extraction.stderr}`)

    const bundleRoot = join(work, bundleName)
    const binary = join(bundleRoot, "bin", "quartz")
    const nativePackageRoot = join(bundleRoot, nativePackageRelative)
    await verifyNativePackage(nativePackageRoot, nativePackageName, tsrsVersion)

    const fixture = join(work, "fixture")
    await cp(join(REPO_ROOT, "test", "fixtures"), fixture, { recursive: true })
    const payload = JSON.stringify({ root: fixture })
    await verifyDoctor(binary, payload, work, quartzVersion, tsrsVersion, typescriptVersion)
    await verifyMissingPayloadFailure(binary, payload, nativePackageRoot, work)

    process.stdout.write(
      `${JSON.stringify(
        {
          ok: true,
          archive,
          target: hostTarget,
          tsrsVersion,
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
