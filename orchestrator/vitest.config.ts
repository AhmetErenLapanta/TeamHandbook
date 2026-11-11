import { defineConfig } from "vitest/config";

// Server tests drive real git against bare repositories under mkdtemp, like the plugin's
// own suite, so they get the same allowance for a loaded machine.
export default defineConfig({
  test: {
    include: ["scripts/**/*.test.ts", "server/**/*.test.ts", "runner/**/*.test.ts", "demo/**/*.test.ts", "web/src/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    setupFiles: ["./test-setup.ts"],
  },
});
