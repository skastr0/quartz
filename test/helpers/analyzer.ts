import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { ManagedRuntime } from "effect"
import { CoreLayer, TypeAnalyzerService } from "@skastr0/quartz-core"

const currentDirectory = dirname(fileURLToPath(import.meta.url))
export const fixturesPath = join(currentDirectory, "..", "fixtures")

export const createFixtureAnalyzer = () => {
  return createAnalyzerForRoot(fixturesPath)
}

export const createAnalyzerForRoot = (root: string) => {
  const runtime = ManagedRuntime.make(CoreLayer(root))
  return runtime.runSync(TypeAnalyzerService)
}
