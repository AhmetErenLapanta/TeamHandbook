import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// A task runs while the orchestrator serves everyone else. A blocking call in it stops every
// request until it returns: a checkout or an add -A of a large repository takes seconds, and
// so does installing a team's thousands of skill files one write at a time. So the task code
// uses the background versions of git, the team readers and the file system.
const BLOCKING = /\b(?:git|gitMaybe|gitBytes|readTeamRecord|readTeamSetup|loadTreeSync)\(|\b[a-z]\w*Sync\(/;

/** Files allowed to block, each with the reason it does no harm. */
const ALLOWED: Record<string, string> = {
  "orphans.ts": "runs once at start, before any task of the process runs: the process table and the leftover directories",
  "transcript.ts": "read and written only by tests and the opt-in recorder; the orchestrator imports its type alone, and no task runs it",
  "guard-hook.ts": "the source of the run-as-me hook as text: Claude Code runs it as a program of its own, never the orchestrator",
};

describe("the task code and the event loop", () => {
  it("given the task runner's sources, when they are read, then none calls a blocking git, team reader or file system function outside the allowed files", () => {
    // given
    const dir = import.meta.dirname;
    const files = readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && !Object.hasOwn(ALLOWED, f));

    // when
    const blocking = files.flatMap((file) =>
      readFileSync(join(dir, file), "utf8")
        .split("\n")
        .map((line, i) => ({ where: `${file}:${i + 1}`, line: line.trim() }))
        .filter(({ line }) => BLOCKING.test(line) && !line.startsWith("//") && !line.startsWith("*")),
    );

    // then
    expect(files.length).toBeGreaterThan(5);
    expect(blocking).toEqual([]);
  });
});
