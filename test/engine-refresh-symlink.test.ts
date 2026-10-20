import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { AnalyzerContext } from "../packages/engine/src/context"
import { createReferenceOperations } from "../packages/engine/src/reference-operations"

/** The project lives at `real`; every path the test uses goes through the symlink `link`. */
const createFixture = async () => {
  const real = realpathSync(mkdtempSync(join(tmpdir(), "quartz-engine-symlink-real-")))
  mkdirSync(join(real, "src"), { recursive: true })
  writeFileSync(
    join(real, "tsconfig.json"),
    JSON.stringify({ compilerOptions: { target: "ESNext", module: "ESNext", moduleResolution: "Bundler", strict: true, skipLibCheck: true }, include: ["src/**/*.ts"] }),
  )
  writeFileSync(join(real, "src", "model.ts"), "export interface Alpha { id: string }\n")
  writeFileSync(join(real, "src", "doomed.ts"), "export interface Doomed { id: string }\n")
  const link = join(mkdtempSync(join(tmpdir(), "quartz-engine-symlink-")), "project")
  symlinkSync(real, link)
  const context = await AnalyzerContext.open(link)
  return { link, context, operations: createReferenceOperations(context) }
}

describe("engine partial refresh through a symlinked root", () => {
  it("applies changed, created and deleted notifications given as symlinked paths", async () => {
    const { link, context, operations } = await createFixture()
    try {
      expect(await operations.findRelated("Alpha")).not.toBeNull()
      expect(await operations.findRelated("Doomed")).not.toBeNull()

      writeFileSync(join(link, "src", "model.ts"), "export interface Beta { id: string }\n")
      writeFileSync(join(link, "src", "extra.ts"), "export interface Epsilon { id: string }\n")
      rmSync(join(link, "src", "doomed.ts"))
      await context.refresh({
        changed: [join(link, "src", "model.ts")],
        created: [join(link, "src", "extra.ts")],
        deleted: [join(link, "src", "doomed.ts")],
      })

      expect(await operations.findRelated("Beta")).not.toBeNull()
      expect(await operations.findRelated("Alpha")).toBeNull()
      expect(await operations.findRelated("Epsilon")).not.toBeNull()
      expect(await operations.findRelated("Doomed")).toBeNull()
    } finally {
      await context.close()
    }
  })
})
