import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { AnalyzerContext } from "../packages/engine/src/context"
import { createLeafOperations } from "../packages/engine/src/leaf-operations"

const roots: string[] = []

const createFixture = (): { readonly root: string; readonly sourcePath: string } => {
  const root = mkdtempSync(join(tmpdir(), "quartz-leaf-"))
  roots.push(root)
  mkdirSync(join(root, "src"))
  const sourcePath = join(root, "src", "index.ts")
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
  writeFileSync(
    sourcePath,
    [
      "export interface User {",
      "  id: string",
      "  name?: string",
      "}",
      "export interface RequiredUser {",
      "  id: string",
      "  name: string",
      "}",
      "export const user: User = { id: \"one\" }",
      "const privateValue = 1",
      "export const broken: string = 1",
      "",
    ].join("\n"),
  )
  return { root, sourcePath }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe("createLeafOperations", () => {
  it("lists exported symbols with source positions", async () => {
    const fixture = createFixture()
    const context = await AnalyzerContext.open(fixture.root)
    try {
      const result = await createLeafOperations(context).listSymbols({ kind: "interface" })
      expect(result.total).toBe(2)
      expect(result.symbols.map((symbol) => symbol.name)).toEqual(["RequiredUser", "User"])
      expect(result.symbols.every((symbol) => symbol.file === "src/index.ts" && symbol.isIndexExport)).toBe(true)
    } finally {
      await context.close()
    }
  })

  it("expands a type and reports its structural properties", async () => {
    const fixture = createFixture()
    const context = await AnalyzerContext.open(fixture.root)
    try {
      const result = await createLeafOperations(context).expandType("User")
      expect(result).toMatchObject({ original: "User", expanded: "User" })
      expect(result?.properties).toEqual([
        { name: "id", type: "string", from: "src/index.ts" },
        { name: "name", type: "string | undefined", optional: true, from: "src/index.ts" },
      ])
    } finally {
      await context.close()
    }
  })

  it("maps diagnostics to one-based file positions", async () => {
    const fixture = createFixture()
    const context = await AnalyzerContext.open(fixture.root)
    try {
      const diagnostics = await createLeafOperations(context).getDiagnostics()
      expect(diagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 2322, file: "src/index.ts", line: 11, column: 14 }),
      ]))
    } finally {
      await context.close()
    }
  })

  it("checks structural compatibility and reports missing properties", async () => {
    const fixture = createFixture()
    const context = await AnalyzerContext.open(fixture.root)
    try {
      const result = await createLeafOperations(context).checkCompatibility("User", "RequiredUser")
      expect(result.compatible).toBe(false)
      expect(result.issues).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: "type_mismatch", property: "name", expectedType: "string" }),
      ]))
    } finally {
      await context.close()
    }
  })

  it("inspects exported and private file declarations", async () => {
    const fixture = createFixture()
    const context = await AnalyzerContext.open(fixture.root)
    try {
      const operations = createLeafOperations(context)
      const exported = await operations.getFileDeclarations("src/index.ts")
      expect(exported?.declarations.map((declaration) => declaration.name)).toEqual(["broken", "RequiredUser", "user", "User"])
      const withPrivate = await operations.getFileDeclarations("src/index.ts", { includePrivate: true })
      expect(withPrivate?.declarations.map((declaration) => declaration.name)).toContain("privateValue")
    } finally {
      await context.close()
    }
  })
})
