import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { claudeCodeAdapter, opencodeAdapter } from "./agents.js";
import type { AgentSetup } from "./agents.js";
import { makeTaskDirs, runProcess, taskEnv, taskPaths } from "./isolation.js";
import { keptLine, writeTranscript } from "./transcript.js";
import type { Transcript } from "./transcript.js";

// Records a transcript from the real agent CLI, by hand and never in CI: it runs the CLI named by
// ORCHESTRATOR_CLAUDE_BIN or ORCHESTRATOR_OPENCODE_BIN with the developer's own model credential, on a
// stand-in checkout, and pays for one short task. Opt-in:
//   ORCHESTRATOR_RECORD_AGENT=claude-code npx vitest run server/tasks/transcript.record.test.ts
const AGENT = process.env.ORCHESTRATOR_RECORD_AGENT as Transcript["agent"] | undefined;
const SETUP: AgentSetup = { skills: [], mcpServers: {}, mcpTools: [] };
const SKILL = "---\nname: release-checklist\ndescription: Use before tagging a release.\n---\n\n- Feature flags default off\n- Dashboards updated\n";

describe.skipIf(!AGENT)("recording a transcript from the real agent CLI", () => {
  it("given the agent CLI on this machine, when it runs one short task on a stand-in checkout, then its run is written as a transcript with nothing of this machine in it", async () => {
    // given
    const program = AGENT === "opencode" ? process.env.ORCHESTRATOR_OPENCODE_BIN || "opencode" : process.env.ORCHESTRATOR_CLAUDE_BIN || "claude";
    const adapter = AGENT === "opencode" ? opencodeAdapter(program) : claudeCodeAdapter(program);
    const cliVersion = /\d+\.\d+\.\d+/.exec(execFileSync(program, ["--version"], { encoding: "utf8" }))?.[0] ?? "unknown";
    const root = mkdtempSync(join(tmpdir(), "orchestrator-record-"));
    const paths = taskPaths(root, "t", "0123456789ab");
    await makeTaskDirs(paths);
    await adapter.configure(paths, SETUP);
    mkdirSync(join(paths.work, "skills", "release-checklist"), { recursive: true });
    writeFileSync(join(paths.work, "skills", "release-checklist", "SKILL.md"), SKILL);
    const call = adapter.invocation(paths, { title: "Add an on-call step", prompt: "Task: Add an on-call step\n\nAdd a line telling the on-call engineer before a release to skills/release-checklist/SKILL.md." }, SETUP);
    const credentials = adapter.credentialEnv.map((name) => process.env[name]).filter((v): v is string => !!v);
    const env = { ...taskEnv({ PATH: process.env.PATH, ...Object.fromEntries(adapter.credentialEnv.map((n) => [n, process.env[n]])) }, paths, adapter.credentialEnv), ...call.env };

    // when
    const printed: string[] = [];
    const outcome = await runProcess({ ...call, env, cwd: paths.work }, { timeoutMs: 300_000, signal: new AbortController().signal, onLine: (stream, line) => void (stream === "stdout" && printed.push(line)) });

    // then
    const places = [...new Set([realpathSync(paths.work), paths.work, realpathSync(root), root])];
    const relative = (line: string) => places.reduce((text, place) => text.split(`${place}/`).join("").split(place).join("."), line);
    const transcript: Transcript = {
      agent: adapter.id as Transcript["agent"],
      cliVersion,
      source: "recorded",
      expect: { args: call.args.filter((a) => a.startsWith("-")), stdin: ["Task: "] },
      steps: printed.map((line) => ({ emit_inbound: keptLine(adapter.id as Transcript["agent"], relative(line)) })),
      exit: outcome.code ?? 1,
    };
    const traces = [homedir(), tmpdir(), realpathSync(tmpdir()), userInfo().username, root, ...credentials];
    writeTranscript(join(import.meta.dirname, "transcripts", `${adapter.id}-recorded-edit-skill.ndjson`), transcript, traces);
    rmSync(root, { recursive: true, force: true });
    expect(outcome.code).toBe(0);
  });
});
