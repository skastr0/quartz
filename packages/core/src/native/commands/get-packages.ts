import type { TypeAnalyzer } from "../../analyzer"
import { discoverPackages } from "../../discovery"
import type { NativeCommandContext } from "../context"

/**
 * Package discovery is engine-agnostic — it walks tracked tsconfig files and
 * needs neither ts-morph nor the native server. The native engine therefore
 * implements it for real (delegating to the shared `discoverPackages`) rather
 * than stubbing it, so `doctor` and package resolution work under
 * QUARTZ_ENGINE=native. Every *type-analysis* command remains stubbed until its
 * owning builder implements it.
 */
export const getPackages =
  (ctx: NativeCommandContext): TypeAnalyzer["getPackages"] =>
  () =>
    discoverPackages(ctx.rootDirectory)
