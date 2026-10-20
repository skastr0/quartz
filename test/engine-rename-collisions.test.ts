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
// tsc reports TS2428 ("All declarations of 'Core' must have identical type parameters")
// and TS2314 ("Generic type 'Core<T>' requires 1 type argument(s)"). previewRefactor applies
// the rename in a layered program and reports the errors it introduces.
const collidingSource = [
  "export interface Core { id: string }",
  "export type CoreKey = keyof Core",
  "export class Repo<T extends Core> { items: T[] = [] }",
].join("\n")

const previewRename = async (files: Record<string, string>, symbol: string, to: string) => {
  const analyzer = await createTypeAnalyzer(createProject(files))
  try {
    return await analyzer.previewRefactor({ action: "rename", symbol, to })
  } finally {
    await analyzer.dispose()
  }
}

const codesOf = (preview: { readonly predictedErrors: readonly { readonly message: string }[] }): string[] =>
  [...new Set(preview.predictedErrors.map((error) => error.message.split(":")[0]!))].sort()

describe("refactor-preview rename collisions", () => {
  it("treats a rename to an unused name as safe", async () => {
    const preview = await previewRename({ "core.ts": collidingSource }, "Repo", "Repository")
    expect(preview.totalLocations).toBe(1)
    expect(preview.safe).toBe(true)
    expect(preview.predictedErrors).toEqual([])
  })

  it("reports the tsc errors of a rename onto an existing declaration", async () => {
    const preview = await previewRename({ "core.ts": collidingSource }, "Repo", "Core")
    expect(preview.safe).toBe(false)
    expect(preview.confidence).toBe("low")
    expect(codesOf(preview)).toEqual(["TS2314", "TS2428"])
    expect(preview.predictedErrors.every((error) => error.file === "src/core.ts")).toBe(true)
  })

  it("reports a rename onto a name an importing file already imports", async () => {
    const preview = await previewRename(
      {
        "a.ts": "export interface Taken { id: string }",
        "b.ts": "import type { Taken } from './a'\nexport interface Free { taken: Taken }",
      },
      "Free",
      "Taken",
    )
    expect(preview.safe).toBe(false)
    expect(preview.predictedErrors).toEqual([
      { file: "src/b.ts", line: 1, message: "TS2440: Import declaration conflicts with local declaration of 'Taken'." },
    ])
  })

  it("reports a renamed import that collides with a local declaration in the importer", async () => {
    const preview = await previewRename(
      {
        "a.ts": "export interface Old { id: string }",
        "b.ts": [
          "import type { Old } from './a'",
          "interface Fresh { z: number }",
          "export const x: Old = { id: 'a' }",
          "export type F = Fresh",
        ].join("\n"),
      },
      "Old",
      "Fresh",
    )
    expect(preview.safe).toBe(false)
    expect(codesOf(preview)).toContain("TS2440")
    expect(preview.predictedErrors.every((error) => error.file === "src/b.ts")).toBe(true)
  })

  it("reports a rename that shadows a global the file still uses", async () => {
    const preview = await previewRename(
      {
        "a.ts": [
          "export interface Widget { id: string }",
          "export const m: Record<string, number> = {}",
          "export const w: Widget = { id: '1' }",
        ].join("\n"),
      },
      "Widget",
      "Record",
    )
    expect(preview.safe).toBe(false)
    expect(preview.predictedErrors).toEqual([
      { file: "src/a.ts", line: 2, message: "TS2315: Type 'Record' is not generic." },
    ])
  })

  it("does not blame the rename for errors the file already had", async () => {
    const preview = await previewRename(
      {
        "a.ts": [
          "export interface Widget { id: string }",
          "export const bad: number = 'x'",
          "export const w: Widget = { id: '1' }",
        ].join("\n"),
      },
      "Widget",
      "Gadget",
    )
    expect(preview.safe).toBe(true)
    expect(preview.predictedErrors).toEqual([])
  })
})
