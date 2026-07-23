#!/usr/bin/env bun
/**
 * Isolated nightly canary: install current typescript@next into a temp workspace,
 * compile Quartz against it, and run the regression guard — without updating the
 * repository pin. Failures should report declaration diffs and the upstream
 * commit range when available.
 *
 * Usage: bun scripts/nightly-canary.ts
 * Env:   QUARTZ_CANARY_TAG=next (default)
 */
import { execFileSync, spawnSync } from "node:child_process"
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const REPO_ROOT = resolve(import.meta.dir, "..")
const TAG = process.env.QUARTZ_CANARY_TAG ?? "next"

const run = (label: string, command: string, args: readonly string[], cwd: string): void => {
  process.stderr.write(`[canary] ${label}\n`)
  const result = spawnSync(command, [...args], { cwd, stdio: "inherit", env: process.env })
  if (result.status !== 0) {
    throw new Error(`${label} failed with exit ${result.status ?? "null"}`)
  }
}

const readJson = (path: string): Record<string, unknown> =>
  JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>

const main = async (): Promise<void> => {
  const pinned = (readJson(join(REPO_ROOT, "package.json")).devDependencies as Record<string, string>)
    .typescript
  process.stderr.write(`[canary] repository pin: ${pinned}\n`)
  process.stderr.write(`[canary] probing npm typescript@${TAG}\n`)

  const view = execFileSync("npm", ["view", `typescript@${TAG}`, "version", "gitHead", "--json"], {
    encoding: "utf8",
  })
  const meta = JSON.parse(view) as { version?: string; gitHead?: string } | Array<{ version?: string; gitHead?: string }>
  const latest = Array.isArray(meta) ? meta[meta.length - 1]! : meta
  const candidateVersion = latest.version
  const candidateHead = latest.gitHead
  if (candidateVersion === undefined) throw new Error(`Could not resolve typescript@${TAG}`)

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
    for (const entry of ["apps", "packages", "scripts", "test", "tsconfig.json", "vitest.config.ts", "package.json", "bun.lock"]) {
      const from = join(REPO_ROOT, entry)
      if (!existsSync(from)) continue
      cpSync(from, join(work, entry), { recursive: true })
    }

    const rewritePin = (manifestPath: string): void => {
      if (!existsSync(manifestPath)) return
      const text = readFileSync(manifestPath, "utf8")
      writeFileSync(manifestPath, text.split(pinned!).join(candidateVersion))
    }
    rewritePin(join(work, "package.json"))
    rewritePin(join(work, "packages/engine/package.json"))
    for (const platform of ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"]) {
      rewritePin(join(work, `packages/npm/quartz-${platform}/package.json`))
    }

    run("bun install (canary pin)", "bun", ["install"], work)
    run("typecheck", "bun", ["run", "typecheck"], work)
    run("build", "bun", ["run", "build"], work)
    run("native engine tests", "bun", ["run", "verify:native-engine"], work)
    run("regression guard", "bun", ["run", "verify:regression-guard"], work)

    let declarationDiff: string | null = null
    try {
      declarationDiff = execFileSync(
        "diff",
        [
          "-u",
          join(REPO_ROOT, "node_modules/typescript/dist/api/async/api.d.ts"),
          join(work, "node_modules/typescript/dist/api/async/api.d.ts"),
        ],
        { encoding: "utf8" },
      )
    } catch (error) {
      const err = error as { stdout?: string; status?: number }
      declarationDiff = err.stdout ?? null
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

    process.stdout.write(
      `${JSON.stringify(
        {
          ok: true,
          status: "candidate_passed",
          pinned,
          candidate: candidateVersion,
          candidateGitHead: candidateHead ?? null,
          pinnedGitHead: pinnedHead,
          compareUrl,
          declarationDiffPresent: declarationDiff !== null && declarationDiff.length > 0,
          declarationDiffPreview: declarationDiff?.slice(0, 4000) ?? null,
        },
        null,
        2,
      )}\n`,
    )
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 2
})
