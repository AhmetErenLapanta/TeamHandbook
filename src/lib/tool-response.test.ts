import { describe, it, expect } from "vitest";
import { bashFailure, extractExitCode, isBashSuccess } from "./tool-response.js";
import type { HookInput } from "./hook-io.js";

describe("bashFailure", () => {
  it("reads a PostToolUseFailure event's error and interrupt flag", () => {
    const f = bashFailure({ hook_event_name: "PostToolUseFailure", error: "Exit code 1\nboom" });
    expect(f).toEqual({ errorText: "Exit code 1\nboom", interrupted: false });
  });

  it("treats an interrupt flag or an interrupt exit code as interrupted", () => {
    expect(bashFailure({ hook_event_name: "PostToolUseFailure", error: "x", is_interrupt: true })?.interrupted).toBe(
      true,
    );
    expect(bashFailure({ hook_event_name: "PostToolUseFailure", error: "Exit code 130" })?.interrupted).toBe(true);
  });

  it("returns null for a successful PostToolUse", () => {
    expect(bashFailure({ hook_event_name: "PostToolUse", tool_response: { stdout: "ok", interrupted: false } })).toBeNull();
  });

  it("falls back to a non-zero exit code in a PostToolUse tool_response", () => {
    const f = bashFailure({ hook_event_name: "PostToolUse", tool_response: { exit_code: 2, stderr: "err" } });
    expect(f).toEqual({ errorText: "err", interrupted: false });
  });
});

describe("isBashSuccess", () => {
  it("is true for a PostToolUse with a clean tool_response", () => {
    expect(isBashSuccess({ hook_event_name: "PostToolUse", tool_response: { stdout: "ok", interrupted: false } })).toBe(
      true,
    );
  });

  it("is false for a failure event, an interrupted run, or a non-zero exit code", () => {
    expect(isBashSuccess({ hook_event_name: "PostToolUseFailure", error: "x" })).toBe(false);
    expect(isBashSuccess({ hook_event_name: "PostToolUse", tool_response: { interrupted: true } })).toBe(false);
    expect(isBashSuccess({ hook_event_name: "PostToolUse", tool_response: { exit_code: 1 } })).toBe(false);
  });
});

describe("extractExitCode", () => {
  it("reads numeric fields and an embedded message", () => {
    expect(extractExitCode({ code: 0 })).toBe(0);
    expect(extractExitCode({ exit_code: 2 })).toBe(2);
    expect(extractExitCode("failed: Exit code 3")).toBe(3);
    expect(extractExitCode([{ type: "text", text: "Exit code 4" }])).toBe(4);
  });

  it("returns undefined when there is no code", () => {
    expect(extractExitCode({ stdout: "ok" })).toBeUndefined();
    expect(extractExitCode("just text")).toBeUndefined();
  });

  it("never scrapes exit codes out of an object's output text", () => {
    // a successful `grep "exit code 1" logs/` must not become a failure
    expect(extractExitCode({ stdout: "previous run: exit code 1", stderr: "" })).toBeUndefined();
    expect(extractExitCode({ stderr: "warning mentions exit code 137" })).toBeUndefined();
  });
});

describe("misclassification guards", () => {
  it("keeps a success whose output merely quotes an exit code", () => {
    const r = { stdout: "reproducing: exit code 1 seen yesterday", stderr: "", interrupted: false };
    expect(isBashSuccess({ hook_event_name: "PostToolUse", tool_response: r })).toBe(true);
    expect(bashFailure({ hook_event_name: "PostToolUse", tool_response: r })).toBeNull();
  });

  it("does not call an evidence-free payload a success", () => {
    expect(isBashSuccess({ hook_event_name: "SomeFutureEvent", error: "Exit code 1\nboom" })).toBe(false);
    expect(isBashSuccess({ hook_event_name: "PostToolUse" })).toBe(false);
    expect(isBashSuccess({ hook_event_name: "PostToolUse", tool_response: {} })).toBe(false);
  });
});
