import { describe, it, expect } from "vitest";
import { accessSync, constants } from "node:fs";
import { basename, delimiter, dirname, join } from "node:path";

// Spelled out rather than imported: importing the setup module would install the stand-ins
// itself, and this guard would pass with the setup file gone from the config.
const FORGE_FLOOR_PREFIX = "handbook-suite-forge-";

// Resolved the way a spawn does, without running anything: running the CLI to see which one
// answers would run the developer's real one the moment this guard is needed.
function firstOnPath(tool: string): string | null {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, tool);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      continue;
    }
  }
  return null;
}

describe("the forge CLIs a test can reach", () => {
  it.each(["gh", "glab"])(
    "given a test that spawns %s by name, when PATH is searched, then the suite's own stand-in is found first",
    (tool) => {
      const found = firstOnPath(tool);
      expect(found).not.toBeNull();
      expect(basename(dirname(found!))).toMatch(new RegExp(`^${FORGE_FLOOR_PREFIX}`));
    },
  );
});
