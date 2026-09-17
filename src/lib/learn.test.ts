import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  currentSessionId,
  finalizeExplicitLearnInvocation,
  parseLearnPayload,
  peekExplicitLearnInvocation,
  signalFromLearnPayload,
} from "./learn.js";
import { commandFamily, fingerprint, normalizeErrorText } from "./normalize.js";
import { loadSessionState, saveSessionState } from "./session-state.js";

describe("parseLearnPayload", () => {
  it("accepts a minimal payload and fills defaults", () => {
    const { payload, error } = parseLearnPayload(
      '{"command": "npm test", "error": "1 test failed"}',
      "/repo",
    );
    expect(error).toBeUndefined();
    expect(payload).toEqual({
      kind: "error-fix",
      command: "npm test",
      error: "1 test failed",
      edits: [],
      cwd: "/repo",
      sessionId: "manual",
    });
  });

  it("resolves relative edit paths against the payload cwd", () => {
    const { payload } = parseLearnPayload(
      '{"command": "npm test", "error": "boom", "cwd": "/repo", "edits": ["src/app.ts", "/abs/other.ts"]}',
      "/elsewhere",
    );
    expect(payload?.edits).toEqual(["/repo/src/app.ts", "/abs/other.ts"]);
  });

  it("keeps resolvedCommand and sessionId when provided", () => {
    const { payload } = parseLearnPayload(
      '{"command": "npm test", "error": "boom", "resolvedCommand": "npm test -- -u", "sessionId": "s9"}',
      "/repo",
    );
    expect(payload).toMatchObject({ resolvedCommand: "npm test -- -u", sessionId: "s9" });
  });

  it.each([
    ["not json", "not valid JSON"],
    ["[1,2]", "must be a JSON object"],
    ['{"error": "boom"}', '"command"'],
    ['{"command": "  ", "error": "boom"}', '"command"'],
    ['{"command": "npm test"}', '"error"'],
    ['{"command": "npm test", "error": "boom", "edits": "src/app.ts"}', '"edits"'],
    ['{"command": "npm test", "error": "boom", "resolvedCommand": 5}', '"resolvedCommand"'],
  ])("rejects %s", (raw, fragment) => {
    const { payload, error } = parseLearnPayload(raw, "/repo");
    expect(payload).toBeUndefined();
    expect(error).toContain(fragment);
  });
});

describe("signalFromLearnPayload", () => {
  it("builds a manual candidate with normalized error and matching fingerprint", () => {
    const signal = signalFromLearnPayload(
      {
        kind: "error-fix",
        command: "npm test",
        error: "\x1b[31m1 test failed\x1b[0m at /Users/me/repo/app.ts:12",
        resolvedCommand: "npm test -- -u",
        edits: ["/repo/src/app.ts"],
        cwd: "/repo",
        sessionId: "s1",
      },
      "2026-08-08T00:00:00Z",
    );
    const normalized = normalizeErrorText("\x1b[31m1 test failed\x1b[0m at /Users/me/repo/app.ts:12");
    expect(signal).toEqual({
      ts: "2026-08-08T00:00:00Z",
      sessionId: "s1",
      kind: "candidate",
      fingerprint: fingerprint(commandFamily("npm test"), normalized),
      family: "npm test",
      command: "npm test",
      error: normalized,
      cwd: "/repo",
      count: 1,
      edits: ["/repo/src/app.ts"],
      resolvedCommand: "npm test -- -u",
      resolvedAt: "2026-08-08T00:00:00Z",
      trigger: "manual",
    });
  });

  it("omits resolution fields when no resolving command was given", () => {
    const signal = signalFromLearnPayload(
      { kind: "error-fix", command: "npm test", error: "boom", edits: [], cwd: "/repo", sessionId: "manual" },
      "2026-08-08T00:00:00Z",
    );
    expect(signal.resolvedCommand).toBeUndefined();
    expect(signal.resolvedAt).toBeUndefined();
  });

  it("carries an explicit trigger through to the signal", () => {
    const signal = signalFromLearnPayload(
      { kind: "error-fix", command: "npm test", error: "boom", edits: [], cwd: "/repo", sessionId: "s1" },
      "2026-08-08T00:00:00Z",
      "manual-model",
    );
    expect(signal.trigger).toBe("manual-model");
  });
});

describe("currentSessionId", () => {
  it("reads CLAUDE_CODE_SESSION_ID from the given environment", () => {
    expect(currentSessionId({ CLAUDE_CODE_SESSION_ID: " s1 " })).toBe("s1");
  });

  it("is undefined when unset or blank", () => {
    expect(currentSessionId({})).toBeUndefined();
    expect(currentSessionId({ CLAUDE_CODE_SESSION_ID: "  " })).toBeUndefined();
  });
});

// This is the case the K-17 card exists to prove: the same CLI invocation, told
// apart only by whether the session has an open, unconsumed explicit ask.
describe("peekExplicitLearnInvocation / finalizeExplicitLearnInvocation (telling the user's own /handbook:learn from the model's)", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "handbook-test-"));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("is true when the session has a pending explicit ask", () => {
    const state = loadSessionState("s1", home);
    state.explicitLearnPending = true;
    saveSessionState(state, home);
    expect(peekExplicitLearnInvocation("s1", home)).toBe(true);
  });

  it("is false when the session's ask was already recorded as not pending", () => {
    const state = loadSessionState("s1", home);
    state.explicitLearnPending = false;
    saveSessionState(state, home);
    expect(peekExplicitLearnInvocation("s1", home)).toBe(false);
  });

  it("defaults to true (preserves today's behavior) with no session id", () => {
    expect(peekExplicitLearnInvocation(undefined, home)).toBe(true);
  });

  it("defaults to true (preserves today's behavior) when nothing was ever recorded", () => {
    expect(peekExplicitLearnInvocation("never-seen-session", home)).toBe(true);
  });

  it("does not mutate anything (repeated peeks see the same pending ask)", () => {
    const state = loadSessionState("s1", home);
    state.explicitLearnPending = true;
    saveSessionState(state, home);

    expect(peekExplicitLearnInvocation("s1", home)).toBe(true);
    expect(peekExplicitLearnInvocation("s1", home)).toBe(true);
    expect(loadSessionState("s1", home).explicitLearnPending).toBe(true);
  });

  // K-17 BLOKE 1 (the "stale true" half): a pending ask must not outlive the CLI
  // run that decides on it, or a later, unrelated model-initiated capture in the
  // same session would wrongly inherit the user's earlier explicit ask.
  it("finalize clears the pending flag, so a later peek in the same session sees it consumed", () => {
    const state = loadSessionState("s1", home);
    state.explicitLearnPending = true;
    saveSessionState(state, home);

    finalizeExplicitLearnInvocation("s1", home);
    expect(peekExplicitLearnInvocation("s1", home)).toBe(false);
  });

  it("finalize on an already-false ask is a harmless no-op", () => {
    const state = loadSessionState("s1", home);
    state.explicitLearnPending = false;
    saveSessionState(state, home);

    finalizeExplicitLearnInvocation("s1", home);
    expect(peekExplicitLearnInvocation("s1", home)).toBe(false);
  });

  it("finalize with no session id does nothing (does not throw)", () => {
    expect(() => finalizeExplicitLearnInvocation(undefined, home)).not.toThrow();
  });
});
