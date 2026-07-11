import { version } from "typescript"

/**
 * The TypeScript version that backs the native engine's analysis. This is the
 * pinned `typescript` nightly, read from its lightweight version-only entry
 * (safe to import on any runtime — it does not spawn the native server).
 */
export const nativeAnalysisTypescriptVersion = (): string => version
