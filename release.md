# Release Plan

## Verdict
Ready as an experimental open-source preparation checkpoint. Local release verification passed on 2026-05-18. Do not publish npm packages, push release tags, dispatch release workflows, or flip repository visibility until the explicit pre-public checks below are completed.

## Public Promise
Experimental. TypeScript code intelligence and transform search tooling is useful enough to inspect and try, but APIs, packaging, and support expectations may change.

## Package Publishing Boundary
TypeScript/Bun workspace: npm for scoped library/plugin packages and the npm CLI wrapper/platform packages, plus GitHub Releases for standalone CLI binaries. Homebrew should wait until the first GitHub Release asset shape is stable.

Real publication is CI-only by default. First public release should happen after repository visibility, registry auth, trusted publishing setup, protected `release` environment approval, and package dry-runs are reviewed.

Current package decision:

- `@skastr0/quartz-core`: publishable npm package with built ESM output and TypeScript declarations.
- `@skastr0/quartz-opencode-plugin`: publishable npm package with built ESM output and TypeScript declarations; depends on `@skastr0/quartz-core`, depends directly on `effect`, and keeps OpenCode as a peer.
- `@skastr0/quartz`: publishable npm CLI wrapper with a Node launcher and optional per-platform binary packages.
- `@skastr0/quartz-darwin-arm64`, `@skastr0/quartz-darwin-x64`, `@skastr0/quartz-linux-arm64`, and `@skastr0/quartz-linux-x64`: publishable npm platform packages containing prebuilt standalone binaries.
- `@skastr0/quartz-cli`: workspace source app remains private and is not a registry publication target.
- `@skastr0/quartz-workspace`: workspace root remains private and is not a package publication target.

## Blockers
None for the local code checkpoint. Public visibility and npm publishing remain intentionally blocked by the external setup in "Minimum Before Public".

## Project-Specific Audit Notes
- The workspace root and CLI source app remain private by design.
- `packages/core` and `apps/opencode-plugin` now publish only `dist`, local package README files, and local package LICENSE files.
- The npm CLI lane follows the Pulsar-style main package plus per-platform optional packages pattern. The public `@skastr0/quartz` package exposes a Node launcher in `bin/quartz.js`; the Bun-native CLI is shipped as prebuilt platform binaries.
- Publishable package manifests include explicit repository directories, public scoped-package access, and registry-search keywords.
- `apps/cli` and `apps/opencode-plugin` both declare direct `effect` dependencies because they import Effect at their runtime edges.
- Package boundary verification is automated by `bun run verify:package-boundaries`; it exercises export maps and confirms dry-run package contents include built core output plus CLI/plugin `dist` entrypoints.
- `bun audit` is clean after updating `@opencode-ai/plugin` and overriding transitive `uuid` to `13.0.2`.
- Publish-scan semgrep hits were triaged as false positives from transform-search token terminology and generated index fields, not secrets.
- Publish-scan ast-grep hit was triaged as a false positive for the `__token_syntax_test__.ts` fixture name.
- Security keyword hits are from docs, fixture field names (`secret`, `apiKey`, `token`, `password`), and CLI token parsing terminology. Confidential keyword hits were zero.

## Minimum Before Public
- Confirm all source, docs, fixtures, prompts, screenshots, and generated artifacts are owned by the project or safe to publish.
- Re-run publish-scan after any release-readiness change and review the latest output directory.
- Run the verification commands below on a clean checkout.
- Enable GitHub secret scanning, push protection, and private vulnerability reporting before the visibility flip.
- Dependabot config is present in `.github/dependabot.yml`; GitHub API reported Dependabot alerts disabled on 2026-05-17, so enable alerts before the visibility flip.
- Update the GitHub repository description and topics before the visibility flip; the current remote description is stale and topics are empty.
- Configure npm trusted publishers for `@skastr0/quartz-core`, `@skastr0/quartz-opencode-plugin`, `@skastr0/quartz-darwin-arm64`, `@skastr0/quartz-darwin-x64`, `@skastr0/quartz-linux-arm64`, `@skastr0/quartz-linux-x64`, and `@skastr0/quartz` against `.github/workflows/npm-publish.yml`.
- Create and protect the GitHub `release` environment before dispatching `.github/workflows/npm-publish.yml` or `.github/workflows/release-binaries.yml`; GitHub API reported the environment missing on 2026-05-17.
- Configure main-branch protection or a ruleset once the repository is public if the current GitHub plan does not allow it while private.
- Keep `@skastr0/quartz-cli` private; publish `@skastr0/quartz` as the npm runner package.

## Verification
- bun run verify
- bun run pack:dry-run
- bun run verify:docs-examples
- bun run verify:regression-guard
- bun run typecheck
- bun run test
- bun run build
- bun run verify:package-boundaries
- bun run verify:effect-rewrite
- bun run verify:external-matrix
- bun run smoke:npm-cli
- bun audit
- publish-scan .

Latest local release check: `bun run release:check` passed on 2026-05-18.

## First Publish Steps
1. Keep the repository private and finish blocker cleanup.
2. Run `bun run release:check`, confirm the docs-example and external-matrix gates pass, and inspect the publish-scan output directory.
3. Run `bun run pack:dry-run` and inspect the npm package contents for core, the OpenCode plugin, platform CLI packages, and the main CLI wrapper.
4. Configure npm trusted publishers and the protected GitHub `release` environment.
5. Make the repository public only after the public files and security settings are ready.
6. Push the reviewed release tag or manually dispatch the release workflows after confirmation.
7. Add Homebrew tap/formula work only after the first release asset shape is stable.

## Latest Scan
- Latest publish-scan output: /Users/guilhermecastro/.local/state/publish-scan/home_Projects_quartz/20260518T202511Z
- Confidential keyword hits: 0
- Security keyword hits: 55
- Semgrep/ast-grep hits: 8/1
- Triage status: acknowledged false positives for this checkpoint; re-run required after any release-readiness change and before public visibility or npm publishing.

## Notes
- License: MIT.
- Package scope target: @skastr0 for npm packages.
- Actual npm, GitHub Release, and Homebrew publication remains intentionally gated by explicit maintainer confirmation.
