import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { AnalyzerContext } from "../packages/engine/src/context"
import { createReferenceOperations } from "../packages/engine/src/reference-operations"

const createFixture = async () => {
  const root = mkdtempSync(join(tmpdir(), "quartz-engine-references-"))
  mkdirSync(join(root, "src"), { recursive: true })
  writeFileSync(
    join(root, "tsconfig.json"),
    JSON.stringify({ compilerOptions: { target: "ESNext", module: "ESNext", moduleResolution: "Bundler", strict: true, skipLibCheck: true }, include: ["src/**/*.ts"] }),
  )
  writeFileSync(
    join(root, "src", "model.ts"),
    [
      "export interface User { id: string }",
      "export default class DefaultModel { value: User; constructor(value: User) { this.value = value } }",
      "export { DefaultModel as ModelAlias }",
    ].join("\n"),
  )
  writeFileSync(
    join(root, "src", "consumer.ts"),
    [
      "import type { User, ModelAlias } from './model'",
      "export interface UserBox { user: User }",
      "export function readUser(😀user: User): User { return 😀user }",
      "export const alias: ModelAlias | null = null",
      "// User appears in this comment",
      "export const label = 'User'",
    ].join("\n"),
  )
  const context = await AnalyzerContext.open(root)
  return { root, context, operations: createReferenceOperations(context) }
}

describe("engine reference operations", () => {
  it("finds cross-file type references through imported aliases", async () => {
    const { context, operations } = await createFixture()
    try {
      const result = await operations.findRelated("User")
      expect(result?.referencedBy).toEqual(expect.arrayContaining([
        expect.objectContaining({ symbol: "user", context: "type reference", file: "src/consumer.ts", line: 2 }),
        expect.objectContaining({ symbol: "readUser", context: "type reference", file: "src/consumer.ts", line: 3 }),
      ]))
    } finally {
      await context.close()
    }
  })

  it("prefers compiler-native references over full-project identifier scans", async () => {
    const { context, operations } = await createFixture()
    let nativeCalls = 0
    let perFileReferenceCalls = 0
    const workspace = context.workspace
    const originalWithProject = workspace.withProject.bind(workspace)
    workspace.withProject = (operation, configFile) =>
      originalWithProject(async (project, revision) => {
        const originalNative = project.checker.getReferencedSymbolsForNode
        const originalPerFile = project.checker.getReferencesToSymbolInFile
        Object.defineProperty(project.checker, "getReferencedSymbolsForNode", {
          configurable: true,
          value: (...args: unknown[]) => {
            nativeCalls += 1
            return Reflect.apply(originalNative, project.checker, args)
          },
        })
        Object.defineProperty(project.checker, "getReferencesToSymbolInFile", {
          configurable: true,
          value: (...args: unknown[]) => {
            perFileReferenceCalls += 1
            return Reflect.apply(originalPerFile, project.checker, args)
          },
        })
        try {
          return await operation(project, revision)
        } finally {
          Object.defineProperty(project.checker, "getReferencedSymbolsForNode", {
            configurable: true,
            value: originalNative,
          })
          Object.defineProperty(project.checker, "getReferencesToSymbolInFile", {
            configurable: true,
            value: originalPerFile,
          })
        }
      }, configFile)

    try {
      const result = await operations.findRelated("User")
      expect(result).not.toBeNull()
      expect(result?.referencedBy.length).toBeGreaterThan(0)
      expect(nativeCalls).toBeGreaterThanOrEqual(1)
      // Native path should short-circuit the per-file / type-scan fallback.
      expect(perFileReferenceCalls).toBe(0)
    } finally {
      workspace.withProject = originalWithProject
      await context.close()
    }
  })

  it("preserves related results when native reference collection falls back", async () => {
    const { context, operations } = await createFixture()
    const workspace = context.workspace
    const originalWithProject = workspace.withProject.bind(workspace)
    workspace.withProject = (operation, configFile) =>
      originalWithProject(async (project, revision) => {
        const originalNative = project.checker.getReferencedSymbolsForNode
        Object.defineProperty(project.checker, "getReferencedSymbolsForNode", {
          configurable: true,
          value: async () => {
            throw new Error("native references unavailable")
          },
        })
        try {
          return await operation(project, revision)
        } finally {
          Object.defineProperty(project.checker, "getReferencedSymbolsForNode", {
            configurable: true,
            value: originalNative,
          })
        }
      }, configFile)

    try {
      const result = await operations.findRelated("User")
      expect(result?.referencedBy).toEqual(expect.arrayContaining([
        expect.objectContaining({ symbol: "user", context: "type reference", file: "src/consumer.ts", line: 2 }),
        expect.objectContaining({ symbol: "readUser", context: "type reference", file: "src/consumer.ts", line: 3 }),
      ]))
    } finally {
      workspace.withProject = originalWithProject
      await context.close()
    }
  })

  it("keeps alias and default export graph nodes on canonical identities", async () => {
    const { context, operations } = await createFixture()
    try {
      const aliasGraph = await operations.generateGraph("ModelAlias", { depth: 1, format: "dot" })
      expect(aliasGraph?.root).toBe("ModelAlias")
      expect(aliasGraph?.nodes).toContain("ModelAlias")
      expect(aliasGraph?.nodes).not.toContain("DefaultModel")

      const defaultGraph = await operations.generateGraph("default", { depth: 1 })
      expect(defaultGraph?.root).toBe("default")
      expect(defaultGraph?.nodes).toContain("default")
    } finally {
      await context.close()
    }
  })

  it("reports UTF-16 rename positions and string/comment risk locations", async () => {
    const { context, operations } = await createFixture()
    try {
      const result = await operations.previewRefactor({ action: "rename", symbol: "User", to: "Account" })
      const userSite = result.locations.find(({ file, line }) => file === "src/consumer.ts" && line === 3)
      expect(userSite).toMatchObject({ column: 34, before: "export function readUser(😀user: User): User { return 😀user }" })
      expect(result.stringLiteralLocations).toEqual([{ file: "src/consumer.ts", line: 6, content: "User" }])
      expect(result.commentLocations).toEqual([{ file: "src/consumer.ts", line: 5, content: "User appears in this comment" }])
      expect(result.safe).toBe(false)
    } finally {
      await context.close()
    }
  })
})
