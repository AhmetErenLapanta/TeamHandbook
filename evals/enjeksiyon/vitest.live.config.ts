// The live layer runs under its own config, and the reason is mechanical rather than
// tidy: the repo's gate requires skipped=0 over the whole suite, so a live file that
// sat in the default run as a skipped test would fail the gate on every card. Its name
// carries no `.test.` segment, so vitest's default include never collects it, and this
// config is the only way to reach it:
//
//     TEAMHANDBOOK_INJECTION_LIVE=1 npx vitest run --config evals/enjeksiyon/vitest.live.config.ts
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    root: fileURLToPath(new URL("../..", import.meta.url)),
    include: ["evals/enjeksiyon/behavioral.live.ts"],
    // one model call per payload at the product's 180s timeout, run four at a time
    testTimeout: 60 * 60 * 1000,
    hookTimeout: 60_000,
  },
});
