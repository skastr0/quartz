# Changelog

All notable changes to quartz will be documented in this file.

The project follows Semantic Versioning for the declared public package, CLI, and plugin surfaces. While quartz is in `0.y.z`, APIs and command behavior may still change, but user-visible breaking changes should be called out here.

## [Unreleased]

### Added

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

## [0.1.0] - 2026-05-15

### Added

- Initial experimental Quartz CLI for TypeScript code intelligence.
- Reusable analyzer core with package discovery, symbol inspection, type expansion, diagnostics, snippet checking, graphing, refactor preview, and transform search.
- OpenCode plugin wrapper exposing the analyzer through tool calls.
- Local verification gates for typechecking, tests, documentation examples, package boundaries, and regression coverage.
