import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureBashFailure, captureBashSuccess, captureFileEdit } from "./capture.js";
import { loadSessionState } from "./session-state.js";
import type { HookInput } from "./hook-io.js";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "handbook-test-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function bashFailure(overrides: Partial<HookInput> = {}): HookInput {
  return {
    session_id: "s1",
    cwd: "/repo",
    hook_event_name: "PostToolUse",
    tool_name: "Bash",
    tool_input: { command: "npm test" },
    tool_response: { exit_code: 1, stderr: "1 test failed", stdout: "" },
    ...overrides,
  };
}

describe("captureBashFailure", () => {
  it("records an open error for a failed Bash command", () => {
    expect(captureBashFailure(bashFailure(), home)).toBe(true);
    const state = loadSessionState("s1", home);
    expect(state.openErrors).toHaveLength(1);
    expect(state.openErrors[0]).toMatchObject({
      family: "npm test",
      command: "npm test",
      error: "1 test failed",
      cwd: "/repo",
      count: 1,
    });
    expect(state.openErrors[0]?.fingerprint).toMatch(/^[0-9a-f]{16}$/);
  });

  it("supports camelCase exit codes", () => {
    const input = bashFailure({ tool_response: { exitCode: 2, stderr: "boom" } });
    expect(captureBashFailure(input, home)).toBe(true);
  });

  it("falls back to stdout when stderr is empty", () => {
    const input = bashFailure({
      tool_response: { exit_code: 1, stderr: "", stdout: "FAIL src/app.test.ts" },
    });
    captureBashFailure(input, home);
    expect(loadSessionState("s1", home).openErrors[0]?.error).toContain("FAIL");
  });

  it("ignores successful commands", () => {
    const input = bashFailure({ tool_response: { exit_code: 0, stderr: "", stdout: "ok" } });
    expect(captureBashFailure(input, home)).toBe(false);
    expect(loadSessionState("s1", home).openErrors).toEqual([]);
  });

  it("ignores non-Bash tools", () => {
    const input = bashFailure({ tool_name: "Edit" });
    expect(captureBashFailure(input, home)).toBe(false);
  });

  it("ignores responses without an exit code", () => {
    const input = bashFailure({ tool_response: { stderr: "??" } });
    expect(captureBashFailure(input, home)).toBe(false);
  });

  it("ignores payloads without a session id", () => {
    const input = bashFailure({ session_id: undefined });
    expect(captureBashFailure(input, home)).toBe(false);
  });

  it("merges repeated identical failures into one open error", () => {
    captureBashFailure(bashFailure(), home);
    captureBashFailure(bashFailure(), home);
    const state = loadSessionState("s1", home);
    expect(state.openErrors).toHaveLength(1);
    expect(state.openErrors[0]?.count).toBe(2);
  });
});

function fileEdit(overrides: Partial<HookInput> = {}): HookInput {
  return {
    session_id: "s1",
    cwd: "/repo",
    hook_event_name: "PostToolUse",
    tool_name: "Edit",
    tool_input: { file_path: "/repo/src/app.ts", old_string: "a", new_string: "b" },
    tool_response: {},
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
    expect(captureFileEdit(fileEdit({ tool_name: "MultiEdit", tool_input: { file_path: "/repo/b.ts" } }), home)).toBe(
      true,
    );
    expect(loadSessionState("s1", home).openErrors[0]?.edits).toEqual(["/repo/src/app.ts", "/repo/b.ts"]);
  });

  it("does nothing when there is no open error", () => {
    expect(captureFileEdit(fileEdit(), home)).toBe(false);
    expect(loadSessionState("s1", home).openErrors).toEqual([]);
  });

  it("ignores non-edit tools and missing file paths", () => {
    captureBashFailure(bashFailure(), home);
    expect(captureFileEdit(fileEdit({ tool_name: "Read" }), home)).toBe(false);
    expect(captureFileEdit(fileEdit({ tool_input: {} }), home)).toBe(false);
  });
});

function bashSuccess(overrides: Partial<HookInput> = {}): HookInput {
  return bashFailure({ tool_response: { exit_code: 0, stderr: "", stdout: "ok" }, ...overrides });
}

describe("captureBashSuccess", () => {
  it("closes open errors of the same command family into resolved pairs", () => {
    captureBashFailure(bashFailure(), home);
    captureFileEdit(fileEdit(), home);
    expect(captureBashSuccess(bashSuccess(), home)).toBe(true);
    const state = loadSessionState("s1", home);
    expect(state.openErrors).toEqual([]);
    expect(state.resolvedPairs).toHaveLength(1);
    expect(state.resolvedPairs[0]).toMatchObject({
      family: "npm test",
      resolvedCommand: "npm test",
      edits: ["/repo/src/app.ts"],
    });
  });

  it("matches by family, not by exact command", () => {
    captureBashFailure(bashFailure({ tool_input: { command: "npm test -- --run capture" } }), home);
    expect(captureBashSuccess(bashSuccess({ tool_input: { command: "npm test" } }), home)).toBe(true);
    expect(loadSessionState("s1", home).resolvedPairs).toHaveLength(1);
  });

  it("leaves other families open", () => {
    captureBashFailure(bashFailure(), home);
    captureBashFailure(bashFailure({ tool_input: { command: "cargo build" }, tool_response: { exit_code: 101, stderr: "E0308" } }), home);
    captureBashSuccess(bashSuccess(), home);
    const state = loadSessionState("s1", home);
    expect(state.openErrors).toHaveLength(1);
    expect(state.openErrors[0]?.family).toBe("cargo build");
  });

  it("ignores successes with no matching open error", () => {
    captureBashFailure(bashFailure(), home);
    expect(captureBashSuccess(bashSuccess({ tool_input: { command: "ls" } }), home)).toBe(false);
    expect(captureBashSuccess(bashSuccess(), home)).toBe(true);
  });

  it("ignores failures and missing exit codes", () => {
    captureBashFailure(bashFailure(), home);
    expect(captureBashSuccess(bashFailure(), home)).toBe(false);
    expect(captureBashSuccess(bashSuccess({ tool_response: { stdout: "ok" } }), home)).toBe(false);
  });
});
