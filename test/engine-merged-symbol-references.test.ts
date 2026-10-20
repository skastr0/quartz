import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { createTypeAnalyzer } from "../packages/engine/src"

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const createProject = (files: Record<string, string>): string => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "quartz-merged-references-")))
  roots.push(root)
  mkdirSync(join(root, "src"), { recursive: true })
  writeFileSync(
    join(root, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: { target: "ES2022", module: "ESNext", moduleResolution: "Bundler", strict: true, skipLibCheck: true },
      include: ["src"],
    }),
  )
  for (const [name, text] of Object.entries(files)) writeFileSync(join(root, "src", name), text)
  return root
}

// `export const Sig` and `export type Sig` are one merged symbol, but the compiler's reference
// search returns value-position and type-position references separately depending on which
// declaration it starts from. Starting only from the first declaration misses every use in
// type position, so a rename preview lists the import but not `Sig | null`.
const mergedFiles = {
  "a.ts": [
    "export const Sig = { kind: 'sig' } as const",
    "export type Sig = typeof Sig",
  ].join("\n"),
  "b.ts": [
    "import { Sig } from './a'",
    "export const typed: Sig | null = null",
    "export const value = Sig",
    "export const list: readonly Sig[] = []",
  ].join("\n"),
}

describe("merged value and type symbols", () => {
  it("lists type-position and value-position rename sites of an imported merged symbol", async () => {
    const analyzer = await createTypeAnalyzer(createProject(mergedFiles))
    try {
      const preview = await analyzer.previewRefactor({ action: "rename", symbol: "Sig", to: "Signal" })
      const lines = preview.locations.filter((location) => location.file === "src/b.ts").map((location) => location.line)
      expect(lines).toEqual([1, 2, 3, 4])
      expect(preview.totalLocations).toBe(7)
      expect(preview.predictedErrors).toEqual([])
      expect(preview.safe).toBe(true)
    } finally {
      await analyzer.dispose()
    }
  })

  it("lists type-position uses among the incoming references", async () => {
    const analyzer = await createTypeAnalyzer(createProject(mergedFiles))
    try {
      const related = await analyzer.findRelated("Sig")
      const lines = related?.referencedBy.filter((reference) => reference.file === "src/b.ts").map((reference) => reference.line)
      expect(lines).toContain(2)
      expect(lines).toContain(4)
    } finally {
      await analyzer.dispose()
    }
  })

  it("keeps a single-declaration symbol at one search per declaration kind", async () => {
    const analyzer = await createTypeAnalyzer(
      createProject({
        "a.ts": "export interface Plain { id: string }",
        "b.ts": "import type { Plain } from './a'\nexport const p: Plain = { id: '1' }",
      }),
    )
    try {
      const preview = await analyzer.previewRefactor({ action: "rename", symbol: "Plain", to: "Simple" })
      expect(preview.totalLocations).toBe(3)
      expect(preview.safe).toBe(true)
    } finally {
      await analyzer.dispose()
    }
  })
})
