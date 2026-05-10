import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { createTypeAnalyzerRuntime } from "@skastr0/quartz-core"

const currentDirectory = dirname(fileURLToPath(import.meta.url))
export const fixturesPath = join(currentDirectory, "..", "fixtures")

export const createFixtureAnalyzer = () => createTypeAnalyzerRuntime(fixturesPath).analyzer
