import { describe, it, expect } from "vitest";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname } from "node:path";
import config from "../vitest.config.js";

// Spelled out rather than imported: importing the setup module would set the home itself,
// and this guard would pass with the setup file gone from the config.
const SUITE_HOME_PREFIX = "handbook-suite-home-";

describe("the handbook home a test can reach", () => {
  it("given a test file, when it runs, then TEAMHANDBOOK_HOME is a home of its own under the system temp dir", () => {
    const home = process.env.TEAMHANDBOOK_HOME ?? "";

    expect(basename(home)).toMatch(new RegExp(`^${SUITE_HOME_PREFIX}`));
    expect(realpathSync(dirname(home))).toBe(realpathSync(tmpdir()));
  });

  it("given the vitest config, when its setup files are read, then the setup that sets that home and guards the real one is among them", () => {
    expect([config.test?.setupFiles].flat()).toContain("./src/test-setup.ts");
  });
});
