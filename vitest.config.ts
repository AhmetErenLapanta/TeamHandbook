import { defineConfig } from "vitest/config";

// Vitest's 5s default deadline is thin for this suite. Most files drive real git against
// real bare repositories, and several that spawn nothing at all still write hundreds of
// files under mkdtemp. Measured: on an idle machine the slowest case is about 2s and the
// whole suite is green, but the same case was measured at 8.8s while the suite's own
// workers competed with other work on the machine, and one such run lost 5 cases to the
// deadline - every one of them "timed out in 5000ms" rather than an assertion. A case
// that times out under load has measured nothing, so the deadline is raised rather than
// the cases weakened. The slowest case measured under that contention was 11.6s, so 30s
// leaves more than twice the worst case actually observed.
// Hooks build the same repositories the bodies do, so they get the same allowance. A file
// that needs a different deadline can still set its own with vi.setConfig.
export default defineConfig({
  test: {
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
