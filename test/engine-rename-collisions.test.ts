import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { createTypeAnalyzer } from "../packages/engine/src"

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const createProject = (files: Record<string, string>): string => {
  const root = mkdtempSync(join(tmpdir(), "quartz-rename-collision-"))
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

// Renaming Repo to Core merges a generic class into the existing non-generic interface:
// `tsc` reports TS2428 ("All declarations of 'Core' must have identical type parameters")
// and TS2314 ("Generic type 'Core<T>' requires 1 type argument(s)") on the renamed file.
// refactor-preview only flags declaration files and out-of-package files, so it reports
// safe: true with no predicted errors. This is independent of the compiler backend.
const collidingSource = [
  "export interface Core { id: string }",
  "export type CoreKey = keyof Core",
  "export class Repo<T extends Core> { items: T[] = [] }",
].join("\n")

describe("refactor-preview rename collisions", () => {
  it("treats a rename to an unused name as safe", async () => {
    const analyzer = await createTypeAnalyzer(createProject({ "core.ts": collidingSource }))
    try {
      const preview = await analyzer.previewRefactor({ action: "rename", symbol: "Repo", to: "Repository" })
      expect(preview.totalLocations).toBe(1)
      expect(preview.safe).toBe(true)
      expect(preview.predictedErrors).toEqual([])
    } finally {
      await analyzer.dispose()
    }
  })

  // Known defect: flip to a plain `it` once rename previews detect name collisions.
  it.fails("does not report a rename onto an existing declaration as safe", async () => {
    const analyzer = await createTypeAnalyzer(createProject({ "core.ts": collidingSource }))
    try {
      const preview = await analyzer.previewRefactor({ action: "rename", symbol: "Repo", to: "Core" })
      expect(preview.safe).toBe(false)
      expect(preview.predictedErrors.length).toBeGreaterThan(0)
    } finally {
      await analyzer.dispose()
    }
  })

  it.fails("does not report a rename onto a name declared in another file as safe", async () => {
    const analyzer = await createTypeAnalyzer(
      createProject({
        "a.ts": "export interface Taken { id: string }",
        "b.ts": "import type { Taken } from './a'\nexport interface Free { taken: Taken }",
      }),
    )
    try {
      const preview = await analyzer.previewRefactor({ action: "rename", symbol: "Free", to: "Taken" })
      expect(preview.safe).toBe(false)
    } finally {
      await analyzer.dispose()
    }
  })
})
