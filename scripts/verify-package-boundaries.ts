import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

interface CommandResult {
  readonly stdout: string
  readonly stderr: string
}

const root = process.cwd()

const run = async (label: string, args: readonly string[], cwd = root): Promise<CommandResult> => {
  const proc = Bun.spawn([...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])

  if (exitCode !== 0) {
    throw new Error(`${label} failed with exit code ${exitCode}\n${stdout}\n${stderr}`.trim())
  }

  return { stdout, stderr }
}

const assertContains = (label: string, output: string, expected: readonly string[]): void => {
  const missing = expected.filter((item) => !output.includes(item))
  if (missing.length > 0) {
    throw new Error(`${label} is missing expected package entries: ${missing.join(", ")}`)
  }
}

const verifyPack = async (
  name: string,
  cwd: string,
  destination: string,
  expectedEntries: readonly string[],
): Promise<void> => {
  const { stdout, stderr } = await run(
    `pack ${name}`,
    ["bun", "pm", "pack", "--dry-run", "--destination", destination],
    cwd,
  )
  assertContains(`pack ${name}`, `${stdout}\n${stderr}`, expectedEntries)
}

const main = async (): Promise<void> => {
  const destination = await mkdtemp(join(tmpdir(), "quartz-package-boundaries-"))

  try {
    await run(
      "core export map",
      [
        "bun",
        "-e",
        [
          'import { CoreLayer, TypeAnalyzerService } from "@skastr0/quartz-core";',
          'import { discoverPackages } from "@skastr0/quartz-core/discovery";',
          'import type { GraphResult, RefactorPreviewResult } from "@skastr0/quartz-core";',
          "const _graph: GraphResult | null = null;",
          "const _refactor: RefactorPreviewResult | null = null;",
          "console.log(typeof CoreLayer, typeof TypeAnalyzerService, typeof discoverPackages, _graph, _refactor);",
        ].join(" "),
      ],
      join(root, "packages/core"),
    )

    await run(
      "plugin export map",
      [
        "bun",
        "-e",
        [
          'import plugin from "@skastr0/quartz-opencode-plugin/server";',
          'if (plugin.id !== "quartz" || typeof plugin.server !== "function") throw new Error("bad plugin export");',
          "console.log(plugin.id);",
        ].join(" "),
      ],
      join(root, "apps/opencode-plugin"),
    )

    await verifyPack("@skastr0/quartz-core", join(root, "packages/core"), destination, [
      "src/index.ts",
      "src/discovery.ts",
      "src/project-types.ts",
    ])
    await verifyPack("@skastr0/quartz-cli", join(root, "apps/cli"), destination, ["dist/main.js"])
    await verifyPack("@skastr0/quartz-opencode-plugin", join(root, "apps/opencode-plugin"), destination, [
      "dist/server.js",
    ])
  } finally {
    await rm(destination, { force: true, recursive: true })
  }
}

await main()
console.log("package boundary verification passed")
