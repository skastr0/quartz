#!/usr/bin/env bun
/**
 * Nightly canary: install current typescript@next into a temp workspace, compile
 * Quartz against it, and run the regression guard. The default is isolated;
 * --update writes the exact validated pin and lockfile back to the repository.
 * Failures report declaration diffs and the upstream commit range when available.
 *
 * Usage: bun scripts/nightly-canary.ts [--update]
 * Env:   QUARTZ_CANARY_TAG=next (default)
 */
import { execFileSync, spawnSync } from "node:child_process"
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const REPO_ROOT = resolve(import.meta.dir, "..")
const TAG = process.env.QUARTZ_CANARY_TAG ?? "next"
const UPDATE_PIN = process.argv.includes("--update")
const PIN_MANIFESTS = [
  "package.json",
  "packages/engine/package.json",
  "packages/npm/quartz-darwin-arm64/package.json",
  "packages/npm/quartz-darwin-x64/package.json",
  "packages/npm/quartz-linux-arm64/package.json",
  "packages/npm/quartz-linux-x64/package.json",
] as const
const DECLARATION_FILES = [
  "dist/api/async/api.d.ts",
  "dist/api/async/types.d.ts",
  "dist/api/proto.d.ts",
  "dist/api/proto.generated.d.ts",
  "dist/api/node/protocol.d.ts",
  "dist/api/node/protocol.generated.d.ts",
  "dist/ast/index.d.ts",
  "dist/ast/ast.d.ts",
  "dist/ast/ast.generated.d.ts",
  "dist/ast/factory.generated.d.ts",
  "dist/ast/is.d.ts",
  "dist/ast/is.generated.d.ts",
  "dist/ast/visitor.d.ts",
  "dist/ast/visitor.generated.d.ts",
] as const

const run = (label: string, command: string, args: readonly string[], cwd: string): void => {
  process.stderr.write(`[canary] ${label}\n`)
  const result = spawnSync(command, [...args], { cwd, stdio: "inherit", env: process.env })
  if (result.status !== 0) {
    throw new Error(`${label} failed with exit ${result.status ?? "null"}`)
  }
}

const readJson = (path: string): Record<string, unknown> =>
  JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>

const rewritePin = (root: string, pinned: string, candidate: string): void => {
  for (const file of PIN_MANIFESTS) {
    const manifestPath = join(root, file)
    const text = readFileSync(manifestPath, "utf8")
    if (!text.includes(pinned)) throw new Error(`${file} does not contain the repository TypeScript pin ${pinned}`)
    if (candidate !== pinned) writeFileSync(manifestPath, text.split(pinned).join(candidate))
  }
}

const declarationDiff = (work: string, file: string): string | null => {
  const pinnedFile = join(REPO_ROOT, "node_modules/typescript", file)
  const candidateFile = join(work, "node_modules/typescript", file)
  if (!existsSync(pinnedFile) || !existsSync(candidateFile)) {
    return `Declaration availability changed: pinned=${existsSync(pinnedFile)} candidate=${existsSync(candidateFile)}`
  }
  const result = spawnSync("diff", ["-u", pinnedFile, candidateFile], { encoding: "utf8" })
  if (result.status === 0) return null
  return result.stdout || result.stderr || `diff exited with ${result.status ?? "null"}`
}

const main = async (): Promise<void> => {
  const resolvedPinned = (readJson(join(REPO_ROOT, "package.json")).devDependencies as Record<string, string>)
    .typescript
  if (resolvedPinned === undefined) throw new Error("package.json does not contain a TypeScript devDependency pin")
  const pinned: string = resolvedPinned
  rewritePin(REPO_ROOT, pinned, pinned)
  process.stderr.write(`[canary] repository pin: ${pinned}\n`)
  process.stderr.write(`[canary] probing npm typescript@${TAG}\n`)

  const view = execFileSync("npm", ["view", `typescript@${TAG}`, "version", "gitHead", "--json"], {
    encoding: "utf8",
  })
  const meta = JSON.parse(view) as { version?: string; gitHead?: string } | Array<{ version?: string; gitHead?: string }>
  const latest = Array.isArray(meta) ? meta[meta.length - 1]! : meta
  const resolvedCandidateVersion = latest.version
  const candidateHead = latest.gitHead
  if (resolvedCandidateVersion === undefined) throw new Error(`Could not resolve typescript@${TAG}`)
  const candidateVersion: string = resolvedCandidateVersion

  process.stderr.write(`[canary] candidate: ${candidateVersion} gitHead=${candidateHead ?? "unknown"}\n`)

  if (candidateVersion === pinned) {
    process.stdout.write(
      `${JSON.stringify({ ok: true, status: "pin_current", pinned, candidate: candidateVersion }, null, 2)}\n`,
    )
    return
  }

  const work = mkdtempSync(join(tmpdir(), "quartz-canary-"))
  process.stderr.write(`[canary] worktree: ${work}\n`)
  try {
    // Copy sources needed to compile/test without mutating the real tree.
    for (const entry of [
      "apps",
      "packages",
      "payloads",
      "scripts",
      "test",
      "tsconfig.json",
      "vitest.config.ts",
      "package.json",
      "bun.lock",
      "LICENSE",
    ]) {
      const from = join(REPO_ROOT, entry)
      if (!existsSync(from)) continue
      cpSync(from, join(work, entry), { recursive: true })
    }

    rewritePin(work, pinned, candidateVersion)

    run("bun install (canary pin)", "bun", ["install"], work)
    const declarationDiffs = DECLARATION_FILES.flatMap((file) => {
      const diff = declarationDiff(work, file)
      return diff === null ? [] : [{ file, diff }]
    })

    let failure: string | null = null
    try {
      run("typecheck", "bun", ["run", "typecheck"], work)
      run("build", "bun", ["run", "build"], work)
      run("native engine tests", "bun", ["run", "verify:native-engine"], work)
      run("regression guard", "bun", ["run", "verify:regression-guard"], work)
      run("package boundaries", "bun", ["run", "verify:package-boundaries"], work)
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error)
    }

    const pinnedHead = (() => {
      try {
        const raw = execFileSync("npm", ["view", `typescript@${pinned}`, "gitHead", "--json"], { encoding: "utf8" })
        const parsed = JSON.parse(raw) as string | { gitHead?: string }
        return typeof parsed === "string" ? parsed : parsed.gitHead ?? null
      } catch {
        return null
      }
    })()

    const compareUrl =
      pinnedHead !== null && candidateHead !== undefined
        ? `https://github.com/microsoft/typescript-go/compare/${pinnedHead}...${candidateHead}`
        : null

    if (failure === null && UPDATE_PIN) {
      rewritePin(REPO_ROOT, pinned, candidateVersion)
      run("update repository lockfile", "bun", ["install"], REPO_ROOT)
    }

    process.stdout.write(
      `${JSON.stringify(
        {
          ok: failure === null,
          status: failure === null
            ? UPDATE_PIN ? "candidate_passed_and_pinned" : "candidate_passed"
            : "candidate_failed",
          pinned,
          candidate: candidateVersion,
          candidateGitHead: candidateHead ?? null,
          pinnedGitHead: pinnedHead,
          compareUrl,
          failure,
          declarationDiffPresent: declarationDiffs.length > 0,
          declarationDiffFiles: declarationDiffs.map(({ file }) => file),
          declarationDiffPreviews: declarationDiffs.slice(0, 8).map(({ file, diff }) => ({
            file,
            preview: diff.slice(0, 2000),
          })),
        },
        null,
        2,
      )}\n`,
    )
    if (failure !== null) process.exitCode = 2
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 2
})
