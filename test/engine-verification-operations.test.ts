import { afterEach, describe, expect, it } from "vitest"
import type { Project } from "typescript/unstable/async"
import type { AnalyzerContext } from "../packages/engine/src/context"
import type { DiagnosticInfo, TransformSearchResponse } from "../packages/engine/src/contracts"
import { createVerificationOperations } from "../packages/engine/src/verification-operations"
import { createVirtualFileRegistry } from "../packages/engine/src/virtual-files"

const roots: string[] = []

afterEach(() => {
  roots.splice(0)
})

const transformEvidence: TransformSearchResponse = {
  results: [],
  query: { from: "Source", to: "Target", options: { paramPosition: "any", unwrapReturn: false, exportedOnly: true, verifiedOnly: true } },
  stats: {
    totalCandidates: 0,
    assignableMatches: 0,
    verifiedMatches: 0,
    verification: { verified: 0, unverified: 0, unverifiable: 0 },
    returned: 0,
    timing: { indexLookupMs: 0, resolutionMs: 0, assignabilityMs: 0, syntheticMs: 0, totalMs: 0 },
  },
}

const makeContext = (workspace: object, registry = createVirtualFileRegistry("/tmp/quartz-test")) => {
  const context = {
    root: "/tmp/quartz-test",
    packages: [{ name: "(root)", path: "/tmp/quartz-test", tsconfigPath: "/tmp/quartz-test/tsconfig.json" }],
    workspace,
    package: (name?: string) => ({ name: name?.trim() || "(root)", path: "/tmp/quartz-test", tsconfigPath: "/tmp/quartz-test/tsconfig.json" }),
  }
  return { context: context as unknown as AnalyzerContext, registry }
}

const sourceFile = (content: string) => ({
  getLineAndCharacterOfPosition(position: number) {
    const prefix = content.slice(0, position)
    const lines = prefix.split("\n")
    return { line: lines.length - 1, character: lines.at(-1)!.length }
  },
})

const makeWorkspace = (failure?: Error) => {
  const active = new Map<string, string>()
  const workspace = {
    active,
    async withVirtualFile<T>(_config: string, path: string, content: string, operation: (project: Project, filePath: string) => Promise<T>) {
      active.set(path, content)
      try {
        if (failure !== undefined) throw failure
        const project = {
          program: {
            async getSourceFile() {
              return sourceFile(content)
            },
            async getSyntacticDiagnostics() {
              return []
            },
            async getBindDiagnostics() {
              return []
            },
            async getSemanticDiagnostics() {
              return content.includes("invalid")
                ? [{ code: 2322, category: 1, text: "Type 'number' is not assignable to type 'string'.", pos: 6, end: 7 }]
                : []
            },
          },
        } as unknown as Project
        return await operation(project, path)
      } finally {
        active.delete(path)
      }
    },
  }
  return workspace
}

describe("verification operations", () => {
  it("checks valid and invalid snippets with source positions", async () => {
    const registry = createVirtualFileRegistry("/tmp/quartz-test")
    const workspace = makeWorkspace()
    const { context } = makeContext(workspace, registry)
    const operations = createVerificationOperations(context, {
      virtualFiles: registry,
      compatibility: async () => ({ compatible: true, from: "Source", to: "Target" }),
      diagnostics: async () => [],
      transformSearch: async () => transformEvidence,
    })

    await expect(operations.checkSnippet("const valid = true;")).resolves.toEqual({ valid: true })
    await expect(operations.checkSnippet("invalid")).resolves.toMatchObject({
      valid: false,
      errors: [{ message: expect.stringContaining("not assignable"), line: 1, column: 7, severity: "error" }],
    })
    expect(registry.size).toBe(0)
    expect(workspace.active.size).toBe(0)
  })

  it("keeps contradictory concurrent snippets isolated", async () => {
    const registry = createVirtualFileRegistry("/tmp/quartz-test")
    const workspace = makeWorkspace()
    const { context } = makeContext(workspace, registry)
    const operations = createVerificationOperations(context, {
      virtualFiles: registry,
      compatibility: async () => ({ compatible: true, from: "Source", to: "Target" }),
      diagnostics: async () => [],
      transformSearch: async () => transformEvidence,
    })

    const [valid, invalid] = await Promise.all([operations.checkSnippet("const valid = true;"), operations.checkSnippet("invalid")])
    expect(valid.valid).toBe(true)
    expect(invalid.valid).toBe(false)
    expect(registry.size).toBe(0)
    expect(workspace.active.size).toBe(0)
  })

  it("explains assignability errors and resolves diagnostics by location", async () => {
    const diagnostics: readonly DiagnosticInfo[] = [{ file: "/tmp/quartz-test/src.ts", line: 2, column: 1, code: 2322, message: "Type 'number' is not assignable to type 'string'." }]
    const { context } = makeContext(makeWorkspace())
    const operations = createVerificationOperations(context, {
      compatibility: async () => ({ compatible: false, from: "number", to: "string", reason: "incompatible", issues: [{ kind: "type_mismatch", property: "value", expectedType: "string", actualType: "number", message: "value mismatch" }] }),
      diagnostics: async () => diagnostics,
      transformSearch: async () => transformEvidence,
    })

    await expect(operations.explainError({ file: "src.ts", line: 2 })).resolves.toMatchObject({
      error: { code: 2322 },
      issues: [{ kind: "type_mismatch" }],
      explanation: expect.stringContaining("number"),
    })
  })

  it("returns verify-contract pass and failure gaps", async () => {
    const registry = createVirtualFileRegistry("/tmp/quartz-test")
    const { context } = makeContext(makeWorkspace(), registry)
    const operations = createVerificationOperations(context, {
      virtualFiles: registry,
      compatibility: async () => ({ compatible: true, from: "Source", to: "Target" }),
      diagnostics: async () => [],
      transformSearch: async () => transformEvidence,
    })

    const passed = await operations.verifyContract({ from: "Source", to: "Target", snippet: "const valid = true;", includeTransformEvidence: false })
    expect(passed.ok).toBe(true)
    expect(passed.checks.compatibility.passed).toBe(true)

    const failed = await operations.verifyContract({ snippet: "invalid", includeDiagnostics: false })
    expect(failed.ok).toBe(false)
    expect(failed.gaps).toContain("The supplied snippet does not compile.")
    expect(failed.next_steps.length).toBeGreaterThan(0)
  })

  it("cleans the registry after virtual project failure", async () => {
    const registry = createVirtualFileRegistry("/tmp/quartz-test")
    const { context } = makeContext(makeWorkspace(new Error("snapshot failed")), registry)
    const operations = createVerificationOperations(context, {
      virtualFiles: registry,
      compatibility: async () => ({ compatible: true, from: "Source", to: "Target" }),
      diagnostics: async () => [],
      transformSearch: async () => transformEvidence,
    })

    await expect(operations.checkSnippet("const value = 1;")).rejects.toThrow("snapshot failed")
    expect(registry.size).toBe(0)
  })
})
