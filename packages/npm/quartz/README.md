# @skastr0/quartz

Quartz answers an agent's TypeScript questions with the compiler's own answers: what a type contains, whether a snippet compiles, whether a converter already exists. Every answer is JSON.

## Install

```bash
npm install -g @skastr0/quartz
```

Or run it without installing: `npx -y @skastr0/quartz@latest capabilities`, or `bunx @skastr0/quartz capabilities`.

Prebuilt for macOS and Linux (arm64, x64). There is no Windows build. Quartz needs a `tsconfig.json` in the project.

## Use

Run these from a folder with a `tsconfig.json`:

```bash
quartz packages
quartz info '{"symbol":"User"}'
quartz check-snippet '{"code":"const u: User = { id: \"1\", name: \"Ada\" };"}'
```

`quartz capabilities` and `quartz schema list` describe every command. Full documentation: https://github.com/skastr0/quartz#readme
