import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { openQuartzWorkspace, QuartzEngineError } from "../packages/engine/src"

const roots: string[] = []

const createFixture = (source: string): { readonly root: string; readonly sourcePath: string } => {
  const root = mkdtempSync(join(tmpdir(), "quartz-engine-"))
  roots.push(root)
  const sourceDirectory = join(root, "src")
  const sourcePath = join(sourceDirectory, "index.ts")
  mkdirSync(sourceDirectory)
  writeFileSync(
    join(root, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        module: "ESNext",
        moduleResolution: "Bundler",
        noEmit: true,
        strict: true,
        target: "ESNext",
      },
      include: ["src/**/*.ts"],
    }),
  )
  writeFileSync(sourcePath, source)
  return { root, sourcePath }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe("QuartzWorkspace", () => {
  it("opens a native project and returns positioned diagnostics", async () => {
    const fixture = createFixture("export const count: string = 1\n")
    const workspace = await openQuartzWorkspace(fixture.root)
    try {
      const diagnostics = await workspace.diagnostics()
      const mismatch = diagnostics.find((diagnostic) => diagnostic.code === 2322)

      expect(mismatch).toMatchObject({
        file: fixture.sourcePath,
        line: 1,
        column: 14,
        code: 2322,
        severity: "error",
      })
      expect(mismatch?.message).toContain("number")
      expect(workspace.metadata).toMatchObject({
        root: fixture.root,
        revision: 1,
        closed: false,
      })
      expect(workspace.metadata.analysisTypescriptVersion).toMatch(/^7\./)
    } finally {
      await workspace.close()
    }
  })

  it("refreshes changed files into a new revision", async () => {
    const fixture = createFixture("export const count: string = 1\n")
    const workspace = await openQuartzWorkspace(fixture.root)
    try {
      expect((await workspace.diagnostics()).some((diagnostic) => diagnostic.code === 2322)).toBe(true)

      writeFileSync(fixture.sourcePath, "export const count: string = 'one'\n")
      const metadata = await workspace.refresh({ changed: [fixture.sourcePath] })

      expect(metadata.revision).toBe(2)
      expect((await workspace.diagnostics()).some((diagnostic) => diagnostic.code === 2322)).toBe(false)
    } finally {
      await workspace.close()
    }
  })

  it("closes idempotently and rejects later work", async () => {
    const fixture = createFixture("export const count = 1\n")
    const workspace = await openQuartzWorkspace(fixture.root)

    await Promise.all([workspace.close(), workspace.close()])

    expect(workspace.metadata.closed).toBe(true)
    await expect(workspace.diagnostics()).rejects.toMatchObject({
      code: "WORKSPACE_CLOSED",
    })
  })
})
