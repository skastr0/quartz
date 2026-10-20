import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { AnalyzerContext } from "../packages/engine/src/context"
import { createReferenceOperations } from "../packages/engine/src/reference-operations"
import { projectDiskView } from "../packages/engine/src/workspace"

const HOUR = 3600
const longAgo = () => Date.now() / 1000 - HOUR
const later = () => Date.now() / 1000 + HOUR

const write = (file: string, text: string, seconds: number): void => {
  writeFileSync(file, text)
  utimesSync(file, seconds, seconds)
}

/**
 * Files are aged before opening so the snapshot may trust their disk text. Unless the consumer uses
 * Alpha, model.ts is the only file that spells it, so a wrongly trusted disk text loses the answer.
 */
const createFixture = async (consumerUsesAlpha = false) => {
  const root = mkdtempSync(join(tmpdir(), "quartz-engine-disk-"))
  mkdirSync(join(root, "src"), { recursive: true })
  write(
    join(root, "tsconfig.json"),
    JSON.stringify({ compilerOptions: { target: "ESNext", module: "ESNext", moduleResolution: "Bundler", strict: true, skipLibCheck: true }, include: ["src/**/*.ts"] }),
    longAgo(),
  )
  const model = join(root, "src", "model.ts")
  write(model, "export interface Alpha { id: string }\n", longAgo())
  write(
    join(root, "src", "consumer.ts"),
    consumerUsesAlpha ? "import type { Alpha } from './model'\nexport const a: Alpha = { id: '1' }\n" : "export const a: number = 1\n",
    longAgo(),
  )
  write(join(root, "src", "unrelated.ts"), "export const nothing = 1\n", longAgo())
  const context = await AnalyzerContext.open(root)
  return { root, model, context, operations: createReferenceOperations(context) }
}

const fetchedFiles = (context: AnalyzerContext): string[] => {
  const fetched: string[] = []
  const workspace = context.workspace
  const original = workspace.withProject.bind(workspace)
  workspace.withProject = (operation, configFile) =>
    original(async (project, revision) => {
      const getSourceFile = project.program.getSourceFile.bind(project.program)
      Object.defineProperty(project.program, "getSourceFile", {
        configurable: true,
        value: (file: string) => {
          fetched.push(file)
          return getSourceFile(file)
        },
      })
      return operation(project, revision)
    }, configFile)
  return fetched
}

describe("engine disk prefilter", () => {
  it("does not fetch trees of files that cannot mention the name", async () => {
    const { context, operations } = await createFixture(true)
    const fetched = fetchedFiles(context)
    try {
      expect(await operations.findRelated("Alpha")).not.toBeNull()
      expect(fetched.some((file) => file.endsWith("unrelated.ts"))).toBe(false)
      expect(fetched.some((file) => file.endsWith("model.ts"))).toBe(true)
    } finally {
      await context.close()
    }
  })

  it("answers from the snapshot when a file is edited after it was opened", async () => {
    const { model, context, operations } = await createFixture()
    try {
      write(model, "export interface Beta { id: string }\n", later())
      // The snapshot still has Alpha even though the disk no longer mentions it.
      expect(await operations.findRelated("Alpha")).not.toBeNull()
      expect(await operations.findRelated("Beta")).toBeNull()
    } finally {
      await context.close()
    }
  })

  it("follows the disk at a full refresh and the snapshot for later edits", async () => {
    const { model, context, operations } = await createFixture()
    try {
      write(model, "export interface Beta { id: string }\n", later())
      await context.refresh()
      // Edit before the first lookup of this revision, so nothing is answered from a cache.
      write(model, "export interface Alpha { id: string }\n", later() + HOUR)
      expect(await operations.findRelated("Beta")).not.toBeNull()
      expect(await operations.findRelated("Alpha")).toBeNull()
    } finally {
      await context.close()
    }
  })

  it("never trusts files named in a partial refresh, and re-trusts everything after a full one", async () => {
    const { model, context } = await createFixture()
    try {
      const viewOf = () => context.workspace.withProject(async (project) => projectDiskView(project))
      const opened = await viewOf()
      expect(opened?.volatile.size).toBe(0)

      await context.refresh({ changed: [model] })
      const partial = await viewOf()
      expect(partial?.volatile.has(model)).toBe(true)
      expect(partial?.trustedAt).toBe(opened?.trustedAt)

      await context.refresh()
      const full = await viewOf()
      expect(full?.volatile.size).toBe(0)
      expect(full?.trustedAt).toBeGreaterThan(opened?.trustedAt ?? Number.POSITIVE_INFINITY)
    } finally {
      await context.close()
    }
  })
})
