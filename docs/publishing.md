# Publishing

Quartz publishes through CI after an explicit human gate. Do not publish npm packages, push release tags, create GitHub Releases, or flip repository visibility from a local machine without an intentional release decision.

## Public Promise

Quartz is experimental. The CLI protocol, package exports, plugin tool surface, and distribution channels may change while the project is in `0.y.z`. User-visible breaking changes should be documented in `CHANGELOG.md`.

## Package Map

| Artifact | Status | Channel |
| --- | --- | --- |
| `@skastr0/quartz-engine` | publishable | npm |
| `@skastr0/quartz-opencode-plugin` | publishable | npm |
| `@skastr0/quartz` npm CLI wrapper | publishable | npm |
| `@skastr0/quartz-darwin-arm64` | publishable | npm optional platform package |
| `@skastr0/quartz-darwin-x64` | publishable | npm optional platform package |
| `@skastr0/quartz-linux-arm64` | publishable | npm optional platform package |
| `@skastr0/quartz-linux-x64` | publishable | npm optional platform package |
| `quartz` self-contained CLI archives | publishable | GitHub Releases |
| `@skastr0/quartz-cli` source app | private | workspace source package, not published |
| `@skastr0/quartz-workspace` root package | private | not published |

## Local Preflight

```bash
bun install --frozen-lockfile
bun run verify
bun run pack:dry-run
bun audit
publish-scan .
```

`publish-scan` output is private evidence and may include sensitive snippets. Review the output directory locally; do not paste raw scan output into public issues or release notes.

## Public Release Gates

Complete these gates before making the repository public, pushing a release tag, dispatching a publish workflow, or publishing a GitHub Release:

- confirm source, docs, fixtures, prompts, screenshots, generated artifacts, and committed history are owned by the project or safe to publish
- re-run the local preflight from a clean checkout and manually review the latest `publish-scan` output directory
- enable GitHub secret scanning, push protection, dependency graph, Dependabot alerts, and private vulnerability reporting
- update the GitHub repository description and topics
- choose and complete the first npm package creation path before relying on trusted publishing
- create and protect the GitHub `release` environment with maintainer approval and release-tag restrictions
- configure main-branch protection or a ruleset once repository visibility and the GitHub plan allow it
- keep `@skastr0/quartz-cli` private; publish `@skastr0/quartz` as the npm runner package
- get explicit maintainer approval for each external action: visibility flip, tag push, workflow dispatch, protected-environment approval, package upload, draft release publication, or Homebrew tap update

## First npm Package Creation & Bootstrap

The standard publishing model is CI-first trusted publishing through `.github/workflows/npm-publish.yml`.

npm trusted publishing requires packages to exist on the registry before OIDC trust relationships can be registered. The initial package bootstrap has been completed:

1. Packages were bootstrapped with public access.
2. The GitHub `release` environment is created, protected with maintainer approval, and configured for `v*` release tags.
3. npm Trusted Publishing (`npm trust`) is configured across all seven packages.
4. All subsequent releases publish directly from GitHub Actions via `.github/workflows/npm-publish.yml` with signed Sigstore provenance.

## npm Trusted Publishing Setup

After the packages exist on npm, configure npm trusted publishers for:

- `@skastr0/quartz-engine`
- `@skastr0/quartz-opencode-plugin`
- `@skastr0/quartz-darwin-arm64`
- `@skastr0/quartz-darwin-x64`
- `@skastr0/quartz-linux-arm64`
- `@skastr0/quartz-linux-x64`
- `@skastr0/quartz`

Use repository `skastr0/quartz`, workflow filename `npm-publish.yml`, environment name `release`, and allow `npm publish`. npm asks for the filename only, not the full `.github/workflows/` path.

Trusted publishing requires a GitHub-hosted runner, `permissions.id-token: write`, Node `22.14.0` or newer, and npm `11.5.1` or newer. npm generates provenance automatically for public packages published from public repositories through trusted publishing.

## GitHub Release Setup

Before dispatching `.github/workflows/release-binaries.yml`:

- confirm the release tag exists and points at the reviewed commit
- confirm `CHANGELOG.md` has the intended release notes
- confirm the GitHub `release` environment requires approval

The workflow builds `darwin-x64`, `darwin-arm64`, `linux-x64`, and `linux-arm64` archives and creates a draft GitHub Release with `SHA256SUMS`. Each archive contains `bin/quartz`, the Quartz license, and the complete exact-version `@typescript/typescript-<platform>-<arch>` payload under `node_modules`, so the extracted CLI does not depend on repository or global modules. Keep the extracted directory intact and invoke its `bin/quartz`; copying only the binary discards the native payload. The workflow smokes the host archive from a clean temporary directory before creating the draft.

Create the `release` environment with maintainer approval, require reviewer approval, and restrict it to release tags before any publish workflow is dispatched.

## Publish Order

`@skastr0/quartz-engine` publishes before `@skastr0/quartz-opencode-plugin` because the plugin depends on the exact engine package version. The platform CLI packages publish before `@skastr0/quartz` because the main CLI package lists them as optional dependencies. Each platform package also depends on the matching `@typescript/typescript-<platform>-<arch>` executable used by the native engine. The publish workflows use explicit local package paths such as `npm publish "./packages/engine" --access public` so npm cannot interpret workspace paths as remote package specs. They skip package versions that already exist so a partially completed first release can be resumed from the same commit.

Publish order:

1. `packages/engine`
2. `apps/opencode-plugin`
3. `packages/npm/quartz-darwin-arm64`
4. `packages/npm/quartz-darwin-x64`
5. `packages/npm/quartz-linux-arm64`
6. `packages/npm/quartz-linux-x64`
7. `packages/npm/quartz`

## Homebrew Boundary

Homebrew is the right second install lane for the standalone CLI after the first GitHub Release asset shape is stable. Do not add a formula until there is a real release URL and checksum to test.

## Rollback Notes

npm versions should be treated as permanent. Prefer publishing a fixed version or deprecating a bad version over relying on unpublish. GitHub Release assets can be replaced, but users may already have downloaded them.
