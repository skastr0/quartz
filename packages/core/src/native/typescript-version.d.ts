// The `typescript` package's main entry (`.`) resolves to `./lib/version.cjs`,
// whose exports map ships no `types` condition, so TypeScript cannot resolve
// declarations for a bare `import ... from "typescript"`. This ambient module
// supplies just the version constants the native engine reports. It does NOT
// affect the `typescript/unstable/*` subpaths, which carry their own types.
declare module "typescript" {
  export const version: string
  export const versionMajorMinor: string
}
