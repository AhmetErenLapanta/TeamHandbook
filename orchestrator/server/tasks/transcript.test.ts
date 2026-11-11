import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { claudeCodeAdapter, fakeAgentAdapter, opencodeAdapter } from "./agents.js";
import type { AgentAdapter, AgentSetup } from "./agents.js";
import { makeTaskDirs, runProcess, taskEnv, taskPaths } from "./isolation.js";
import type { TaskPaths } from "./isolation.js";
import { keptLine, readTranscript, REPLAY_MISMATCH, replayProgram, TranscriptRefused, writeTranscript } from "./transcript.js";
import type { Transcript } from "./transcript.js";

const TRANSCRIPTS = join(import.meta.dirname, "transcripts");
const SETUP: AgentSetup = { skills: [], mcpServers: {}, mcpTools: [] };
const ADAPTERS: Record<Transcript["agent"], (program: string) => AgentAdapter> = {
  "claude-code": (program) => claudeCodeAdapter(program),
  opencode: (program) => opencodeAdapter(program),
  fake: (program) => fakeAgentAdapter(program),
};

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "orchestrator-transcript-"));
  dirs.push(dir);
  return dir;
}

async function replay(file: string, personal = false, onLine: (line: string, paths: TaskPaths) => void = () => {}) {
  const root = scratch();
  const transcript = readTranscript(file);
  const adapter = ADAPTERS[transcript.agent](replayProgram(root, file));
  const paths = taskPaths(root, "t", "0123456789ab");
  await makeTaskDirs(paths);
  await adapter.configure(paths, SETUP);
  const call = adapter.invocation(paths, { title: "Add an on-call note", prompt: "Task: Add an on-call note" }, SETUP, personal);
  const env = { ...taskEnv({ PATH: process.env.PATH }, paths, adapter.credentialEnv), ...call.env };
  const lines: string[] = [];
  const outcome = await runProcess({ ...call, env, cwd: paths.work }, {
    timeoutMs: 20_000,
    signal: new AbortController().signal,
    onLine: (stream, line) => {
      const text = stream === "stdout" ? adapter.logLine(line) : line;
      if (text) lines.push(text);
      onLine(line, paths);
    },
  });
  return { transcript, adapter, paths, outcome, lines, report: adapter.report(outcome.stdout, outcome.code) };
}

describe("the committed agent transcripts", () => {
  const files = readdirSync(TRANSCRIPTS).filter((f) => f.endsWith(".ndjson"));

  it("given the transcripts directory, when it is listed, then it holds one for each agent CLI the orchestrator runs", () => {
    expect(new Set(files.map((f) => readTranscript(join(TRANSCRIPTS, f)).agent))).toEqual(new Set(["claude-code", "opencode"]));
  });

  for (const file of files) {
    it(`given ${file}, when it is played back through its real adapter, then the adapter is the version it was recorded with and reads the run as it ended`, async () => {
      // when
      const { transcript, adapter, outcome, lines, report } = await replay(join(TRANSCRIPTS, file));

      // then
      expect(adapter.probe?.checkedVersion, "the adapter was checked against another CLI version; record the transcript again").toBe(transcript.cliVersion);
      expect(outcome.code).toBe(transcript.exit);
      expect(report.ok).toBe(transcript.exit === 0);
      expect(lines.length).toBeGreaterThan(0);
    });
  }

  it("given the Claude Code transcript, when it is played back, then the log, the summary, the cost and the refused call are what the run printed", async () => {
    // when
    const { lines, report } = await replay(join(TRANSCRIPTS, "claude-code-edit-skill.ndjson"));

    // then
    expect(lines).toEqual(["Reading the release checklist before changing it. · tool Read skills/release-checklist/SKILL.md", "tool Edit skills/release-checklist/SKILL.md", "agent finished: success, 3 turns"]);
    expect(report.summary).toBe("Added an on-call step to the release checklist.");
    expect(report.cost).toEqual({ usd: 0.0425, inputTokens: 200, outputTokens: 75 });
    expect(report.denied).toEqual([{ tool: "Bash", target: "npm test" }]);
  });

  it("given the OpenCode transcript, when it is played back, then the summary is its last text and the cost the sum of its steps", async () => {
    // when
    const { report } = await replay(join(TRANSCRIPTS, "opencode-edit-skill.ndjson"));

    // then
    expect(report.summary).toBe("Added an on-call step to the release checklist.");
    expect(report.cost).toEqual({ usd: 0.03, inputTokens: 150, outputTokens: 30 });
  });

  it("given the Claude Code transcript, when the agent is started with the person's own profile, which loads no task MCP config, then the replay refuses the start and the run is not ok", async () => {
    // when
    const { outcome, report } = await replay(join(TRANSCRIPTS, "claude-code-edit-skill.ndjson"), true);

    // then
    expect(outcome.code).toBe(REPLAY_MISMATCH);
    expect(report.ok).toBe(false);
  });
});

describe("the stand-in agent played from a transcript", () => {
  const standIn = (steps: Transcript["steps"]): string => {
    const file = join(scratch(), "stand-in.ndjson");
    writeTranscript(file, { agent: "fake", cliVersion: "none", source: "hand", expect: { args: ["--title"], stdin: ["Task: "] }, steps, exit: 0 }, []);
    return file;
  };

  it("given steps that write a skill and hold until a file exists, when the stand-in adapter runs them, then the agent runs until the test writes that file and leaves the skill in its checkout", async () => {
    // given
    const release = join(scratch(), "release");
    const file = standIn([
      { emit_inbound: { type: "log", text: "holding" } },
      { until: release },
      { write: { path: "skills/on-call-note/SKILL.md", content: "---\nname: on-call-note\ndescription: Use at a shift handover.\n---\n" } },
      { emit_inbound: { type: "result", summary: "Added the skill on-call-note.", denied: [{ tool: "Bash", target: "npm test" }] } },
    ]);

    // when
    let held = false;
    const { paths, lines, report } = await replay(file, false, (line, at) => {
      if (!line.includes("holding")) return;
      held = !existsSync(join(at.work, "skills"));
      writeFileSync(release, "");
    });

    // then
    expect(held).toBe(true);
    expect(lines).toEqual(["holding"]);
    expect(readFileSync(join(paths.work, "skills", "on-call-note", "SKILL.md"), "utf8")).toContain("name: on-call-note");
    expect(report).toMatchObject({ ok: true, summary: "Added the skill on-call-note.", denied: [{ tool: "Bash", target: "npm test" }] });
  });

  it("given steps that remove the agent's own checkout and report success, when the stand-in adapter runs them, then the checkout is gone and the report still reads ok", async () => {
    // given
    const file = standIn([{ remove: "." }, { emit_inbound: { type: "result", summary: "Deleted its own directory." } }]);

    // when
    const { paths, report } = await replay(file);

    // then
    expect(existsSync(paths.work)).toBe(false);
    expect(report.ok).toBe(true);
  });
});

describe("a two-way run played from a transcript", () => {
  const REQUEST = { type: "control_request", request_id: "r-1", request: { subtype: "can_use_tool", tool_name: "Edit" } };
  const ANSWER = { type: "control_response", response: { request_id: "r-1", subtype: "success", response: { behavior: "allow" } } };

  /** Starts the replay with stdin left open, answers each request line with `answer`, and returns what it printed and its exit code. */
  function converse(answer: ((line: string) => string | null) | null, timeoutMs = 10_000): Promise<{ code: number | null; stdout: string[] }> {
    const root = scratch();
    const file = join(root, "two-way.ndjson");
    writeTranscript(file, { agent: "claude-code", cliVersion: "2.1.309", source: "hand", expect: { args: [], stdin: ["Task: "] }, steps: [{ stdin: { type: "user", text: "Task: Add an on-call note" } }, { emit_inbound: REQUEST }, { stdin: ANSWER }, { emit_inbound: { type: "result", subtype: "success" } }], exit: 0 }, []);
    const child = spawn(replayProgram(root, file), [], { cwd: root, env: { PATH: process.env.PATH, ORCHESTRATOR_REPLAY_TIMEOUT_MS: String(timeoutMs) } });
    const stdout: string[] = [];
    let buffered = "";
    child.stdout.on("data", (chunk: Buffer) => {
      buffered += chunk.toString();
      for (let at = buffered.indexOf("\n"); at >= 0; at = buffered.indexOf("\n")) {
        const line = buffered.slice(0, at);
        buffered = buffered.slice(at + 1);
        stdout.push(line);
        const reply = answer?.(line);
        if (reply) child.stdin.write(reply + "\n");
      }
    });
    child.stdin.write(JSON.stringify({ text: "Task: Add an on-call note", type: "user" }) + "\n");
    return new Promise((done) => child.on("close", (code) => done({ code, stdout })));
  }

  it("given a transcript that asks for a tool's permission, when the client answers it as recorded, then the run goes on to its result and exits as recorded", async () => {
    // when
    const { code, stdout } = await converse((line) => (line.includes("control_request") ? JSON.stringify(ANSWER) : null));

    // then
    expect(code).toBe(0);
    expect(stdout.map((l) => JSON.parse(l).type)).toEqual(["control_request", "result"]);
  });

  it("given the same transcript, when the client denies the tool instead, then the replay refuses the line and prints no result", async () => {
    // when
    const deny = { type: "control_response", response: { request_id: "r-1", subtype: "success", response: { behavior: "deny" } } };
    const { code, stdout } = await converse((line) => (line.includes("control_request") ? JSON.stringify(deny) : null));

    // then
    expect(code).toBe(REPLAY_MISMATCH);
    expect(stdout.some((l) => l.includes('"result"'))).toBe(false);
  });

  it("given the same transcript, when the client never answers, then the replay fails once its wait runs out instead of hanging", async () => {
    // when
    const { code } = await converse(null, 300);

    // then
    expect(code).toBe(REPLAY_MISMATCH);
  });
});

describe("a transcript step aimed outside the checkout", () => {
  const steps = (path: string): Transcript["steps"] => [{ remove: path }, { emit_inbound: { type: "result", summary: "Done." } }];

  it("given steps that remove an absolute path or climb out with .., when the transcript is written, then it is refused and no file is left", () => {
    // given
    const dir = scratch();

    for (const [i, path] of [join(dir, "victim"), "../victim", "skills/../../victim"].entries()) {
      // when / then
      const file = join(dir, `${i}.ndjson`);
      expect(() => writeTranscript(file, { agent: "fake", cliVersion: "none", source: "hand", expect: { args: [], stdin: [] }, steps: steps(path), exit: 0 }, [])).toThrow(TranscriptRefused);
      expect(existsSync(file)).toBe(false);
    }
  });

  it("given a transcript file written by hand that removes a folder beside the checkout, when it is played, then the replay refuses the step and the folder is still there", async () => {
    // given
    const root = scratch();
    const checkout = join(root, "work");
    const victim = join(root, "victim");
    mkdirSync(checkout);
    mkdirSync(victim);
    const file = join(root, "hand.ndjson");
    writeFileSync(file, [{ meta: { agent: "fake", cliVersion: "none", source: "hand" } }, { expect_outbound: { args: [], stdin: [] } }, ...steps("../victim"), { exit: 0 }].map((l) => JSON.stringify(l)).join("\n") + "\n");

    // when
    const outcome = await runProcess({ program: replayProgram(root, file), args: [], env: { PATH: process.env.PATH ?? "" }, cwd: checkout, stdin: "" }, { timeoutMs: 20_000, signal: new AbortController().signal, onLine: () => {} });

    // then
    expect(outcome.code).toBe(REPLAY_MISMATCH);
    expect(existsSync(victim)).toBe(true);
    expect(() => readTranscript(file)).toThrow(TranscriptRefused);
  });
});

describe("what a transcript keeps of a printed line", () => {
  it("given Claude Code lines that carry a session, a model, a working directory and an edit's text, when they are kept, then only what the adapter reads is left", () => {
    // given
    const init = JSON.stringify({ type: "system", subtype: "init", session_id: "s-1", model: "a-model", cwd: "/somewhere/work", tools: ["Read"], mcp_servers: [{ name: "docs" }] });
    const edit = JSON.stringify({ type: "assistant", message: { id: "m-1", model: "a-model", content: [{ type: "tool_use", id: "t-1", name: "Edit", input: { file_path: "a.md", old_string: "before", new_string: "after" } }, { type: "thinking", thinking: "private" }] } });

    // when
    const kept = [keptLine("claude-code", init), keptLine("claude-code", edit), keptLine("claude-code", "not json")];

    // then
    expect(kept).toEqual([{ type: "system", subtype: "init" }, { type: "assistant", message: { content: [{ type: "tool_use", name: "Edit", input: { file_path: "a.md" } }] } }, "not json"]);
  });

  it("given OpenCode lines with a session and a message id, when they are kept, then only the text, tool, cost and tokens are left", () => {
    // given
    const step = JSON.stringify({ type: "step_finish", sessionID: "s-1", part: { id: "p-1", messageID: "m-1", cost: 0.01, tokens: { input: 10, output: 2, reasoning: 1, cache: { read: 0 } } } });

    // when
    const kept = keptLine("opencode", step);

    // then
    expect(kept).toEqual({ type: "step_finish", part: { cost: 0.01, tokens: { input: 10, output: 2 } } });
  });
});

describe("writing a transcript", () => {
  const base: Transcript = { agent: "claude-code", cliVersion: "2.1.309", source: "recorded", expect: { args: ["-p"], stdin: ["Task: "] }, steps: [{ emit_inbound: { type: "result", subtype: "success", result: "Done." } }], exit: 0 };

  it("given a clean transcript, when it is written and read back, then it is the same transcript", () => {
    // given
    const file = join(scratch(), "clean.ndjson");

    // when
    writeTranscript(file, base, [homedir()]);

    // then
    expect(readTranscript(file)).toEqual(base);
  });

  it("given transcripts naming the home directory, the run's credential or holding a token, when each is written, then each is refused and no file is left", () => {
    // given
    const dir = scratch();
    const cases: [Transcript, string[]][] = [
      [{ ...base, steps: [{ emit_inbound: { type: "result", result: `Edited ${join(homedir(), "notes.md")}` } }] }, [homedir()]],
      [{ ...base, steps: [{ emit_inbound: { type: "result", result: "used key-standin-0123456789" } }] }, ["key-standin-0123456789"]],
      [{ ...base, steps: [{ emit_inbound: { type: "result", result: `ghp_${"a1B2".repeat(9)}` } }] }, []],
    ];

    for (const [i, [transcript, traces]] of cases.entries()) {
      // when / then
      expect(() => writeTranscript(join(dir, `${i}.ndjson`), transcript, traces)).toThrow(TranscriptRefused);
      expect(existsSync(join(dir, `${i}.ndjson`))).toBe(false);
    }
  });
});
