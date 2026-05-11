# @skastr0/quartz-opencode-plugin

OpenCode plugin wrapper for Quartz TypeScript code intelligence.

## Build

```bash
bun run build
```

The bundle is written to `dist/server.js` and exported as `@skastr0/quartz-opencode-plugin/server`.

## Runtime Behavior

The plugin roots Quartz at the OpenCode workspace directory. It creates one Effect runtime, reuses the analyzer across tool calls, and marks the analyzer cache dirty after file-modifying tools such as `edit`, `write`, or `morph-mcp_edit_file`.

Use the optional `package` argument when the workspace has multiple discovered TypeScript packages.

## Tools

Discovery:

- `type_packages`
- `type_symbols`
- `type_info`
- `type_expand`
- `type_related`
- `type_search`

Analysis:

- `type_eval`
- `type_diagnostics`
- `type_check_snippet`
- `type_at_position`
- `type_file`
- `type_refresh`

Relationships and refactors:

- `type_compatible`
- `type_graph`
- `type_refactor_preview`
- `type_why_error`
- `type_explain`
- `type_transform_search`

## Examples

```json
{"tool":"type_symbols","args":{"pattern":"^User","kind":"interface","limit":10}}
```

```json
{"tool":"type_info","args":{"symbol":"User"}}
```

```json
{"tool":"type_transform_search","args":{"from":"User","to":"UserDTO","limit":5}}
```

The plugin returns JSON strings for most tool results, matching the core analyzer data shapes. `type_refresh` clears cached TypeScript projects and returns the analyzer refresh result.
