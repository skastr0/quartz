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

  it("adds an unopened temporary file without mutating the base revision", async () => {
    const fixture = createFixture("export const count = 1\n")
    const workspace = await openQuartzWorkspace(fixture.root)
    try {
      const temporaryPath = join(fixture.root, "src", "__quartz_temp_add.ts")
      const before = workspace.metadata.revision
      const seen = await workspace.withVirtualFile(
        workspace.configFile,
        temporaryPath,
        "export const temporary = 1 as const\n",
        async (project, filePath) => {
          const source = await project.program.getSourceFile(filePath)
          expect(source?.fileName).toBe(filePath)
          return filePath
        },
      )
      expect(seen).toBe(temporaryPath)
      expect(workspace.metadata.revision).toBe(before)
      // Base diagnostics still come from the original file only.
      expect(await workspace.diagnostics()).toEqual([])
    } finally {
      await workspace.close()
    }
  })

  it("replaces an existing file temporarily and restores the base view after", async () => {
    const fixture = createFixture("export const count: number = 1\n")
    const workspace = await openQuartzWorkspace(fixture.root)
    try {
      expect(await workspace.diagnostics()).toEqual([])
      const temporaryErrors = await workspace.withVirtualFile(
        workspace.configFile,
        fixture.sourcePath,
        "export const count: string = 1\n",
        async (project) => collectSemanticCodes(project, fixture.sourcePath),
      )
      expect(temporaryErrors).toContain(2322)
      expect(await workspace.diagnostics()).toEqual([])
      expect(workspace.metadata.revision).toBe(1)
    } finally {
      await workspace.close()
    }
  })

  it("isolates concurrent temporary operations deterministically", async () => {
    const fixture = createFixture("export const base = 1\n")
    const workspace = await openQuartzWorkspace(fixture.root)
    try {
      const a = join(fixture.root, "src", "__quartz_a.ts")
      const b = join(fixture.root, "src", "__quartz_b.ts")
      const [codeA, codeB] = await Promise.all([
        workspace.withVirtualFile(
          workspace.configFile,
          a,
          "export const a: string = 1\n",
          async (project, filePath) => collectSemanticCodes(project, filePath),
        ),
        workspace.withVirtualFile(
          workspace.configFile,
          b,
          "export const b: number = 1\n",
          async (project, filePath) => collectSemanticCodes(project, filePath),
        ),
      ])
      expect(codeA).toContain(2322)
      expect(codeB).not.toContain(2322)
      expect(workspace.metadata.revision).toBe(1)
      expect(await workspace.diagnostics()).toEqual([])
    } finally {
      await workspace.close()
    }
  })

  it("keeps each interleaved operation on its leased revision", async () => {
    const fixture = createFixture("export const revision = 'one' as const\n")
    const workspace = await openQuartzWorkspace(fixture.root)
    const enteredA = Promise.withResolvers<void>()
    const resumeA = Promise.withResolvers<void>()
    const enteredB = Promise.withResolvers<void>()
    const resumeB = Promise.withResolvers<void>()
    try {
      const operationA = workspace.withProject(async (_project, revision) => {
        expect(revision).toBe(1)
        enteredA.resolve()
        await resumeA.promise
        return workspace.withVirtualFile(
          workspace.configFile,
          join(fixture.root, "src", "__quartz_nested.ts"),
          "export const nested = true\n",
          async (project) => (await project.program.getSourceFile(fixture.sourcePath))?.text,
        )
      })

      await enteredA.promise
      writeFileSync(fixture.sourcePath, "export const revision = 'two' as const\n")
      expect((await workspace.refresh({ changed: [fixture.sourcePath] })).revision).toBe(2)

      const operationB = workspace.withProject(async (_project, revision) => {
        expect(revision).toBe(2)
        enteredB.resolve()
        await resumeB.promise
      })
      await enteredB.promise
      resumeA.resolve()
      await expect(operationA).resolves.toContain("'one'")
      resumeB.resolve()
      await operationB
    } finally {
      resumeA.resolve()
      resumeB.resolve()
      await workspace.close()
    }
  })

  it("falls back to the current revision for detached descendants", async () => {
    const fixture = createFixture("export const revision = 'one' as const\n")
    const workspace = await openQuartzWorkspace(fixture.root)
    const triggerDescendant = Promise.withResolvers<void>()
    let descendant: Promise<string | undefined> | undefined
    try {
      await workspace.withProject(async (_project, revision) => {
        expect(revision).toBe(1)
        descendant = triggerDescendant.promise.then(() =>
          workspace.withVirtualFile(
            workspace.configFile,
            join(fixture.root, "src", "__quartz_detached.ts"),
            "export const detached = true\n",
            async (project) => (await project.program.getSourceFile(fixture.sourcePath))?.text,
          )
        )
      })

      writeFileSync(fixture.sourcePath, "export const revision = 'two' as const\n")
      expect((await workspace.refresh({ changed: [fixture.sourcePath] })).revision).toBe(2)
      triggerDescendant.resolve()
      await expect(descendant).resolves.toContain("'two'")
    } finally {
      await workspace.close()
    }
  })

  it("surfaces temporary callback failures without leaking into later commands", async () => {
    const fixture = createFixture("export const ok = 1\n")
    const workspace = await openQuartzWorkspace(fixture.root)
    try {
      const temporaryPath = join(fixture.root, "src", "__quartz_fail.ts")
      await expect(
        workspace.withVirtualFile(workspace.configFile, temporaryPath, "export const x = 1\n", async () => {
          throw new Error("synthetic failure")
        }),
      ).rejects.toMatchObject({ code: "WORKSPACE_REFRESH_FAILED" })

      expect(workspace.metadata.revision).toBe(1)
      expect(await workspace.diagnostics()).toEqual([])
      await workspace.withVirtualFile(
        workspace.configFile,
        temporaryPath,
        "export const recovered = true\n",
        async (project, filePath) => {
          expect(await project.program.getSourceFile(filePath)).toBeDefined()
        },
      )
    } finally {
      await workspace.close()
    }
  })

  it("rejects temporary work after disposal", async () => {
    const fixture = createFixture("export const ok = 1\n")
    const workspace = await openQuartzWorkspace(fixture.root)
    await workspace.close()
    await expect(
      workspace.withVirtualFile(
        workspace.configFile,
        join(fixture.root, "src", "__quartz_closed.ts"),
        "export const x = 1\n",
        async () => "nope",
      ),
    ).rejects.toMatchObject({ code: "WORKSPACE_CLOSED" })
  })
})

const collectSemanticCodes = async (project: import("typescript/unstable/async").Project, filePath: string) => {
  const diagnostics = await project.program.getSemanticDiagnostics(filePath)
  return diagnostics.map((diagnostic) => diagnostic.code)
}
