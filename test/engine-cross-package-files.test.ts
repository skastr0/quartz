import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { createTypeAnalyzer } from "../packages/engine/src"

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const compilerOptions = { target: "ES2022", module: "ESNext", moduleResolution: "Bundler", strict: true, skipLibCheck: true }

// packages/app re-exports an interface declared in packages/lib, which it reaches as a
// workspace dependency through node_modules (TypeScript flags such files as external-library
// files even though they are workspace source). symbols and info scoped to packages/app
// report the declaration at packages/lib/src/actor.ts, so file and at-position scoped to
// packages/app must open that same path too.
const createMonorepo = (): string => {
  // realpath: TypeScript resolves the node_modules symlink to the real path, which must sit under the root.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "quartz-cross-package-")))
  roots.push(root)
  for (const name of ["app", "lib"]) {
    mkdirSync(join(root, "packages", name, "src"), { recursive: true })
    writeFileSync(join(root, "packages", name, "tsconfig.json"), JSON.stringify({ compilerOptions, include: ["src"] }))
  }
  writeFileSync(join(root, "packages", "lib", "src", "actor.ts"), "export interface Actor { id: string }\n")
  writeFileSync(join(root, "packages", "lib", "package.json"), JSON.stringify({ name: "@scope/lib", types: "./src/actor.ts" }))
  mkdirSync(join(root, "packages", "app", "node_modules", "@scope"), { recursive: true })
  symlinkSync(join(root, "packages", "lib"), join(root, "packages", "app", "node_modules", "@scope", "lib"), "dir")
  writeFileSync(join(root, "packages", "app", "src", "index.ts"), "export type { Actor } from '@scope/lib'\n")
  return root
}

describe("cross-package declaration files", () => {
  it("opens the declaration file from the package that owns it", async () => {
    const analyzer = await createTypeAnalyzer(createMonorepo())
    try {
      const result = await analyzer.getFileDeclarations("packages/lib/src/actor.ts", { packageName: "packages/lib" })
      expect(result?.declarations.map((declaration) => declaration.name)).toEqual(["Actor"])
    } finally {
      await analyzer.dispose()
    }
  })

  it("lists the re-exported symbol with the file where it is declared", async () => {
    const analyzer = await createTypeAnalyzer(createMonorepo())
    try {
      const listed = await analyzer.listSymbols({ packageName: "packages/app", pattern: "^Actor$" })
      expect(listed.symbols.map((symbol) => symbol.file)).toEqual(["packages/lib/src/actor.ts"])
    } finally {
      await analyzer.dispose()
    }
  })

  it("opens a file that symbols reported for the same package", async () => {
    const analyzer = await createTypeAnalyzer(createMonorepo())
    try {
      const listed = await analyzer.listSymbols({ packageName: "packages/app", pattern: "^Actor$" })
      const reported = listed.symbols[0]!.file
      const result = await analyzer.getFileDeclarations(reported, { packageName: "packages/app" })
      expect(result).not.toBeNull()
      expect(result?.file).toBe("packages/lib/src/actor.ts")
      expect(result?.declarations.map((declaration) => declaration.name)).toContain("Actor")
    } finally {
      await analyzer.dispose()
    }
  })

  it("resolves a position in a file that symbols reported for the same package", async () => {
    const analyzer = await createTypeAnalyzer(createMonorepo())
    try {
      const listed = await analyzer.listSymbols({ packageName: "packages/app", pattern: "^Actor$" })
      const { file, line } = listed.symbols[0]!
      const result = await analyzer.getTypeAtPosition(file, line ?? 1, 18, "packages/app")
      expect(result).not.toBeNull()
      expect(result?.nodeText).toBe("Actor")
      expect(result?.location.file).toBe("packages/lib/src/actor.ts")
    } finally {
      await analyzer.dispose()
    }
  })

  it("still reports files outside the program as not found", async () => {
    const root = createMonorepo()
    writeFileSync(join(root, "stray.ts"), "export interface Stray { id: string }\n")
    const analyzer = await createTypeAnalyzer(root)
    try {
      expect(await analyzer.getFileDeclarations("stray.ts", { packageName: "packages/app" })).toBeNull()
      expect(await analyzer.getFileDeclarations("packages/lib/src/missing.ts", { packageName: "packages/app" })).toBeNull()
      expect(await analyzer.getTypeAtPosition("stray.ts", 1, 18, "packages/app")).toBeNull()
    } finally {
      await analyzer.dispose()
    }
  })
})
