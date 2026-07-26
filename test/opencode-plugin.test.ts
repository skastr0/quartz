import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Hooks } from "@opencode-ai/plugin"
import { describe, expect, it, vi } from "vitest"
import pluginModule, { QuartzPlugin } from "../apps/opencode-plugin/src/server"

const toolExecute = async (plugin: any, name: string, args: Record<string, unknown> = {}) =>
  plugin.tool[name].execute(args)

const parse = (value: string) => JSON.parse(value) as any
type OpenCodeEvent = Parameters<NonNullable<Hooks["event"]>>[0]["event"]
type SessionDeletedEvent = Extract<OpenCodeEvent, { readonly type: "session.deleted" }>
type Session = SessionDeletedEvent["properties"]["info"]
type ToolExecuteAfter = NonNullable<Hooks["tool.execute.after"]>

const session = (directory: string): Session => ({
  id: "session-gone",
  projectID: "project-quartz",
  directory,
  title: "Deleted session",
  version: "1",
  time: { created: 1, updated: 1 },
})

const toolAfterInput = (tool: string): Parameters<ToolExecuteAfter>[0] => ({
  tool,
  sessionID: "session-1",
  callID: "call-1",
  args: {},
})

const toolAfterOutput: Parameters<ToolExecuteAfter>[1] = {
  title: "completed",
  output: "",
  metadata: {},
}

describe("OpenCode plugin wrapper", () => {
  it("exports a server plugin module", () => {
    expect(pluginModule.id).toBe("quartz")
    expect(pluginModule.server).toBe(QuartzPlugin)
  })

  it("keeps OpenCode-specific behavior in the wrapper", async () => {
    const log = vi.fn()
    const plugin: any = await QuartzPlugin({
      directory: new URL("./fixtures", import.meta.url).pathname,
      client: { app: { log } },
    } as never)

    expect(plugin.tool).toEqual(
      expect.objectContaining({
        type_packages: expect.any(Object),
        type_symbols: expect.any(Object),
        type_info: expect.any(Object),
        type_expand: expect.any(Object),
        type_related: expect.any(Object),
        type_search: expect.any(Object),
        type_eval: expect.any(Object),
        type_diagnostics: expect.any(Object),
        type_check_snippet: expect.any(Object),
        type_at_position: expect.any(Object),
        type_file: expect.any(Object),
        type_refresh: expect.any(Object),
        type_compatible: expect.any(Object),
        type_graph: expect.any(Object),
        type_refactor_preview: expect.any(Object),
        type_why_error: expect.any(Object),
        type_explain: expect.any(Object),
        type_transform_search: expect.any(Object),
        type_verify_contract: expect.any(Object),
      }),
    )
    expect(plugin.event).toEqual(expect.any(Function))
  })

  it("executes representative tools with preserved argument propagation", async () => {
    const plugin: any = await QuartzPlugin({
      directory: new URL("./fixtures", import.meta.url).pathname,
      client: {},
    } as never)

    const diagnostics = parse(await toolExecute(plugin, "type_diagnostics", { explain: true }))
    const info = parse(await toolExecute(plugin, "type_info", { symbol: "User" }))
    const memberInfo = parse(await toolExecute(plugin, "type_info", { symbol: "@file:types/basic.ts:User.name" }))
    const symbols = parse(await toolExecute(plugin, "type_symbols", { package: "(root)", pattern: "^User", kind: "interface", limit: 1 }))
    const related = parse(await toolExecute(plugin, "type_related", { symbol: "ExtendedUser" }))
    const graph = parse(await toolExecute(plugin, "type_graph", { symbol: "ExtendedUser", depth: 1, format: "dot" }))
    const compatible = parse(await toolExecute(plugin, "type_compatible", { from: "ExtendedUser", to: "User" }))
    const file = parse(await toolExecute(plugin, "type_file", { file: "types/basic.ts", symbol: "^User$", includePrivate: false }))
    const explainedType = parse(await toolExecute(plugin, "type_explain", { expression: 'Pick<User, "id">' }))
    const transformSearch = parse(await toolExecute(plugin, "type_transform_search", {
      from: "User",
      to: "UserDTO",
      paramPosition: "any",
      unwrapReturn: true,
      exportedOnly: false,
      allowTypeErasure: true,
      limit: 1,
    }))
    const verifiedTransformSearch = parse(await toolExecute(plugin, "type_transform_search", {
      from: "User",
      to: "UserDTO",
      verifiedOnly: true,
      limit: 5,
    }))
    const partialTransformSearch = parse(await toolExecute(plugin, "type_transform_search", {
      from: "User",
      limit: 5,
    }))
    const verifyContract = parse(await toolExecute(plugin, "type_verify_contract", {
      from: "User",
      to: "UserDTO",
      symbol: "toDTO",
      snippet: "const user: User = { id: '1', name: 'Ada', email: 'ada@example.com' }; const dto: UserDTO = toDTO(user);",
    }))
    const verifyContractBlankPackage = parse(await toolExecute(plugin, "type_verify_contract", {
      package: "   ",
      snippet: "const value = 1 satisfies number;",
    }))
    const whyError = parse(await toolExecute(plugin, "type_why_error", {
      code: 2322,
      message: "Type UserInput is not assignable to type User",
    }))

    expect(diagnostics).toMatchObject({ totalErrors: 0, explained: 0 })
    expect(info).toMatchObject({ name: "User", kind: "interface" })
    expect(memberInfo).toMatchObject({ name: "name", kind: "PropertySignature" })
    expect(symbols).toMatchObject({
      symbols: [expect.objectContaining({ name: "User", kind: "interface" })],
      truncated: true,
    })
    expect(related.references).toEqual(expect.arrayContaining([expect.objectContaining({ context: "extends" })]))
    expect(graph).toMatchObject({ root: "ExtendedUser", format: "dot", depth: 1 })
    expect(graph.graph).toContain("digraph")
    expect(compatible).toMatchObject({ compatible: true })
    expect(file.declarations.map((declaration: any) => declaration.name)).toEqual(["User"])
    expect(explainedType.final).toContain("id")
    expect(transformSearch.results[0]).toMatchObject({
      name: expect.stringContaining("toDTO"),
      verification: {
        status: expect.stringMatching(/verified|unverified|unverifiable/),
        method: expect.anything(),
        reason: expect.any(String),
      },
    })
    expect(verifiedTransformSearch.results.every((result: any) => result.verification.status === "verified")).toBe(true)
    expect(partialTransformSearch.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          verification: {
            status: "unverified",
            method: "assignability_only",
            reason: "partial_query",
          },
        }),
      ]),
    )
    expect(verifyContract).toMatchObject({
      schemaVersion: "verify-contract/v1",
      ok: true,
      checks: {
        compatibility: { ran: true, passed: false, blocking: false },
        snippet: { ran: true, passed: true },
        diagnostics: { ran: true, passed: true },
        transform: { ran: true, passed: true },
      },
      evidence: {
        transformSearch: {
          results: expect.arrayContaining([
            expect.objectContaining({
              name: expect.stringContaining("toDTO"),
              verification: expect.objectContaining({ status: "verified" }),
            }),
          ]),
        },
      },
    })
    expect(verifyContractBlankPackage).toMatchObject({
      ok: true,
      contract: { package: "(root)" },
      checks: { snippet: { ran: true, passed: true } },
    })
    expect(whyError).toMatchObject({
      explanation: expect.stringContaining("UserInput"),
      issues: [expect.objectContaining({ kind: "missing_property", property: "id" })],
    })
    await expect(toolExecute(plugin, "type_transform_search", {
      from: 'Pick<User, "id">',
      to: "UserDTO",
    })).rejects.toMatchObject({
      code: "TRANSFORM_QUERY_UNRESOLVED",
      message: expect.stringContaining("Declare an exported named type or alias"),
    })
    await expect(toolExecute(plugin, "type_transform_search", {
      from: "DefinitelyNotAType",
      to: "UserDTO",
    })).rejects.toMatchObject({
      name: "QuartzEngineError",
      code: "TRANSFORM_QUERY_UNRESOLVED",
    })
  }, 20_000)

  it("disposes a matching server instance exactly once and keeps session deletion usable", async () => {
    const log = vi.fn()
    const plugin: any = await QuartzPlugin({
      directory: new URL("./fixtures", import.meta.url).pathname,
      client: { app: { log } },
    } as never)

    const deleted = {
      type: "session.deleted",
      properties: { info: session(new URL("./fixtures", import.meta.url).pathname) },
    } satisfies OpenCodeEvent
    await plugin.event({ event: deleted })
    expect(parse(await toolExecute(plugin, "type_info", { symbol: "User" }))).toMatchObject({ name: "User" })
    expect(log).not.toHaveBeenCalledWith(
      expect.objectContaining({ body: expect.objectContaining({ message: "quartz analyzer disposed" }) }),
    )

    await plugin.event({
      event: { type: "server.instance.disposed", properties: { directory: "/another-workspace" } },
    })
    expect(log).not.toHaveBeenCalledWith(
      expect.objectContaining({ body: expect.objectContaining({ message: "quartz analyzer disposed" }) }),
    )

    const directory = new URL("./fixtures", import.meta.url).pathname
    await plugin.event({ event: { type: "server.instance.disposed", properties: { directory } } })
    await plugin.event({ event: { type: "server.instance.disposed", properties: { directory } } })

    expect(log).toHaveBeenCalledTimes(1)
    expect(log).toHaveBeenCalledWith({
      body: expect.objectContaining({
        service: "quartz",
        message: "quartz analyzer disposed",
        extra: expect.objectContaining({ reason: "server.instance.disposed" }),
      }),
    })
  })

  it("invalidates dirty caches from OpenCode file events and modifying-tool fallbacks", async () => {
    const root = mkdtempSync(join(tmpdir(), "tlt-plugin-"))
    mkdirSync(join(root, "src"))
    writeFileSync(join(root, "tsconfig.json"), JSON.stringify({ include: ["src/**/*.ts"] }), "utf8")
    const sourcePath = join(root, "src", "types.ts")
    writeFileSync(sourcePath, "export interface TempUser { name: string }\n", "utf8")

    const log = vi.fn()
    const plugin: any = await QuartzPlugin({
      directory: root,
      client: { app: { log } },
    } as never)

    const before = parse(await toolExecute(plugin, "type_info", { symbol: "TempUser" }))
    writeFileSync(sourcePath, "export interface TempUser { name: string; age: number }\n", "utf8")
    await plugin.event({ event: { type: "file.edited", properties: { file: sourcePath } } })
    const afterEdit = parse(await toolExecute(plugin, "type_info", { symbol: "TempUser" }))
    writeFileSync(sourcePath, "export interface TempUser { name: string; age: number; role: string }\n", "utf8")
    await plugin.event({ event: { type: "file.watcher.updated", properties: { file: sourcePath, event: "change" } } })
    const afterWatch = parse(await toolExecute(plugin, "type_info", { symbol: "TempUser" }))

    for (const [toolName, property] of [
      ["apply_patch", "enabled"],
      ["edit", "status"],
      ["write", "title"],
      ["morph-mcp_edit_file", "nickname"],
    ] as const) {
      writeFileSync(sourcePath, `export interface TempUser { name: string; ${property}: string }\n`, "utf8")
      await plugin["tool.execute.after"](toolAfterInput(toolName), toolAfterOutput)
      expect(parse(await toolExecute(plugin, "type_info", { symbol: "TempUser" })).properties.map((item: any) => item.name)).toEqual([
        "name",
        property,
      ])
    }

    const refresh = await toolExecute(plugin, "type_refresh")

    expect(before.properties.map((property: any) => property.name)).toEqual(["name"])
    expect(afterEdit.properties.map((property: any) => property.name)).toEqual(["name", "age"])
    expect(afterWatch.properties.map((property: any) => property.name)).toEqual(["name", "age", "role"])
    expect(refresh).toContain("Refreshed all TypeScript projects")
  })

  it("routes package-scoped plugin calls to the selected package", async () => {
    const root = mkdtempSync(join(tmpdir(), "quartz-plugin-packages-"))
    const leafPackage = "packages/leaf"
    mkdirSync(join(root, "src"), { recursive: true })
    mkdirSync(join(root, leafPackage, "src"), { recursive: true })
    writeFileSync(join(root, "tsconfig.json"), JSON.stringify({ include: ["src/**/*.ts"] }), "utf8")
    writeFileSync(join(root, "src", "root.ts"), "export interface RootOnly { root: string }\n", "utf8")
    writeFileSync(join(root, leafPackage, "tsconfig.json"), JSON.stringify({ include: ["src/**/*.ts"] }), "utf8")
    writeFileSync(join(root, leafPackage, "src", "leaf.ts"), "export interface LeafOnly { leaf: string }\n", "utf8")

    const plugin: any = await QuartzPlugin({
      directory: root,
      client: {},
    } as never)

    const leafSymbols = parse(await toolExecute(plugin, "type_symbols", { package: leafPackage, limit: 25 }))
    const names = leafSymbols.symbols.map((symbol: any) => symbol.name)

    expect(names).toContain("LeafOnly")
    expect(names).not.toContain("RootOnly")
  })

  it("exposes failed synthetic verification diagnostics when requested", async () => {
    const root = mkdtempSync(join(tmpdir(), "quartz-plugin-verification-"))
    mkdirSync(join(root, "src"), { recursive: true })
    writeFileSync(
      join(root, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          target: "ESNext",
          module: "ESNext",
          moduleResolution: "bundler",
          strict: true,
          skipLibCheck: true,
          noEmit: true,
        },
        include: ["src/**/*.ts"],
      }),
      "utf8",
    )
    writeFileSync(
      join(root, "src", "transforms.ts"),
      [
        "export interface SourceShape { id: string }",
        "export interface TargetShape { id: string; displayName: string }",
        "export type TargetShapePlus = TargetShape & { extra: string }",
        "export class SecretMapper {",
        "  private constructor() {}",
        "  map(value: SourceShape): TargetShapePlus {",
        "    return { ...value, displayName: value.id, extra: value.id }",
        "  }",
        "}",
      ].join("\n"),
      "utf8",
    )

    const plugin: any = await QuartzPlugin({
      directory: root,
      client: {},
    } as never)

    const hidden = parse(await toolExecute(plugin, "type_transform_search", {
      from: "SourceShape",
      to: "TargetShape",
      limit: 10,
    }))
    const exposed = parse(await toolExecute(plugin, "type_transform_search", {
      from: "SourceShape",
      to: "TargetShape",
      includeFailedVerification: true,
      includeDiagnostics: true,
      includeSyntheticCode: true,
      limit: 10,
    }))
    const failed = exposed.results?.find((result: any) => result.verification.reason === "synthetic_check_failed")

    expect(hidden.results?.every((result: any) => result.verification.reason !== "synthetic_check_failed") ?? true).toBe(true)
    expect(failed).toMatchObject({
      name: "SecretMapper.map",
      verification: {
        status: "unverified",
        method: "synthetic",
        reason: "synthetic_check_failed",
        diagnostics: expect.arrayContaining([
          expect.objectContaining({
            code: expect.any(Number),
            message: expect.stringContaining("SecretMapper"),
          }),
        ]),
        syntheticCode: expect.stringContaining("SecretMapper"),
      },
    })
  })
})
