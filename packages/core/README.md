# @skastr0/quartz-core

Experimental TypeScript code intelligence core for Quartz.

`@skastr0/quartz-core` provides the reusable analyzer services behind the Quartz CLI and OpenCode plugin. It discovers TypeScript packages, inspects exported symbols, expands types, explains diagnostics, checks snippets, builds dependency graphs, and searches for structural transform candidates.

## Status

Experimental. Public exports may change while the analyzer and packaging settle. Breaking changes should be documented in the repository changelog before a public release.

## Install

```bash
bun add @skastr0/quartz-core
```

The package is ESM and publishes built JavaScript plus TypeScript declarations under `dist`.

## Exports

- `@skastr0/quartz-core`
- `@skastr0/quartz-core/discovery`
- `@skastr0/quartz-core/project-types`

## Development

```bash
bun install
bun run core:build
bun run verify
```

Security reports, support expectations, and contribution boundaries are documented in the repository root.
