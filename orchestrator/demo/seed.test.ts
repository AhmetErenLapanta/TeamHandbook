import { describe, expect, it } from "vitest";
import { demoDataDir } from "./seed.js";

describe("where the demo is seeded", () => {
  it("given ORCHESTRATOR_DATA_DIR set and not set, when the demo picks its data directory, then it is the one named, or one of its own under the temporary folder and never the system's application place", () => {
    expect(demoDataDir({ ORCHESTRATOR_DATA_DIR: "/srv/orchestrator" }, "/tmp")).toBe("/srv/orchestrator");
    expect(demoDataDir({ ORCHESTRATOR_MODE: "local" }, "/tmp")).toBe("/tmp/teamhandbook-orchestrator-demo");
  });
});
