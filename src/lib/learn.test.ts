import { describe, it, expect } from "vitest";
import { parseLearnPayload, signalFromLearnPayload } from "./learn.js";
import { commandFamily, fingerprint, normalizeErrorText } from "./normalize.js";

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
});
