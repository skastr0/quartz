# @skastr0/quartz

Agent-native TypeScript code intelligence CLI for Quartz.

## Status

Experimental. The command protocol, package surface, and install channels may change while Quartz is in `0.y.z`.

## Run

```bash
npx -y @skastr0/quartz capabilities
```

```bash
bunx @skastr0/quartz capabilities
```

```bash
pnpm dlx @skastr0/quartz capabilities
```

The npm package uses a small Node launcher that selects the matching prebuilt Quartz binary for your platform. Supported npm binary packages are macOS arm64, macOS x64, Linux arm64, and Linux x64.

## Commands

Run `quartz capabilities` and `quartz schema list` to discover the protocol. The full CLI documentation lives in the repository README.
