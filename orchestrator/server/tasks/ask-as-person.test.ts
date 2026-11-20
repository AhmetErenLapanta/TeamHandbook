import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { claudeCodeAdapter } from "./agents.js";
import { askAgent } from "./skills.js";
import type { SuggestionDeps } from "./skills.js";

// A stand-in for the one thing a stand-in usually leaves out: Claude Code looks for its sign-in under the HOME it is
// started with, and refuses a settings file that is not there. It records what it was started with.
const STAND_IN = `#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const args = process.argv.slice(2);
fs.writeFileSync(process.env.STAND_IN_LOG, JSON.stringify({ args, home: process.env.HOME }));
if (!fs.existsSync(path.join(process.env.HOME, ".claude", ".credentials.json"))) {
  process.stderr.write("Not logged in. Please run /login\\n");
  process.exit(1);
}
const at = args.indexOf("--settings");
if (at >= 0 && !fs.existsSync(args[at + 1])) {
  process.stderr.write("settings file not found\\n");
  process.exit(1);
}
process.stdin.resume();
process.stdin.on("end", () => {
  console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, num_turns: 1, result: "NO LESSON", total_cost_usd: 0.01, usage: { input_tokens: 10, output_tokens: 2 } }));
});
`;

describe("a question asked of the agent as the person's own", () => {
  const dirs: string[] = [];
  afterEach(() => {
    vi.restoreAllMocks();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function setup(signedIn: boolean) {
    const root = mkdtempSync(join(tmpdir(), "orchestrator-ask-"));
    dirs.push(root);
    const program = join(root, "claude");
    writeFileSync(program, STAND_IN);
    chmodSync(program, 0o755);
    const home = join(root, "person");
    mkdirSync(join(home, ".claude"), { recursive: true });
    if (signedIn) writeFileSync(join(home, ".claude", ".credentials.json"), "{}");
    const log = join(root, "started.json");
    const deps = (personal: boolean): SuggestionDeps => ({ agent: claudeCodeAdapter(program), isolation: { mode: "process", network: "open" }, hostEnv: { HOME: home, PATH: process.env.PATH, STAND_IN_LOG: log }, passEnv: ["STAND_IN_LOG"], timeoutMs: 20_000, dataDir: join(root, "data"), tenant: "t", model: null, personal });
    return { deps, log, home };
  }

  it("given a person signed in to Claude Code and tasks that run as them, when a question is asked, then the agent starts under their own home, answers, and is held to no shell, no web and no file tool", async () => {
    // given
    const { deps, log, home } = setup(true);

    // when
    const answer = await askAgent("Read a task's review for a lesson", "Is there a lesson?", deps(true), "ask-1");

    // then
    const started = JSON.parse(readFileSync(log, "utf8")) as { args: string[]; home: string };
    const denied = started.args[started.args.indexOf("--disallowedTools") + 1]!.split(",");
    expect(answer.summary).toBe("NO LESSON");
    expect(answer.cost.usd).toBe(0.01);
    expect(started.home).toBe(home);
    expect(started.args).toContain("--restricted");
    expect(denied).toEqual(expect.arrayContaining(["Bash", "WebFetch", "WebSearch", "Read", "Edit", "Write", "Glob", "Grep"]));
  });

  it("given a question started under a home of its own, when the agent finds no sign-in there, then it gives no answer and what it said on stderr is recorded", async () => {
    // given
    const { deps } = setup(true);
    const recorded = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    // when
    const answer = await askAgent("Read a task's review for a lesson", "Is there a lesson?", deps(false), "ask-2");

    // then
    expect(answer.summary).toBeNull();
    expect(recorded).toHaveBeenCalledWith(expect.stringContaining("Not logged in"));
  });
});
