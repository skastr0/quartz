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

// The checker stores symbol-keyed members under escaped names such as `__@iterator@100`.
// The numeric suffix is a per-program id (tsrs @93 vs TS-Go @137 for the same query), so
// output must render the member the way source writes it: `[Symbol.iterator]`.
const source = [
  "export const tuple = [1, 'a', true] as const",
  "declare const brand: unique symbol",
  "export interface Branded { readonly [brand]: true; value: string }",
].join("\n")

describe("symbol-keyed member names", () => {
  it("lists ordinary members by their source name", async () => {
    const analyzer = await createTypeAnalyzer(createProject(source))
    try {
      const related = await analyzer.findRelated("tuple")
      expect(related?.references.map((reference) => reference.symbol)).toContain("toString")
    } finally {
      await analyzer.dispose()
    }
  })

  it("renders well-known symbols in related as [Symbol.name]", async () => {
    const analyzer = await createTypeAnalyzer(createProject(source))
    try {
      const related = await analyzer.findRelated("tuple")
      const symbols = related?.references.map((reference) => reference.symbol) ?? []
      expect(symbols.filter((symbol) => symbol.includes("__@"))).toEqual([])
      expect(symbols).toContain("[Symbol.iterator]")
      const contexts = related?.references.map((reference) => reference.context) ?? []
      expect(contexts).toContain('property "[Symbol.iterator]"')
    } finally {
      await analyzer.dispose()
    }
  })

  it("renders well-known symbols and unique-symbol keys in info properties", async () => {
    const analyzer = await createTypeAnalyzer(createProject(source))
    try {
      const names = (await analyzer.getTypeInfo("tuple"))?.properties?.map((property) => property.name) ?? []
      expect(names.filter((name) => name.includes("__@"))).toEqual([])
      expect(names).toContain("[Symbol.iterator]")
      const branded = (await analyzer.getTypeInfo("Branded"))?.properties?.map((property) => property.name) ?? []
      expect(branded).toContain("[brand]")
    } finally {
      await analyzer.dispose()
    }
  })
})
