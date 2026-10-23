import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterAll } from "vitest";

// Every test file finds a gh and a glab of the suite's own before the developer's. Code that
// opens or checks a merge request defaults to the real forge runner, and a test that does not
// pass one ran whatever CLI the machine had: upgrade.test's plan cases ran the real
// `glab auth status`, which writes glab's config under HOME and answers from the account the
// developer is signed in to, so a case could pass on one machine and fail on another. These
// stand-ins refuse the way a CLI that is not signed in does; a test that needs a forge to
// answer installs its own ahead of them on PATH.
// `claude` for the same reason: a test that runs a shipped bundle puts its own stand-in first,
// and when that one cannot execute (a noexec tmpdir, a restrictive umask) Node runs the next
// `claude` on PATH, which would hand the test's prompt to the developer's real model.
const floor = mkdtempSync(join(tmpdir(), "handbook-suite-forge-"));
for (const tool of ["gh", "glab", "claude"]) {
  const stub = join(floor, tool);
  writeFileSync(stub, `#!/bin/sh\necho "${tool} is not reachable from the test suite" >&2\nexit 1\n`);
  chmodSync(stub, 0o755);
}
process.env.PATH = `${floor}${delimiter}${process.env.PATH ?? ""}`;
afterAll(() => rmSync(floor, { recursive: true, force: true }));
