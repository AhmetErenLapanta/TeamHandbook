import { setImmediate } from "node:timers/promises";
import { afterEach } from "vitest";

// The worker reports results over an RPC whose 60s deadline is a timer in the worker, and
// the runner goes from one case to the next without handing the event loop back. These cases
// drive git synchronously, so a file whose cases add up to more than 60s never reads the reply
// and the run exits 1 with `Timeout calling "onTaskUpdate"` although every case passed. The
// plugin's suite measured the same failure and this same cure (src/test-setup.ts).
// setImmediate rather than a timer, because the check phase comes after the poll phase that
// reads the reply.
afterEach(() => setImmediate());

// An orchestrator started with nothing configured is one person's local orchestrator, which takes no setup
// code and no password; the suite's orchestrators are the configured self-hosted kind unless a case
// sets another mode itself.
process.env.ORCHESTRATOR_MODE ??= "self-hosted";
