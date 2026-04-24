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
        type_diagnostics: expect.any(Object),
        type_at_position: expect.any(Object),
      }),
    )
    expect(plugin.event).toEqual(expect.any(Function))
  })
})

