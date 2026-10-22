import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { afterAll, afterEach } from "vitest";

// Every test file gets a handbook home of its own. Plenty of code reaches the state
// directory through a default nobody passes in a test (the clones doctor, publish and
// upgrade make go under it), so without this a test run wrote into the developer's real
// ~/.teamhandbook, or into whatever TEAMHANDBOOK_HOME their shell happened to point at.
// A test that needs a particular home still sets its own; this is only the floor.
const home = mkdtempSync(join(tmpdir(), "handbook-suite-home-"));
process.env.TEAMHANDBOOK_HOME = home;
afterAll(() => rmSync(home, { recursive: true, force: true }));

// The floor above only holds while nothing reaches the state directory around it, and a
// new default that builds the path from homedir() would undo it without failing a single
// case. Where the real one does not exist yet (CI, a fresh home), a file that creates it
// fails here and names the place.
const realHandbookHome = join(homedir(), ".teamhandbook");
const realHandbookHomeExisted = existsSync(realHandbookHome);
afterAll(() => {
  if (!realHandbookHomeExisted && existsSync(realHandbookHome)) {
    throw new Error(`this file created ${realHandbookHome}; a test must not reach the real handbook home`);
  }
});

// The worker reports results to the main process over an RPC whose 60s deadline is a
// timer in the worker itself. The runner goes from one test to the next without handing
// the event loop back, and most cases here drive git synchronously, so a file whose cases
// add up to more than 60s never reads the reply: when the loop finally turns, timers run
// before I/O and the deadline fires on an answer that is already waiting. Every case
// passes and the run still exits 1 with `Timeout calling "onTaskUpdate"`. Measured: 14
// cases of a blocking 5s each reproduced it on an idle machine, 10 did not, and with this
// hook 24 of them (120s) exited 0. setImmediate rather than a timer, because the check
// phase comes after the poll phase that reads the reply.
afterEach(() => setImmediate());
