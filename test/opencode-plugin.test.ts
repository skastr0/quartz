import { describe, expect, it, vi } from "vitest"
import pluginModule, { TypeLevelToolsPlugin } from "../apps/opencode-plugin/src/server"

describe("OpenCode plugin wrapper", () => {
  it("exports a server plugin module", () => {
    expect(pluginModule.id).toBe("type-level-tools")
    expect(pluginModule.server).toBe(TypeLevelToolsPlugin)
  })

  it("keeps OpenCode-specific behavior in the wrapper", async () => {
    const log = vi.fn()
    const plugin = await TypeLevelToolsPlugin({
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
})
