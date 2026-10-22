import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";

// Every test file gets a handbook home of its own. Plenty of code reaches the state
// directory through a default nobody passes in a test (the clones doctor, publish and
// upgrade make go under it), so without this a test run wrote into the developer's real
// ~/.teamhandbook, or into whatever TEAMHANDBOOK_HOME their shell happened to point at.
// A test that needs a particular home still sets its own; this is only the floor.
const home = mkdtempSync(join(tmpdir(), "handbook-suite-home-"));
process.env.TEAMHANDBOOK_HOME = home;
afterAll(() => rmSync(home, { recursive: true, force: true }));
