import { nativeLoadFailure } from "./errors"

/**
 * Runtime capability guard for the native engine.
 *
 * The TypeScript native sync API (`typescript/unstable/sync`) spawns a `tsgo`
 * child process and, on POSIX, reads `child.stdout._handle.fd` to wire up its
 * synchronous RPC channel. That `_handle` internal is a Node.js implementation
 * detail Bun does not expose, so constructing `new API(...)` under Bun throws
 * (and can leave a stranded child). We therefore refuse to even attempt it under
 * a non-Node runtime and let engine selection fall back to the morph engine.
 *
 * Importing the native modules is safe on every runtime; only *constructing* the
 * API is Node-only. This guard is the cheap, deterministic check that keeps the
 * Bun-hosted CLI from ever reaching that construction.
 */
export const isNativeRuntimeSupported = (): boolean => typeof process.versions.bun === "undefined"

export const describeRuntime = (): string =>
  typeof process.versions.bun === "undefined" ? `Node.js ${process.versions.node}` : `Bun ${process.versions.bun}`

export const assertNativeRuntimeSupported = (): void => {
  if (!isNativeRuntimeSupported()) {
    throw nativeLoadFailure(
      `The native TypeScript engine requires a Node.js runtime; detected ${describeRuntime()}. ` +
        `The native sync API relies on Node child-process file descriptors that Bun does not expose.`,
    )
  }
}
