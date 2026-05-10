# Release Plan

## Verdict
Ready for the current private release-readiness checkpoint. Do not publish npm packages or flip repository visibility until the explicit pre-public checks below are completed.

## Public Promise
Experimental. TypeScript code intelligence and transform search tooling is useful enough to inspect and try, but APIs, packaging, and support expectations may change.

## Package Publishing Boundary
TypeScript/Bun workspace: npm for scoped packages that should be consumable, plus GitHub Releases/Homebrew for CLI binaries when needed.

Do not publish from automation yet. First public release should be manual after repository visibility, registry auth, trusted publishing/token setup, and package dry-runs are reviewed.

Current package decision:

- `@skastr0/quartz-core`: publishable npm boundary later, after dist/types package contents are inspected.
- `@skastr0/quartz-cli`: CLI binary boundary first; npm package remains private until the install story is intentionally chosen.
- `@skastr0/quartz-opencode-plugin`: separate npm package later; depends directly on `effect` and keeps OpenCode as a peer.

## Blockers
None for this checkpoint. Public visibility and npm publishing remain intentionally gated by the "Minimum Before Public" list.

## Project-Specific Audit Notes
- Workspace packages remain private. Core exports still point at TypeScript source for local workspace ergonomics; define dist/types exports before npm publishing.
- `apps/cli` and `apps/opencode-plugin` both declare direct `effect` dependencies because they import Effect at their runtime edges.
- Publish-scan semgrep hits were triaged as false positives from transform-search token terminology and generated index fields, not secrets.
- Publish-scan ast-grep hit was triaged as a false positive for the `__token_syntax_test__.ts` fixture name.
- Security keyword hits are from docs, fixture field names (`secret`, `apiKey`, `token`, `password`), and CLI token parsing terminology. Confidential keyword hits were zero.

## Minimum Before Public
- Confirm all source, docs, fixtures, prompts, screenshots, and generated artifacts are owned by the project or safe to publish.
- Re-run publish-scan after this checkpoint and review the latest output directory.
- Run the verification commands below on a clean checkout.
- Enable GitHub secret scanning, push protection, and private vulnerability reporting before or immediately after the visibility flip.
- Dependabot config is present in `.github/dependabot.yml`; confirm alerts are enabled in repository settings.
- Keep registry publishing disabled until dry-runs and package contents are inspected.

## Verification
- bun run verify
- bun run typecheck
- bun run test
- bun run build

## First Publish Steps
1. Keep the repository private and finish blocker cleanup.
2. Run local verification and publish-scan.
3. Inspect package contents with npm pack/bun publish --dry-run or cargo package --list, depending on the project.
4. Make the repository public only after the public files and security settings are ready.
5. Publish manually to the chosen registry or create a draft GitHub Release.
6. Add Homebrew tap/formula work only after the first release asset shape is stable.

## Latest Scan
- Latest publish-scan output: /Users/guilhermecastro/.local/state/publish-scan/home_Projects_quartz/20260509T082506Z
- Confidential keyword hits: 0
- Security keyword hits: 47
- Semgrep/ast-grep hits: 8/1
- Triage status: acknowledged false positives for this checkpoint; re-run required before public visibility or npm publishing.

## Notes
- License: MIT.
- Package scope target: @skastr0 for npm packages.
- Actual npm, crates.io, GitHub Release, and Homebrew publication remains intentionally out of scope for this prep pass.
