import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { createTypeAnalyzer } from "@type-level-tools/core"

const currentDirectory = dirname(fileURLToPath(import.meta.url))
export const fixturesPath = join(currentDirectory, "..", "fixtures")

export const createFixtureAnalyzer = () => createTypeAnalyzer(fixturesPath)

