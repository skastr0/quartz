import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, relative, resolve } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { AnalyzerContext } from "../packages/engine/src/context"
import { discoverPackages } from "../packages/engine/src/discovery"
import { QuartzEngineError } from "../packages/engine/src/errors"
import { createLeafOperations } from "../packages/engine/src/leaf-operations"

const roots: string[] = []

const writeProject = (root: string, configPath: string, sourcePath: string, symbol: string): void => {
  const absoluteConfig = resolve(root, configPath)
  const absoluteSource = resolve(root, sourcePath)
  mkdirSync(dirname(absoluteConfig), { recursive: true })
  mkdirSync(dirname(absoluteSource), { recursive: true })
  writeFileSync(
    absoluteConfig,
    JSON.stringify({
      compilerOptions: {
        module: "ESNext",
        moduleResolution: "Bundler",
        noEmit: true,
        strict: true,
        target: "ESNext",
      },
      include: [relative(dirname(absoluteConfig), absoluteSource)],
    }),
  )
  writeFileSync(absoluteSource, `export const ${symbol} = 1\n`)
}

const createRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), "quartz-package-resolution-"))
  roots.push(root)
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe("AnalyzerContext package resolution", () => {
  it("uses an explicit tsconfigPath for default symbol operations", async () => {
    const root = createRoot()
    writeProject(root, "tsconfig.json", "root.ts", "rootSymbol")
    writeProject(root, "custom/tsconfig.json", "custom/custom.ts", "customSymbol")

    const context = await AnalyzerContext.open(root, { tsconfigPath: "custom/tsconfig.json" })
    try {
      expect(context.package()).toMatchObject({ name: "custom", tsconfigPath: resolve(root, "custom/tsconfig.json") })
      const result = await createLeafOperations(context).listSymbols()
      expect(result.symbols.map((symbol) => symbol.name)).toContain("customSymbol")
      expect(result.symbols.map((symbol) => symbol.name)).not.toContain("rootSymbol")
    } finally {
      await context.close()
    }
  })

  it("preserves explicit extra tsconfigPaths as packages in one workspace", async () => {
    const root = createRoot()
    writeProject(root, "tsconfig.json", "root.ts", "rootSymbol")
    writeProject(root, "extra/project-config.json", "extra/extra.ts", "extraSymbol")

    const context = await AnalyzerContext.open(root, { tsconfigPaths: ["extra/project-config.json"] })
    try {
      const extraPath = resolve(root, "extra/project-config.json")
      expect(context.packages).toEqual(
        expect.arrayContaining([expect.objectContaining({ name: "extra", tsconfigPath: extraPath })]),
      )
      expect(context.workspace.metadata.configFiles).toContain(extraPath)
      const result = await createLeafOperations(context).listSymbols({ packageName: "extra" })
      expect(result.symbols.map((symbol) => symbol.name)).toContain("extraSymbol")
    } finally {
      await context.close()
    }
  })

  it("rejects omitted and empty package selectors for ambiguous workspaces without a root", async () => {
    const root = createRoot()
    writeProject(root, "packages/alpha/tsconfig.json", "packages/alpha/alpha.ts", "alphaSymbol")
    writeProject(root, "packages/beta/tsconfig.json", "packages/beta/beta.ts", "betaSymbol")

    const context = await AnalyzerContext.open(root)
    try {
      expect(() => context.package()).toThrowError(/Multiple packages found/)
      expect(() => context.package("")).toThrowError(/Multiple packages found/)
      await expect(createLeafOperations(context).listSymbols()).rejects.toMatchObject({
        code: "WORKSPACE_OPEN_FAILED",
      })
    } finally {
      await context.close()
    }
  })

  it("resolves exact, path-suffix, and leading-slash package selectors", async () => {
    const root = createRoot()
    writeProject(root, "packages/alpha/tsconfig.json", "packages/alpha/alpha.ts", "alphaSymbol")
    const context = await AnalyzerContext.open(root)
    try {
      const expectedPath = resolve(root, "packages/alpha/tsconfig.json")
      expect(context.package("packages/alpha").tsconfigPath).toBe(expectedPath)
      expect(context.package("alpha").tsconfigPath).toBe(expectedPath)
      expect(context.package("/packages/alpha").tsconfigPath).toBe(expectedPath)
    } finally {
      await context.close()
    }
  })

  it("reports a missing root as a typed workspace-open failure", async () => {
    const missingRoot = join(tmpdir(), `quartz-missing-${Date.now()}-${Math.random()}`)
    await expect(AnalyzerContext.open(missingRoot)).rejects.toMatchObject({
      name: "QuartzEngineError",
      code: "WORKSPACE_OPEN_FAILED",
    })
  })

  it("only discovers files whose basename is exactly tsconfig.json", () => {
    const root = createRoot()
    writeProject(root, "tsconfig.json", "root.ts", "rootSymbol")
    writeProject(root, "mytsconfig.json", "ignored.ts", "ignoredSymbol")

    const packages = discoverPackages(root)
    expect(packages).toHaveLength(1)
    expect(packages[0]?.tsconfigPath).toBe(resolve(root, "tsconfig.json"))
  })
})
