import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"
import pluginModule, { TypeLevelToolsPlugin } from "../apps/opencode-plugin/src/server"

const toolExecute = async (plugin: any, name: string, args: Record<string, unknown> = {}) =>
  plugin.tool[name].execute(args)

const parse = (value: string) => JSON.parse(value) as any

describe("OpenCode plugin wrapper", () => {
  it("exports a server plugin module", () => {
    expect(pluginModule.id).toBe("type-level-tools")
    expect(pluginModule.server).toBe(TypeLevelToolsPlugin)
  })

  it("keeps OpenCode-specific behavior in the wrapper", async () => {
    const log = vi.fn()
    const plugin: any = await TypeLevelToolsPlugin({
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
      }),
    )
    expect(plugin.event).toEqual(expect.any(Function))
  })

  it("executes representative tools with preserved argument propagation", async () => {
    const plugin: any = await TypeLevelToolsPlugin({
      directory: new URL("./fixtures", import.meta.url).pathname,
      client: {},
    } as never)

    const diagnostics = parse(await toolExecute(plugin, "type_diagnostics", { explain: true }))
    const info = parse(await toolExecute(plugin, "type_info", { symbol: "User" }))
    const symbols = parse(await toolExecute(plugin, "type_symbols", { pattern: "^User", kind: "interface", limit: 1 }))
    const graph = parse(await toolExecute(plugin, "type_graph", { symbol: "ExtendedUser", depth: 1, format: "dot" }))
    const compatible = parse(await toolExecute(plugin, "type_compatible", { from: "ExtendedUser", to: "User" }))
    const file = parse(await toolExecute(plugin, "type_file", { file: "types/basic.ts", symbol: "^User$", includePrivate: false }))
    const explainedType = parse(await toolExecute(plugin, "type_explain", { expression: 'Pick<User, "id">' }))
    const transformSearch = parse(await toolExecute(plugin, "type_transform_search", { from: "User", to: "UserDTO", limit: 1 }))
    const whyError = parse(await toolExecute(plugin, "type_why_error", {
      code: 2322,
      message: "Type UserInput is not assignable to type User",
    }))

    expect(diagnostics).toMatchObject({ totalErrors: 0, explained: 0 })
    expect(info).toMatchObject({ name: "User", kind: "interface" })
    expect(symbols).toMatchObject({
      symbols: [expect.objectContaining({ name: "User", kind: "interface" })],
      truncated: true,
    })
    expect(graph).toMatchObject({ root: "ExtendedUser", format: "dot", depth: 1 })
    expect(graph.graph).toContain("digraph")
    expect(compatible).toMatchObject({ compatible: true })
    expect(file.declarations.map((declaration: any) => declaration.name)).toEqual(["User"])
    expect(explainedType.final).toContain("id")
    expect(transformSearch.results[0]).toMatchObject({ name: expect.stringContaining("toDTO") })
    expect(whyError).toMatchObject({
      explanation: expect.stringContaining("UserInput"),
      issues: [expect.objectContaining({ kind: "missing_property", property: "id" })],
    })
  })

  it("preserves idle logging and dirty-cache hook behavior", async () => {
    const root = mkdtempSync(join(tmpdir(), "tlt-plugin-"))
    mkdirSync(join(root, "src"))
    writeFileSync(join(root, "tsconfig.json"), JSON.stringify({ include: ["src/**/*.ts"] }), "utf8")
    const sourcePath = join(root, "src", "types.ts")
    writeFileSync(sourcePath, "export interface TempUser { name: string }\n", "utf8")

    const log = vi.fn()
    const plugin: any = await TypeLevelToolsPlugin({
      directory: root,
      client: { app: { log } },
    } as never)

    const before = parse(await toolExecute(plugin, "type_info", { symbol: "TempUser" }))
    writeFileSync(sourcePath, "export interface TempUser { name: string; age: number }\n", "utf8")
    await plugin["tool.execute.after"]({ tool: "write" })
    const after = parse(await toolExecute(plugin, "type_info", { symbol: "TempUser" }))
    const refresh = await toolExecute(plugin, "type_refresh")

    await plugin.event({ event: { type: "session.idle", properties: { sessionID: "session-1" } } })

    expect(before.properties.map((property: any) => property.name)).toEqual(["name"])
    expect(after.properties.map((property: any) => property.name)).toEqual(["name", "age"])
    expect(refresh).toContain("Refreshed all TypeScript projects")
    expect(log).toHaveBeenCalledWith({
      body: expect.objectContaining({
        service: "type-level-tools",
        level: "debug",
        extra: { sessionID: "session-1" },
      }),
    })
  })
})
