import { homedir } from "node:os"
import { join, resolve } from "node:path"

export const QUARTZ_HOME_ENV = "QUARTZ_HOME"

const envPath = (name: string): string | undefined => {
  const value = process.env[name]
  return value === undefined || value.trim() === "" ? undefined : value
}

export const quartzHome = (): string => resolve(envPath(QUARTZ_HOME_ENV) ?? join(homedir(), ".config", "quartz"))

export const defaultArtifactDirectory = (): string => join(quartzHome(), "artifacts")
