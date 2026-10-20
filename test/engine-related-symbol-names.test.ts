import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { createTypeAnalyzer } from "../packages/engine/src"

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const createProject = (source: string): string => {
  const root = mkdtempSync(join(tmpdir(), "quartz-related-names-"))
  roots.push(root)
  mkdirSync(join(root, "src"), { recursive: true })
  writeFileSync(
    join(root, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: { target: "ES2022", module: "ESNext", moduleResolution: "Bundler", strict: true, skipLibCheck: true },
      include: ["src"],
    }),
  )
  writeFileSync(join(root, "src", "values.ts"), source)
  return root
}

// related reports well-known-symbol members under the checker's escaped name, for example
// `__@iterator@100`. The numeric suffix is a per-program symbol id: it differs between
// compiler backends (tsrs vs TS-Go: @93 vs @137 for the same query) and between programs.
describe("related symbol names", () => {
  it("lists ordinary members by their source name", async () => {
    const analyzer = await createTypeAnalyzer(createProject("export const tuple = [1, 'a', true] as const"))
    try {
      const related = await analyzer.findRelated("tuple")
      expect(related?.references.map((reference) => reference.symbol)).toContain("toString")
    } finally {
      await analyzer.dispose()
    }
  })

  // Known defect: flip to a plain `it` once well-known symbols render as `[Symbol.iterator]`.
  it.fails("does not expose checker-internal escaped symbol names", async () => {
    const analyzer = await createTypeAnalyzer(createProject("export const tuple = [1, 'a', true] as const"))
    try {
      const related = await analyzer.findRelated("tuple")
      const internal = related?.references.filter((reference) => /^__@/.test(reference.symbol))
      expect(internal).toEqual([])
    } finally {
      await analyzer.dispose()
    }
  })
})
