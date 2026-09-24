import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
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

  it("uses program metadata rather than path names to select project sources", async () => {
    const root = await mkdtemp(join(tmpdir(), "quartz-node_modules-project-"))
    try {
      await writeFile(join(root, "tsconfig.json"), JSON.stringify({
        compilerOptions: { target: "ESNext", module: "ESNext", moduleResolution: "bundler", strict: true, noEmit: true },
        include: ["source.ts"],
      }))
      await writeFile(join(root, "source.ts"), [
        "export interface Source { id: string }",
        "export interface Target { id: string }",
        "export const convert = (value: Source): Target => value",
      ].join("\n"))
      const temporaryContext = await AnalyzerContext.open(root)
      try {
        const response = await createTransformSearchOperation(temporaryContext)({ from: "Source" })
        expect(response.results).toEqual(expect.arrayContaining([
          expect.objectContaining({ name: "convert", file: "source.ts" }),
        ]))
      } finally {
        await temporaryContext.close()
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("verifies helpers and query types that the package entry does not re-export", async () => {
    const root = await mkdtemp(join(tmpdir(), "quartz-internal-transform-"))
    try {
      await mkdir(join(root, "src"))
      await writeFile(join(root, "tsconfig.json"), JSON.stringify({
        compilerOptions: { target: "ESNext", module: "ESNext", moduleResolution: "bundler", strict: true, noEmit: true },
        include: ["src/**/*.ts"],
      }))
      await writeFile(join(root, "src/index.ts"), "export interface PublicShape { id: string }\n")
      await writeFile(join(root, "src/internal.ts"), [
        "export interface Draft { id: string }",
        "export interface Published { id: string; slug: string }",
        "export function publish(draft: Draft): Published { return { id: draft.id, slug: draft.id } }",
        "export class Publisher { static run(draft: Draft): Published { return publish(draft) } }",
      ].join("\n"))
      const temporaryContext = await AnalyzerContext.open(root)
      try {
        const response = await createTransformSearchOperation(temporaryContext)({ from: "Draft", to: "Published", verifiedOnly: true })
        expect(response.results.map((result) => [result.name, result.verification.status]).sort()).toEqual([
          ["Publisher.run", "verified"],
          ["publish", "verified"],
        ])
      } finally {
        await temporaryContext.close()
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
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

  it("uses the compiler-selected public overload as one callable result", async () => {
    const forward = await search({
      from: "User",
      to: "UserDTO",
      paramPosition: "any",
      verifiedOnly: true,
      limit: 100,
    })
    const reverse = await search({
      from: "UserDTO",
      to: "User",
      paramPosition: "any",
      verifiedOnly: true,
      limit: 100,
    })

    expect(forward.results.filter((result) => result.name === "transform")).toEqual([
      expect.objectContaining({
        signature: "transform(input: User): UserDTO",
        verification: { status: "verified", method: "synthetic", reason: "synthetic_check_passed" },
      }),
    ])
    expect(reverse.results.filter((result) => result.name === "transform")).toEqual([
      expect.objectContaining({
        signature: "transform(input: UserDTO): User",
        verification: { status: "verified", method: "synthetic", reason: "synthetic_check_passed" },
      }),
    ])
  })

  it("keeps overloaded static and instance methods as distinct callables", async () => {
    const root = await mkdtemp(join(tmpdir(), "quartz-transform-overloaded-methods-"))
    try {
      await writeFile(join(root, "tsconfig.json"), JSON.stringify({
        compilerOptions: { target: "ESNext", module: "ESNext", moduleResolution: "bundler", strict: true, noEmit: true },
        include: ["source.ts"],
      }))
      await writeFile(join(root, "source.ts"), [
        "export interface Source { id: string }",
        "export interface DetailedSource extends Source { detail: string }",
        "export interface Target { id: string }",
        "export interface OtherSource { value: number }",
        "export interface OtherTarget { value: string }",
        "export function aConvert(value: Source): Target",
        "export function aConvert(value: DetailedSource): Target",
        "export function aConvert(value: Source): Target { return value }",
        "export function zExact(value: DetailedSource): Target { return value }",
        "export class Mapper {",
        "  constructor(value: DetailedSource)",
        "  constructor(value: Source)",
        "  constructor(_value: Source) {}",
        "  static map(value: DetailedSource): Target",
        "  static map(value: Source): Target",
        "  static map(value: Source): Target { return value }",
        "  map(value: OtherSource): OtherTarget { return { value: String(value.value) } }",
        "}",
        "export interface CallableMapper {",
        "  (value: DetailedSource): Target",
        "  (value: Source): Target",
        "}",
      ].join("\n"))
      const temporaryContext = await AnalyzerContext.open(root)
      try {
        const temporarySearch = createTransformSearchOperation(temporaryContext)
        const staticResponse = await temporarySearch({
          from: "DetailedSource",
          to: "Target",
          verifiedOnly: true,
          limit: 10,
        })
        const instanceResponse = await temporarySearch({
          from: "OtherSource",
          to: "OtherTarget",
          verifiedOnly: true,
          limit: 10,
        })
        const constructorResponse = await temporarySearch({
          from: "DetailedSource",
          to: "Mapper",
          verifiedOnly: true,
          limit: 10,
        })
        const typeOnlyResponse = await temporarySearch({
          from: "DetailedSource",
          to: "Target",
          includeFailedVerification: true,
          limit: 10,
        })
        const rankedResponse = await temporarySearch({
          from: "DetailedSource",
          to: "Target",
          verifiedOnly: true,
          limit: 1,
        })

        expect(staticResponse.results.filter((result) => result.name === "Mapper.map")).toEqual([
          expect.objectContaining({
            kind: "StaticMethod",
            signature: "map(value: DetailedSource): Target",
          }),
        ])
        expect(instanceResponse.results.filter((result) => result.name === "Mapper.map")).toEqual([
          expect.objectContaining({
            kind: "ClassMethod",
            signature: "map(value: OtherSource): OtherTarget",
          }),
        ])
        expect(constructorResponse.results.filter((result) => result.name === "Mapper.constructor")).toEqual([
          expect.objectContaining({
            kind: "Constructor",
            signature: "constructor(value: DetailedSource): Mapper",
          }),
        ])
        expect(typeOnlyResponse.results.filter((result) => result.name === "CallableMapper.anonymous")).toEqual([
          expect.objectContaining({
            kind: "TypeLiteralMethod",
            signature: "anonymous(value: DetailedSource): Target",
            verification: { status: "unverifiable", method: null, reason: "not_importable" },
          }),
        ])
        expect(rankedResponse.results).toEqual([
          expect.objectContaining({
            name: "zExact",
            signature: "zExact(value: DetailedSource): Target",
          }),
        ])
      } finally {
        await temporaryContext.close()
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("fails closed when a query type cannot be resolved", async () => {
    await expect(search({ from: "  DefinitelyNotAType  ", to: "AlsoMissing" })).rejects.toMatchObject({
      code: "TRANSFORM_QUERY_UNRESOLVED",
      message: 'Could not resolve transform-search from type "DefinitelyNotAType". Declare an exported named type or alias and retry.',
    })
    await expect(search({ from: 'Pick<User, "id">', to: "UserDTO" })).rejects.toMatchObject({
      code: "TRANSFORM_QUERY_UNRESOLVED",
      message: expect.stringContaining("Declare an exported named type or alias"),
    })
    await expect(search({ from: "User", to: 'Pick<UserDTO, "id">' })).rejects.toMatchObject({
      code: "TRANSFORM_QUERY_UNRESOLVED",
      message: expect.stringContaining('to type "Pick<UserDTO, \\"id\\">"'),
    })
  })

  it("unwraps Promise return types", async () => {
    const response = await search({ from: "User", to: "UserDTO", paramPosition: "any", unwrapReturn: true })
    const save = response.results.find((result) => result.name === "saveUser")
    expect(save?.matchDetails.toMatch).toMatchObject({ unwrapped: true, wrapper: "Promise", returnType: "Promise<UserDTO>" })
  })

  it("verifies public instance methods without requiring a public constructor", async () => {
    const root = await mkdtemp(join(tmpdir(), "quartz-transform-private-constructor-"))
    try {
      await writeFile(join(root, "tsconfig.json"), JSON.stringify({
        compilerOptions: { target: "ESNext", module: "ESNext", moduleResolution: "bundler", strict: true, noEmit: true },
        include: ["source.ts"],
      }))
      await writeFile(join(root, "source.ts"), [
        "export interface Source { id: string }",
        "export interface Target { id: string }",
        "export class Mapper {",
        "  private constructor() {}",
        "  map(value: Source): Target { return value }",
        "}",
      ].join("\n"))
      const temporaryContext = await AnalyzerContext.open(root)
      try {
        const response = await createTransformSearchOperation(temporaryContext)({
          from: "Source",
          to: "Target",
          verifiedOnly: true,
        })
        expect(response.results).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              name: "Mapper.map",
              verification: { status: "verified", method: "synthetic", reason: "synthetic_check_passed" },
            }),
          ]),
        )
      } finally {
        await temporaryContext.close()
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
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
    expect(createUser?.verification).toMatchObject({ status: "verified", method: "synthetic" })
  })

  it("continues synthetic verification until verifiedOnly reaches the requested limit", async () => {
    const root = await mkdtemp(join(tmpdir(), "quartz-transform-trust-"))
    try {
      await writeFile(join(root, "tsconfig.json"), JSON.stringify({
        compilerOptions: { target: "ESNext", module: "ESNext", moduleResolution: "bundler", strict: true, noEmit: true },
        include: ["source.ts"],
      }))
      await writeFile(join(root, "source.ts"), [
        "export interface Source { id: string }",
        "export interface Target { id: string }",
        ...Array.from({ length: 12 }, (_, index) => `export class Broken${index} { private map(value: Source): Target { return value } }`),
        "export const valid = (value: Source): Target => value",
      ].join("\n"))
      const temporaryContext = await AnalyzerContext.open(root)
      try {
        const response = await createTransformSearchOperation(temporaryContext)({
          from: "Source",
          to: "Target",
          paramPosition: "any",
          verifiedOnly: true,
          limit: 1,
        })
        expect(response.results).toHaveLength(1)
        expect(response.results[0]).toMatchObject({ name: "valid", verification: { status: "verified" } })
      } finally {
        await temporaryContext.close()
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("does not verify beyond the remaining trusted result limit", async () => {
    const root = await mkdtemp(join(tmpdir(), "quartz-transform-trust-limit-"))
    try {
      await writeFile(join(root, "tsconfig.json"), JSON.stringify({
        compilerOptions: { target: "ESNext", module: "ESNext", moduleResolution: "bundler", strict: true, noEmit: true },
        include: ["source.ts"],
      }))
      await writeFile(join(root, "source.ts"), [
        "export interface Source { id: string }",
        "export interface Target { id: string }",
        ...Array.from({ length: 5 }, (_, index) => `export const valid${index} = (value: Source): Target => value`),
      ].join("\n"))
      const temporaryContext = await AnalyzerContext.open(root)
      const virtualFiles = vi.spyOn(temporaryContext.workspace, "withVirtualFile")
      try {
        const response = await createTransformSearchOperation(temporaryContext)({
          from: "Source",
          to: "Target",
          paramPosition: "any",
          verifiedOnly: true,
          limit: 1,
        })
        expect(response.results).toHaveLength(1)
        expect(response.stats).toMatchObject({
          verifiedMatches: 1,
          verification: { verified: 1 },
        })
        expect(virtualFiles).toHaveBeenCalledTimes(1)
      } finally {
        virtualFiles.mockRestore()
        await temporaryContext.close()
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("does not verify candidates when a trust-filtered query requests zero results", async () => {
    const virtualFiles = vi.spyOn(context.workspace, "withVirtualFile")
    const response = await search({ from: "User", to: "UserDTO", paramPosition: "any", verifiedOnly: true, limit: 0 })

    expect(response.results).toEqual([])
    expect(response.stats).toMatchObject({
      returned: 0,
      verification: { verified: 0, unverified: 0, unverifiable: 0 },
    })
    expect(virtualFiles).not.toHaveBeenCalled()
    virtualFiles.mockRestore()
  })

  it("returns requested synthetic verification evidence", async () => {
    const response = await search({
      from: "User",
      to: "UserDTO",
      includeDiagnostics: true,
      includeSyntheticCode: true,
      includeFailedVerification: true,
    })
    const toDTO = response.results.find((result) => result.name === "toDTO")

    expect(toDTO?.verification).toMatchObject({
      status: "verified",
      method: "synthetic",
      reason: "synthetic_check_passed",
      syntheticCode: expect.stringContaining("toDTO(__input)"),
    })
    expect(toDTO?.verification.diagnostics).toBeUndefined()
  })
})
