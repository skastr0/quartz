import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    globals: false,
    environment: "node",
  },
  resolve: {
    alias: {
      "@skastr0/quartz-engine": new URL("./packages/engine/src/index.ts", import.meta.url).pathname,
    },
  },
})
