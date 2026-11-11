import { join } from "node:path";
import { defineConfig } from "@playwright/test";
import { labDir } from "./state.js";

// The suite runs against a lab `npm run lab` started; it starts nothing of its own but the
// throwaway orchestrator the tenant spec needs. Its output stays in the lab directory, so
// `npm run lab:down` takes it away with everything else.
export default defineConfig({
  testDir: "tests",
  timeout: 120_000,
  // The lab shares its machine with whatever else runs there; a screen that answers in five
  // seconds when the machine is idle can take longer under load.
  expect: { timeout: 15_000 },
  // The organizations' repositories are shared by every spec, and a merge moves a
  // repository another test has open; the specs run one after another.
  workers: 1,
  outputDir: join(labDir(), "test-results"),
  reporter: [["list"], ["html", { outputFolder: join(labDir(), "report"), open: "never" }]],
  use: { trace: "retain-on-failure" },
});
