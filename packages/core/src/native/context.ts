import type { NativeEngine } from "./engine"

/**
 * What every native command receives. Constructed once by the native analyzer
 * (see `index.ts`) and passed to each `commands/<command>.ts` factory. Kept in
 * its own module so command files and the frozen delegator both depend on it
 * without importing each other.
 */
export interface NativeCommandContext {
  readonly rootDirectory: string
  readonly engine: NativeEngine
}
