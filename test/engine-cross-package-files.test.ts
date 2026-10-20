import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { createTypeAnalyzer } from "../packages/engine/src"

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const compilerOptions = { target: "ES2022", module: "ESNext", moduleResolution: "Bundler", strict: true, skipLibCheck: true }

// packages/app re-exports an interface declared in packages/lib. symbols and info scoped to
// packages/app report the declaration at packages/lib/src/actor.ts, but file and
// at-position scoped to packages/app cannot open that same path. Same result on tsrs and TS-Go.
const createMonorepo = (): string => {
  const root = mkdtempSync(join(tmpdir(), "quartz-cross-package-"))
  roots.push(root)
  for (const name of ["app", "lib"]) {
    mkdirSync(join(root, "packages", name, "src"), { recursive: true })
    writeFileSync(join(root, "packages", name, "tsconfig.json"), JSON.stringify({ compilerOptions, include: ["src"] }))
  }
  writeFileSync(join(root, "packages", "lib", "src", "actor.ts"), "export interface Actor { id: string }\n")
  writeFileSync(join(root, "packages", "app", "src", "index.ts"), "export type { Actor } from '../../lib/src/actor'\n")
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

  // Known defect: flip to a plain `it` once file lookups honour files reachable from the package program.
  it.fails("opens a file that symbols reported for the same package", async () => {
    const analyzer = await createTypeAnalyzer(createMonorepo())
    try {
      const listed = await analyzer.listSymbols({ packageName: "packages/app", pattern: "^Actor$" })
      const reported = listed.symbols[0]!.file
      const result = await analyzer.getFileDeclarations(reported, { packageName: "packages/app" })
      expect(result).not.toBeNull()
      expect(result?.declarations.map((declaration) => declaration.name)).toContain("Actor")
    } finally {
      await analyzer.dispose()
    }
  })
})
