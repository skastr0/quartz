# Effect v4 migration

Quartz migrated its Effect-powered CLI from Effect v3 to the exact `4.0.0-rc.112` release candidate. Effect v4 was not yet the npm `latest` release when this migration was performed, so the dependency is pinned rather than expressed as a range.

## Scope

Repository inventory found one direct Effect dependency and one Effect source file:

- `apps/cli/package.json`
- `apps/cli/src/main.ts`

The engine and OpenCode plugin are ordinary TypeScript built around Promise APIs. The plugin's upstream `@opencode-ai/plugin` peer carries an isolated transitive Effect copy, but Quartz does not import it. Migrating the engine or plugin to Effect was therefore not necessary to remove Quartz's v3 usage.

## Migration steps

1. Pin `effect@4.0.0-rc.112` and regenerate the Bun lockfile.
2. Replace v3 Schema constructors with v4 equivalents: array-based unions and literals, `Schema.Int` checks, `Schema.ConstraintDecoder`, `decodeUnknownEffect`, and `toJsonSchemaDocument`.
3. Use `Schema.optionalKey` for JSON payload fields. Generic v4 `Schema.optional` documents `null` even though Quartz's `decodeUnknownEffect` path rejects it; exact optional keys keep discovery output aligned with accepted JSON.
4. Adopt Standard Schema V1 validation issue formatting while retaining Quartz's dotted paths and batch item prefixes.
5. Replace `Either` with `Result`, `catchAll` with `catch`, `catchAllDefect` with `catchDefect`, and `timeoutFail` with `timeoutOrElse`.
6. Put the per-run analyzer cache behind `Context.Service` and a scoped `Layer.effect`. The scope reuses analyzers across batch items and disposes them on success, failure, timeout, or interruption.
7. Verify generated schemas, validation failures, timeout failures, builds, docs examples, package boundaries, and the complete test suite.

The public `agentic-cli/v1` envelopes and command payload semantics remain intact. JSON Schema representation and validation wording now follow Effect v4 rather than emulating removed v3 internals.

## Quartz dogfood results

Quartz was run against its own CLI before and during the migration.

| Workflow | Observed result | Value to the migration |
| --- | --- | --- |
| `file` on `apps/cli/src/main.ts` with private declarations | 122 declarations in about 2.5 seconds | Produced a compact ownership and type inventory. |
| Batched `at-position` probes over Schema calls | 30 of 30 probes in about 2.6 seconds | Made current v3 types cheap to inspect without 30 cold analyzer starts. |
| `related` on `__testing` | Found the CLI test consumers | Identified the cache test affected by scoped lifecycle work. |
| `refactor-preview` on `runCli` | Two safe locations and no predicted diagnostics | Confirmed project-local rename impact. |
| `schema show` plus invalid payload execution | Exposed schema/decoder agreement as a contract | Helped catch the v4 optional-field `null` mismatch. |
| `diagnostics` on the repository | No diagnostics before or after migration | Supplied a fast compiler-backed regression check. |

Quartz helped most with inventory, project-local references, current type inspection, and public contract checks. Warm batch probing was substantially more useful than repeated one-shot commands.

It did not supply Effect v4 migration knowledge. Its analyzer reflects the installed dependency, so authoritative v4 declarations and migration notes were still required. Private symbols were available through `file` and `at-position`, but not through every symbol command. `check-snippet` also could not resolve the CLI-local `effect` package from a virtual file rooted at the workspace, and expression-based compatibility checks are limited to resolvable project symbols. These are concrete opportunities to improve Quartz for dependency migrations.

## Optional future expansion

A deeper Effect architecture could expose an Effect-native engine facade and let the OpenCode adapter use a managed runtime. That would be a separate public API design: the compiler analysis algorithms themselves should remain plain TypeScript, while Effect would own resource acquisition, typed failures, concurrency, and adapter boundaries. This migration deliberately preserves the engine and plugin contracts instead of forcing that redesign into a dependency upgrade.
