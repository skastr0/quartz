import { mkdtemp, readFile, rm } from "node:fs/promises"
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

const isExactVersion = (value: string): boolean => /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value)

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
      "engine export map",
      [
        "bun",
        "-e",
        [
          'import { createTypeAnalyzer, analysisTsrsVersion, analysisTypeScriptVersion } from "@skastr0/quartz-engine";',
          'import type { GraphResult, RefactorPreviewResult } from "@skastr0/quartz-engine";',
          "const _graph: GraphResult | null = null;",
          "const _refactor: RefactorPreviewResult | null = null;",
          "if (typeof analysisTsrsVersion !== \"string\" || typeof analysisTypeScriptVersion !== \"string\") throw new Error(\"missing backend versions\");",
          "console.log(typeof createTypeAnalyzer, analysisTsrsVersion, analysisTypeScriptVersion, _graph, _refactor);",
        ].join(" "),
      ],
      join(root, "packages/engine"),
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

    await verifyPack("@skastr0/quartz-engine", join(root, "packages/engine"), destination, [
      "dist/index.js",
      "dist/index.d.ts",
      "LICENSE",
    ])
    await verifyPack("@skastr0/quartz-cli", join(root, "apps/cli"), destination, ["dist/main.js"])
    await verifyPack("@skastr0/quartz-opencode-plugin", join(root, "apps/opencode-plugin"), destination, [
      "dist/server.js",
      "dist/server.d.ts",
      "README.md",
      "LICENSE",
    ])

    const rootManifest = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as {
      readonly devDependencies?: Readonly<Record<string, string>>
    }
    const pinnedTsrs = rootManifest.devDependencies?.tsrs
    if (pinnedTsrs === undefined || !isExactVersion(pinnedTsrs)) {
      throw new Error("Root package.json must pin an exact tsrs release (never latest / range)")
    }
    const engineManifest = JSON.parse(await readFile(join(root, "packages/engine/package.json"), "utf8")) as {
      readonly dependencies?: Readonly<Record<string, string>>
    }
    if (engineManifest.dependencies?.tsrs !== pinnedTsrs) {
      throw new Error(
        `packages/engine must pin tsrs@${pinnedTsrs} (found ${engineManifest.dependencies?.tsrs ?? "missing"})`,
      )
    }

    // tsrs ships no Intel macOS binary, so there is no darwin-x64 platform package.
    const platformDependencies = {
      "quartz-darwin-arm64": "@tsrs/darwin-arm64",
      "quartz-linux-arm64": "@tsrs/linux-arm64-gnu",
      "quartz-linux-x64": "@tsrs/linux-x64-gnu",
    } as const
    for (const [packageDirectory, dependency] of Object.entries(platformDependencies)) {
      const manifest = JSON.parse(
        await readFile(join(root, "packages/npm", packageDirectory, "package.json"), "utf8"),
      ) as { readonly dependencies?: Readonly<Record<string, string>> }
      if (manifest.dependencies?.[dependency] !== pinnedTsrs) {
        throw new Error(`${packageDirectory} must depend on ${dependency}@${pinnedTsrs}`)
      }
    }

    await run("npm CLI package build", ["bun", "run", "build:npm-cli"])
    await verifyPack("@skastr0/quartz-darwin-arm64", join(root, "packages/npm/quartz-darwin-arm64"), destination, [
      "bin/quartz",
      "README.md",
      "LICENSE",
    ])
    await verifyPack("@skastr0/quartz-linux-arm64", join(root, "packages/npm/quartz-linux-arm64"), destination, [
      "bin/quartz",
      "README.md",
      "LICENSE",
    ])
    await verifyPack("@skastr0/quartz-linux-x64", join(root, "packages/npm/quartz-linux-x64"), destination, [
      "bin/quartz",
      "README.md",
      "LICENSE",
    ])
    await verifyPack("@skastr0/quartz", join(root, "packages/npm/quartz"), destination, [
      "bin/quartz.js",
      "README.md",
      "LICENSE",
    ])
    await run("npm CLI launcher", ["node", "packages/npm/quartz/bin/quartz.js", "capabilities"])
  } finally {
    await rm(destination, { force: true, recursive: true })
  }
}

await main()
console.log("package boundary verification passed")
