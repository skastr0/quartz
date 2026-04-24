import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    globals: false,
    environment: "node",
  },
  resolve: {
    alias: {
      "@type-level-tools/core": new URL("./packages/core/src/index.ts", import.meta.url).pathname,
    },
  },
})
