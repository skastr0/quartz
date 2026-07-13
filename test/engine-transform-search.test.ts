import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { AnalyzerContext } from "../packages/engine/src/context"
import { createTransformSearchOperation, type TransformSearchOperation } from "../packages/engine/src/transform-search"

const fixturesPath = join(dirname(fileURLToPath(import.meta.url)), "fixtures")
let context: AnalyzerContext
let search: TransformSearchOperation
describe("native engine transform search", () => {
  beforeAll(async () => {
    context = await AnalyzerContext.open(fixturesPath)
    search = createTransformSearchOperation(context)
  })

  afterAll(async () => {
    await context.close()
  })

  it("finds from-only transforms", async () => {
    const response = await search({ from: "User", paramPosition: "any" })
    expect(response.results.map((result) => result.name)).toContain("toDTO")
    expect(response.results.every((result) => result.matchDetails.fromMatch?.matched === true)).toBe(true)
  })

  it("finds to-only transforms", async () => {
    const response = await search({ to: "UserDTO" })
    expect(response.results.map((result) => result.name)).toContain("toDTO")
    expect(response.stats.assignableMatches).toBeGreaterThanOrEqual(response.results.length)
  })

  it("matches from and to together", async () => {
    const response = await search({ from: "User", to: "UserDTO", paramPosition: "any" })
    expect(response.results.map((result) => result.name)).toContain("toDTO")
    expect(response.results.find((result) => result.name === "toDTO")?.verification.status).toBe("verified")
  })

  it("unwraps Promise return types", async () => {
    const response = await search({ from: "User", to: "UserDTO", paramPosition: "any", unwrapReturn: true })
    const save = response.results.find((result) => result.name === "saveUser")
    expect(save?.matchDetails.toMatch).toMatchObject({ unwrapped: true, wrapper: "Promise", returnType: "Promise<UserDTO>" })
  })

  it("rejects erased-input false positives", async () => {
    const response = await search({ from: "User", to: "UserDTO", paramPosition: "any" })
    expect(response.results.map((result) => result.name)).not.toContain("anyToDTO")
  })

  it("ranks deterministically", async () => {
    const first = await search({ from: "User", to: "UserDTO", paramPosition: "any", limit: 20 })
    const second = await search({ from: "User", to: "UserDTO", paramPosition: "any", limit: 20 })
    expect(first.results).toEqual(second.results)
  })

  it("returns the canonical structured response", async () => {
    const response = await search({ from: "User", to: "UserDTO", limit: 5 })
    expect(response).toMatchObject({
      query: { from: "User", to: "UserDTO" },
      stats: {
        totalCandidates: expect.any(Number),
        assignableMatches: expect.any(Number),
        verifiedMatches: expect.any(Number),
        verification: expect.objectContaining({ verified: expect.any(Number), unverified: expect.any(Number), unverifiable: expect.any(Number) }),
        timing: expect.objectContaining({ totalMs: expect.any(Number) }),
      },
      results: expect.any(Array),
    })
    expect(typeof response).toBe("object")
  })
  it("infers unannotated arrow return types through checker signatures", async () => {
    const root = await mkdtemp(join(tmpdir(), "quartz-transform-search-"))
    try {
      await writeFile(join(root, "tsconfig.json"), JSON.stringify({
        compilerOptions: { target: "ESNext", module: "ESNext", moduleResolution: "bundler", strict: true, noEmit: true },
        include: ["source.ts"],
      }))
      await writeFile(join(root, "source.ts"), [
        "export interface Source { id: string }",
        "export interface Target { id: string }",
        "type TargetAlias = Target",
        "export const inferred = (source: Source) => ({ id: source.id })",
        "export const aliased = (source: Source): TargetAlias => ({ id: source.id })",
      ].join("\n"))
      const temporaryContext = await AnalyzerContext.open(root)
      try {
        const response = await createTransformSearchOperation(temporaryContext)({
          from: "Source",
          to: "Target",
          paramPosition: "any",
          verifiedOnly: true,
        })
        expect(response.results.find((result) => result.name === "inferred")).toMatchObject({
          signature: "inferred(source: Source): { id: string; }",
          verification: { status: "verified" },
        })
        expect(response.results.find((result) => result.name === "aliased")).toMatchObject({
          verification: { status: "verified" },
        })
      } finally {
        await temporaryContext.close()
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
  it("keeps compiler-proven aliases with verifiedOnly", async () => {
    const response = await search({ from: "UserInput", to: "CreateUserReturn", paramPosition: "any", verifiedOnly: true })
    const createUser = response.results.find((result) => result.name === "createUser")
    expect(createUser?.matchDetails.toMatch).toMatchObject({ queryType: "CreateUserReturn", exact: false })
    expect(createUser?.verification).toMatchObject({ status: "verified", method: "assignability_only" })
  })

  it("rejects unsupported evidence options instead of echoing them as implemented", async () => {
    await expect(search({ from: "User", includeDiagnostics: true })).rejects.toThrow(/evidence options are not supported/)
    await expect(search({ from: "User", includeSyntheticCode: true })).rejects.toThrow(/evidence options are not supported/)
    await expect(search({ from: "User", includeFailedVerification: true })).rejects.toThrow(/evidence options are not supported/)
  })
})
