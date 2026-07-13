import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { createTypeAnalyzer } from "../packages/engine/src"

const roots: string[] = []

const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), "quartz-analyzer-"))
  roots.push(root)
  mkdirSync(join(root, "src"))
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
      include: ["src/**/*.ts", ".quartz/**/*.ts"],
    }),
  )
  writeFileSync(
    join(root, "src/index.ts"),
    [
      "export interface User { name: string; age: number }",
      "export interface Named { name: string }",
      "export const toName = (user: User): string => user.name",
      "export const invalid: string = 1",
      "",
    ].join("\n"),
  )
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe("QuartzAnalyzer", () => {
  it("composes native operations over one persistent workspace", async () => {
    const root = fixture()
    const analyzer = await createTypeAnalyzer(root)
    try {
      expect((await analyzer.getPackages()).map((pkg) => pkg.name)).toEqual(["(root)"])
      expect((await analyzer.listSymbols({ pattern: "User" })).symbols.some((symbol) => symbol.name === "User")).toBe(true)
      expect((await analyzer.expandType("User"))?.properties.map((property) => property.name)).toEqual(["name", "age"])
      const diagnostics = await analyzer.getDiagnostics()
      expect(Array.isArray(diagnostics) && diagnostics.some((diagnostic) => diagnostic.code === 2322)).toBe(true)
      expect((await analyzer.checkCompatibility("User", "Named")).compatible).toBe(true)
      expect((await analyzer.transformSearch({ from: "User", to: "string" })).results[0]?.name).toBe("toName")
    } finally {
      await analyzer.dispose()
    }
  })
  it("explains diagnostics, preserves contract evidence, and refreshes lazily", async () => {
    const analyzer = await createTypeAnalyzer(fixture())
    try {
      const explained = await analyzer.getDiagnostics({ explain: true })
      expect("errors" in explained).toBe(true)
      if ("errors" in explained) {
        expect(explained.explained).toBeGreaterThan(0)
        expect(explained.errors[0]?.explanation).not.toBeNull()
      }

      const contract = await analyzer.verifyContract({ from: "User", to: "string" })
      expect(contract.evidence.explanations?.length).toBeGreaterThan(0)

      const revision = analyzer.metadata.revision
      await analyzer.markDirty()
      expect(analyzer.metadata.revision).toBe(revision)
      await analyzer.listSymbols()
      expect(analyzer.metadata.revision).toBeGreaterThan(revision)
      await expect(analyzer.refresh("(root)")).resolves.toBe("Refreshed package (root)")
    } finally {
      await analyzer.dispose()
    }
  })


  it("isolates concurrent virtual snippets and cleans them up", async () => {
    const root = fixture()
    const analyzer = await createTypeAnalyzer(root)
    try {
      const [valid, invalid] = await Promise.all([
        analyzer.checkSnippet("const value: string = 'ok'\n"),
        analyzer.checkSnippet("const value: string = 1\n"),
      ])
      expect(valid).toEqual({ valid: true })
      expect(invalid.valid).toBe(false)
      expect(invalid.errors?.some((error) => error.message.includes("number"))).toBe(true)
      const [declared, leaked] = await Promise.all([
        analyzer.checkSnippet("declare global { interface OnlyA { yes: true } }\nexport {}\n"),
        analyzer.checkSnippet("const onlyB: OnlyA = { yes: true }\n"),
      ])
      expect(declared).toEqual({ valid: true })
      expect(leaked.valid).toBe(false)
      expect(leaked.errors?.some((error) => error.message.includes("Cannot find name 'OnlyA'"))).toBe(true)
      expect(await analyzer.checkSnippet("const after: number = 1\n")).toEqual({ valid: true })
    } finally {
      await analyzer.dispose()
    }
  })

  it("imports package exports for snippets and evaluates arbitrary type expressions", async () => {
    const analyzer = await createTypeAnalyzer(fixture())
    try {
      expect(await analyzer.checkSnippet("const user: User = { name: 'Ada', age: 37 }\n")).toEqual({ valid: true })
      expect(await analyzer.evalType("User[]")).toMatchObject({ result: "User[]" })
      expect(await analyzer.evalType("Promise<User>")).toMatchObject({ result: "Promise<User>" })
      expect(await analyzer.evalType("User | null")).toMatchObject({ result: "User | null" })
      expect((await analyzer.explainType("User[]")).final).toBe("Array<User>")
    } finally {
      await analyzer.dispose()
    }
  })

  it("disposes idempotently and rejects later analysis", async () => {
    const analyzer = await createTypeAnalyzer(fixture())
    await Promise.all([analyzer.dispose(), analyzer.dispose()])
    await expect(analyzer.getPackages()).rejects.toMatchObject({
      code: "WORKSPACE_CLOSED",
    })
    await expect(analyzer.getDiagnostics()).rejects.toMatchObject({
      code: "WORKSPACE_CLOSED",
    })
  })
})
