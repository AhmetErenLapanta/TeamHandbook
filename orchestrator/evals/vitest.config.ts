import { defineConfig } from "vitest/config";

// The evals are their own suite, outside the orchestrator's include list, so `npm test` and CI never
// collect them: a live run calls a real model and costs money.
export default defineConfig({
  test: {
    include: ["evals/**/*.eval.ts"],
    testTimeout: 1_800_000,
  },
});
