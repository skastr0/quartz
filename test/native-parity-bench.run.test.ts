import { describe, it } from "vitest"
import { resolve } from "node:path"
import { isNativeRuntimeSupported } from "@skastr0/quartz-core"
import { runParity } from "../scripts/native-parity"
import { runBench } from "../scripts/native-bench"

/**
 * P6 evidence reproduction harness.
 *
 * The native engine only runs under Node with an unbundled typescript/unstable
 * client, which is exactly the host Vitest provides (source resolution + Node),
 * so the two evidence scripts are executed here rather than via a bare `node`
 * invocation. Gated behind QUARTZ_P6=1 so it never runs in the normal suite:
 *
 *   QUARTZ_P6=1 ./node_modules/.bin/vitest run \
 *     test/native-parity-bench.run.test.ts --disable-console-intercept
 *
 * The printed JSON is the source for docs/native-engine-bench.md.
 */
const enabled = process.env.QUARTZ_P6 === "1" && isNativeRuntimeSupported()
const ROOT = resolve("test/fixtures")

describe.runIf(enabled)("native parity + bench evidence", () => {
  it("parity across every implemented command", async () => {
    const report = await runParity(ROOT)
    console.log(`PARITY_JSON_START${JSON.stringify(report)}PARITY_JSON_END`)
  }, 240_000)

  it("benchmark diagnostics/expand/check-snippet/transform-search", async () => {
    const report = await runBench(ROOT)
    console.log(`BENCH_JSON_START${JSON.stringify(report)}BENCH_JSON_END`)
  }, 240_000)
})
