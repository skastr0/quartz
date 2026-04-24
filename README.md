# type-level-tools

Generic TypeScript type-analysis core and CLI with a thin OpenCode plugin app.

## Layout

- `packages/core`: reusable type-analysis behavior, independent of OpenCode.
- `apps/cli`: Effect CLI for package, symbol, type info, search, diagnostics, expand, and at-position commands.
- `apps/opencode-plugin`: OpenCode-specific tool registration, event hooks, logging, and session context behavior.

This pass ports a representative core set from the old local OpenCode plugin. The remaining old tools should move into `packages/core` before the legacy local plugin is removed.
