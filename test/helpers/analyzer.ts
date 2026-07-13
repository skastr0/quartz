import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const currentDirectory = dirname(fileURLToPath(import.meta.url))
export const fixturesPath = join(currentDirectory, "..", "fixtures")
