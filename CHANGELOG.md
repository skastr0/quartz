# Changelog

All notable changes to quartz will be documented in this file.

The project follows Semantic Versioning for the declared public package, CLI, and plugin surfaces. While quartz is in `0.y.z`, APIs and command behavior may still change, but user-visible breaking changes should be called out here.

## [0.2.0] - 2026-08-17

Initial release of the native-engine product path.

### Changed

- Replaced the legacy `@skastr0/quartz-core` ts-morph service spine with `@skastr0/quartz-engine`, a single persistent TypeScript 7 native workspace and direct Promise-based analyzer API.
- Removed runtime engine selection and fallback fields; CLI and OpenCode plugin now report and use the native engine unconditionally.
- Platform npm packages now carry the matching TypeScript native executable dependency required by the engine.
- Pinned TypeScript / TS-Go to exact `7.1.0-dev.20260723.1` (never `@next`).
- Temporary analysis (snippets, synthetic transform verification) uses `runWithTemporaryFileUpdate` so the base snapshot stays immutable; the JS hybrid filesystem is no longer on the normal project-read path.
- OpenCode plugin keeps one analyzer for the process and disposes on `session.deleted` / process exit.

### Performance

- Restored a durable multi-mode benchmark harness (`bun run bench:pr` / `bench:release`) with frozen baseline artifacts under `docs/bench/`.
- Refactor preview uses compiler-native `getReferencedSymbolsForNode` (monorepo warm p50 ~3.4s → ~12ms on the measured M1 host).
- Transform-search caches its candidate/type index by workspace revision and bounds synthetic verification to `limit + 10` overscan.
- Measured pin and architecture deltas are recorded in `docs/bench/`; treat any 10× claim as workload-specific evidence only.
- `related` no longer re-resolves an already-canonical target symbol for every incoming reference, reducing redundant native checker work without changing results.

### Added

- Unstable API contract tests for surfaces Quartz consumes (including `runWithTemporaryFileUpdate`).
- Isolated `typescript@next` canary (`bun run canary:typescript`, scheduled GitHub workflow) that never auto-bumps the repository pin.
- `docs/performance.md` describing cold CLI vs warm batch vs plugin paths.
- `why-error` now accepts schema-visible code, message, or `file` + `line` diagnostic selectors through the CLI, and package command inventories include the composed `verify-contract` surface.

### Fixed

- GitHub Release assets now bundle the exact matching TypeScript native payload and are smoke-tested outside the repository before a draft release is created.
- Native project loading now canonicalizes package-store symlinks, preserving referenced `@types` dependencies.
- Native related-symbol and graph results now resolve imported aliases, avoid duplicate semantic edges, treat primitive literal unions as graph leaves, and report one-based rename columns.
- Temporary snippet/transform analysis no longer mutates the global base snapshot; concurrent temporary updates stay isolated via `runWithTemporaryFileUpdate`.
- Generic inspection now reports instantiated property types through `info` and `expand`, while `at-position` resolves a generic head to its enclosing type reference instead of `any`.

## [0.1.0] - 2026-06-02

### Added

- Initial experimental Quartz CLI for TypeScript code intelligence.
- Reusable analyzer core with package discovery, symbol inspection, type expansion, diagnostics, snippet checking, graphing, refactor preview, and transform search.
- OpenCode plugin wrapper exposing the analyzer through tool calls.
- Local verification gates for typechecking, tests, documentation examples, package boundaries, and regression coverage.
- Publishable npm package boundary for `@skastr0/quartz-core`, including built ESM output and TypeScript declarations.
- Publishable npm package boundary for `@skastr0/quartz-opencode-plugin`, including built ESM output and TypeScript declarations.
- Publishable npm CLI package boundary for `@skastr0/quartz`, backed by per-platform optional binary packages.
- GitHub Actions release lanes for npm trusted publishing and draft CLI binary releases.
- Package dry-run verification command for npm package contents.
- Documentation correction issue template.

### Changed

- Repository verification now builds publishable outputs before running tests and package-boundary checks.
- Contribution guidance now uses an issues-first solo-maintainer policy.
- Workspace root package is named `@skastr0/quartz-workspace` so the future public CLI package name remains available.
- npm package manifests now include repository directories, keywords, and explicit public publish config.
- OpenCode plugin package build now stays thin by externalizing `@skastr0/quartz-core`, `effect`, and `@opencode-ai/plugin`.
- Release gates now live in `docs/publishing.md`; the temporary coordination file has been removed.
