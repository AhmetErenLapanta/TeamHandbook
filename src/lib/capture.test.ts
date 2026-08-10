import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  captureBashFailure,
  captureBashSuccess,
  captureCorrection,
  captureFileEdit,
  recordActivity,
} from "./capture.js";
import { loadSessionState } from "./session-state.js";
import { readCounters } from "./counters.js";
import type { HookInput } from "./hook-io.js";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "handbook-test-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

// Real Claude Code schema: a failed Bash command fires PostToolUseFailure with an
// `error` string and no tool_response.
function bashFailure(overrides: Partial<HookInput> = {}): HookInput {
  return {
    session_id: "s1",
    cwd: "/repo",
    hook_event_name: "PostToolUseFailure",
    tool_name: "Bash",
    tool_input: { command: "npm test" },
    error: "Exit code 1\ntest failed",
    is_interrupt: false,
    ...overrides,
  };
}

// A successful Bash command fires PostToolUse with a tool_response and no exit code.
function bashSuccess(overrides: Partial<HookInput> = {}): HookInput {
  return {
    session_id: "s1",
    cwd: "/repo",
    hook_event_name: "PostToolUse",
    tool_name: "Bash",
    tool_input: { command: "npm test" },
    tool_response: { stdout: "ok", stderr: "", interrupted: false, isImage: false },
    ...overrides,
  };
}

describe("captureBashFailure", () => {
  it("records an open error from a PostToolUseFailure event", () => {
    expect(captureBashFailure(bashFailure(), home)).toBe(true);
    const state = loadSessionState("s1", home);
    expect(state.openErrors).toHaveLength(1);
    expect(state.openErrors[0]).toMatchObject({ family: "npm test", command: "npm test", cwd: "/repo", count: 1 });
    expect(state.openErrors[0]?.error).toContain("test failed");
    expect(state.openErrors[0]?.fingerprint).toMatch(/^[0-9a-f]{16}$/);
  });

  it("ignores interrupts (Ctrl-C / timeout)", () => {
    expect(captureBashFailure(bashFailure({ is_interrupt: true }), home)).toBe(false);
    expect(captureBashFailure(bashFailure({ error: "Exit code 130\n" }), home)).toBe(false);
    expect(loadSessionState("s1", home).openErrors).toEqual([]);
  });

  it("ignores a successful command, a non-Bash tool, and a missing session id", () => {
    expect(captureBashFailure(bashSuccess(), home)).toBe(false);
    expect(captureBashFailure(bashFailure({ tool_name: "Edit" }), home)).toBe(false);
    expect(captureBashFailure(bashFailure({ session_id: undefined }), home)).toBe(false);
  });

  it("merges repeated identical failures into one open error", () => {
    captureBashFailure(bashFailure(), home);
    captureBashFailure(bashFailure(), home);
    const state = loadSessionState("s1", home);
    expect(state.openErrors).toHaveLength(1);
    expect(state.openErrors[0]?.count).toBe(2);
  });

  it("falls back to a non-zero exit code carried in a PostToolUse tool_response", () => {
    const legacy = bashFailure({
      hook_event_name: "PostToolUse",
      error: undefined,
      tool_response: { exit_code: 2, stderr: "boom" },
    });
    expect(captureBashFailure(legacy, home)).toBe(true);
    expect(loadSessionState("s1", home).openErrors[0]?.error).toContain("boom");
  });
});

function fileEdit(overrides: Partial<HookInput> = {}): HookInput {
  return {
    session_id: "s1",
    cwd: "/repo",
    hook_event_name: "PostToolUse",
    tool_name: "Edit",
    tool_input: { file_path: "/repo/src/app.ts", old_string: "a", new_string: "b" },
    tool_response: { success: true },
    ...overrides,
  };
}

describe("captureFileEdit", () => {
  it("attaches the edited file to open errors", () => {
    captureBashFailure(bashFailure(), home);
    expect(captureFileEdit(fileEdit(), home)).toBe(true);
    expect(loadSessionState("s1", home).openErrors[0]?.edits).toEqual(["/repo/src/app.ts"]);
  });

  it("supports Write and MultiEdit tools", () => {
    captureBashFailure(bashFailure(), home);
    expect(captureFileEdit(fileEdit({ tool_name: "Write" }), home)).toBe(true);
    expect(
      captureFileEdit(fileEdit({ tool_name: "MultiEdit", tool_input: { file_path: "/repo/b.ts" } }), home),
    ).toBe(true);
    expect(loadSessionState("s1", home).openErrors[0]?.edits).toEqual(["/repo/src/app.ts", "/repo/b.ts"]);
  });

  it("does nothing without an open error, a non-edit tool, or a file path", () => {
    expect(captureFileEdit(fileEdit(), home)).toBe(false);
    captureBashFailure(bashFailure(), home);
    expect(captureFileEdit(fileEdit({ tool_name: "Read" }), home)).toBe(false);
    expect(captureFileEdit(fileEdit({ tool_input: {} }), home)).toBe(false);
  });
});

describe("captureBashSuccess", () => {
  it("closes an open error of the same family into a resolved pair", () => {
    captureBashFailure(bashFailure(), home);
    captureFileEdit(fileEdit(), home);
    expect(captureBashSuccess(bashSuccess(), home)).toBe(1);
    const state = loadSessionState("s1", home);
    expect(state.openErrors).toEqual([]);
    expect(state.resolvedPairs).toHaveLength(1);
    expect(state.resolvedPairs[0]).toMatchObject({
      family: "npm test",
      resolvedCommand: "npm test",
      edits: ["/repo/src/app.ts"],
    });
  });

  it("matches by family, not exact command", () => {
    captureBashFailure(bashFailure({ tool_input: { command: "npm test -- --run capture" } }), home);
    expect(captureBashSuccess(bashSuccess({ tool_input: { command: "npm test" } }), home)).toBe(1);
    expect(loadSessionState("s1", home).resolvedPairs).toHaveLength(1);
  });

  it("leaves other families open", () => {
    captureBashFailure(bashFailure(), home);
    captureBashFailure(bashFailure({ tool_input: { command: "cargo build" }, error: "Exit code 101\nE0308" }), home);
    captureBashSuccess(bashSuccess(), home);
    const state = loadSessionState("s1", home);
    expect(state.openErrors).toHaveLength(1);
    expect(state.openErrors[0]?.family).toBe("cargo build");
  });

  it("does not resolve without a matching open error", () => {
    captureBashFailure(bashFailure(), home);
    expect(captureBashSuccess(bashSuccess({ tool_input: { command: "ls" } }), home)).toBe(0);
    expect(captureBashSuccess(bashSuccess(), home)).toBe(1);
  });

  it("does not treat a failure event or an interrupted run as a success", () => {
    captureBashFailure(bashFailure(), home);
    expect(captureBashSuccess(bashFailure(), home)).toBe(0);
    expect(captureBashSuccess(bashSuccess({ tool_response: { stdout: "", stderr: "", interrupted: true } }), home)).toBe(
      0,
    );
  });
});

describe("secret redaction at the session boundary", () => {
  const SECRET = "sk-proj-abcdef1234567890ABCDEFGH";

  function sessionHasNoSecret(): void {
    const file = join(home, "sessions", "s1.json");
    if (existsSync(file)) expect(readFileSync(file, "utf8")).not.toContain(SECRET);
  }

  it("drops a secret-bearing failing command entirely — nothing on disk, counter bumped", () => {
    const input = bashFailure({
      tool_input: { command: `curl -H 'Authorization: Bearer ${SECRET}' https://x` },
      error: "Exit code 1\n401 unauthorized",
    });
    expect(captureBashFailure(input, home)).toBe(false);
    expect(loadSessionState("s1", home).openErrors).toEqual([]); // no husk left behind
    expect(readCounters(home).redactionBlocked).toBe(1);
    sessionHasNoSecret();
  });

  it("captures a CLEAN recurrence of a secret-tainted error and pairs it (no silent loss)", () => {
    // occurrence 1 carries an inline secret in the command → dropped
    expect(
      captureBashFailure(
        bashFailure({ tool_input: { command: `API_KEY=${SECRET} npm test` }, error: "Exit code 1\n2 failing" }),
        home,
      ),
    ).toBe(false);
    // occurrence 2 is clean (same normalized error/family) → captured fresh
    expect(
      captureBashFailure(bashFailure({ tool_input: { command: "npm test" }, error: "Exit code 1\n2 failing" }), home),
    ).toBe(true);
    captureFileEdit(fileEdit(), home);
    // the green re-run must still close the pair — the tombstone regression returned 0 here
    expect(captureBashSuccess(bashSuccess(), home)).toBe(1);
    const pair = loadSessionState("s1", home).resolvedPairs[0]!;
    expect(pair.family).toBe("npm test");
    expect(pair.resolvedCommand).toBe("npm test");
    expect(JSON.stringify(pair)).not.toContain(SECRET);
    expect(readCounters(home).redactionBlocked).toBe(1); // only occurrence 1 was blocked
  });

  it("does not pair a fix whose resolving command carries a secret", () => {
    captureBashFailure(bashFailure({ tool_input: { command: "curl https://x" }, error: "Exit code 1\nboom" }), home);
    const resolved = captureBashSuccess(
      bashSuccess({ tool_input: { command: `curl -H 'Authorization: Bearer ${SECRET}' https://x` } }),
      home,
    );
    expect(resolved).toBe(0);
    expect(loadSessionState("s1", home).resolvedPairs).toEqual([]);
    sessionHasNoSecret();
    expect(readCounters(home).redactionBlocked).toBe(1);
  });

  it("drops a secret-bearing edit path instead of attaching it", () => {
    captureBashFailure(bashFailure(), home);
    const attached = captureFileEdit(fileEdit({ tool_input: { file_path: `/repo/tmp/token=${SECRET}.ts` } }), home);
    expect(attached).toBe(false);
    expect(loadSessionState("s1", home).openErrors[0]?.edits).toEqual([]);
    sessionHasNoSecret();
  });

  it("does not record activity for a secret-bearing command (recordActivity guard)", () => {
    expect(recordActivity(bashSuccess({ tool_input: { command: `deploy ${SECRET}` } }), home)).toBe(false);
    sessionHasNoSecret();
  });
});

describe("harvest evidence: transcriptPath + meaningfulToolCalls", () => {
  it("records the transcript path from any capture event", () => {
    captureBashFailure(bashFailure({ transcript_path: "/tmp/t.jsonl" }), home);
    expect(loadSessionState("s1", home).transcriptPath).toBe("/tmp/t.jsonl");
  });

  it("counts meaningful tool calls across repeats (not just novel activity)", () => {
    const build = bashSuccess({
      tool_input: { command: "cargo build" },
      transcript_path: "/tmp/t.jsonl",
    });
    recordActivity(build, home);
    recordActivity(build, home); // same family again — still a meaningful call
    recordActivity(bashSuccess({ tool_input: { command: "ls" } }), home); // generic → not counted
    const state = loadSessionState("s1", home);
    expect(state.meaningfulToolCalls).toBe(2);
    expect(state.transcriptPath).toBe("/tmp/t.jsonl");
    expect(state.activity?.families).toEqual(["cargo build"]);
  });
});

describe("captureCorrection (deterministic teaching pre-flagging)", () => {
  function promptInput(prompt: string): HookInput {
    return { session_id: "s1", cwd: "/repo", hook_event_name: "UserPromptSubmit", prompt, transcript_path: "/tmp/t.jsonl" };
  }

  it("records a teaching-shaped prompt into session state with its transcript path", () => {
    expect(captureCorrection(promptInput("we never use Lombok in this repo"), home)).toBe(true);
    const state = loadSessionState("s1", home);
    expect(state.corrections).toEqual([
      expect.objectContaining({ kind: "convention", text: "we never use Lombok in this repo" }),
    ]);
    expect(state.transcriptPath).toBe("/tmp/t.jsonl");
  });

  it("ignores ordinary prompts, missing prompts, and secret-bearing teachings", () => {
    expect(captureCorrection(promptInput("add a test for the parser"), home)).toBe(false);
    expect(captureCorrection({ session_id: "s1" }, home)).toBe(false);
    expect(
      captureCorrection(promptInput("always use Bearer sk-proj-abcdef1234567890ABCDEFGH"), home),
    ).toBe(false);
    expect(loadSessionState("s1", home).corrections).toBeUndefined();
  });
});
