import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  attachEditToOpenErrors,
  cleanupStaleSessionFiles,
  emptySessionState,
  loadSessionState,
  recordFailure,
  resolveOpenErrors,
  saveSessionState,
} from "./session-state.js";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "handbook-test-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

const failure = {
  fingerprint: "abc123",
  family: "npm test",
  command: "npm test",
  error: "1 test failed",
  cwd: "/repo",
};

describe("session state", () => {
  it("returns empty state when no file exists", () => {
    const state = loadSessionState("s1", home);
    expect(state).toEqual({ sessionId: "s1", openErrors: [], resolvedPairs: [] });
  });

  it("round-trips state through save and load", () => {
    const state = recordFailure(emptySessionState("s1"), failure, "2026-08-08T00:00:00Z");
    saveSessionState(state, home);
    const loaded = loadSessionState("s1", home);
    expect(loaded.openErrors).toHaveLength(1);
    expect(loaded.openErrors[0]).toMatchObject({ fingerprint: "abc123", count: 1, edits: [] });
  });

  it("increments count for a repeated fingerprint", () => {
    let state = recordFailure(emptySessionState("s1"), failure, "2026-08-08T00:00:00Z");
    state = recordFailure(state, failure, "2026-08-08T00:05:00Z");
    expect(state.openErrors).toHaveLength(1);
    expect(state.openErrors[0]?.count).toBe(2);
    expect(state.openErrors[0]?.firstSeenAt).toBe("2026-08-08T00:00:00Z");
    expect(state.openErrors[0]?.lastSeenAt).toBe("2026-08-08T00:05:00Z");
  });

  it("keeps distinct fingerprints as separate open errors", () => {
    let state = recordFailure(emptySessionState("s1"), failure);
    state = recordFailure(state, { ...failure, fingerprint: "def456" });
    expect(state.openErrors).toHaveLength(2);
  });

  it("recovers from a corrupt state file", () => {
    mkdirSync(join(home, "sessions"), { recursive: true });
    writeFileSync(join(home, "sessions", "s1.json"), "{corrupt");
    expect(loadSessionState("s1", home)).toEqual({ sessionId: "s1", openErrors: [], resolvedPairs: [] });
  });

  it("normalizes legacy state files without edits or resolvedPairs", () => {
    mkdirSync(join(home, "sessions"), { recursive: true });
    const legacy = { sessionId: "s1", openErrors: [{ ...failure, count: 1, firstSeenAt: "x", lastSeenAt: "x" }] };
    writeFileSync(join(home, "sessions", "s1.json"), JSON.stringify(legacy));
    const loaded = loadSessionState("s1", home);
    expect(loaded.openErrors[0]?.edits).toEqual([]);
    expect(loaded.resolvedPairs).toEqual([]);
  });

  it("sanitizes session ids used as file names", () => {
    saveSessionState(emptySessionState("../../evil"), home);
    const loaded = loadSessionState("../../evil", home);
    expect(loaded.openErrors).toEqual([]);
  });
});

describe("attachEditToOpenErrors", () => {
  it("attaches the file to every open error once", () => {
    let state = recordFailure(emptySessionState("s1"), failure);
    state = recordFailure(state, { ...failure, fingerprint: "def456" });
    expect(attachEditToOpenErrors(state, "/repo/src/app.ts")).toBe(true);
    expect(attachEditToOpenErrors(state, "/repo/src/app.ts")).toBe(false);
    expect(state.openErrors.map((e) => e.edits)).toEqual([["/repo/src/app.ts"], ["/repo/src/app.ts"]]);
  });

  it("does nothing without open errors", () => {
    expect(attachEditToOpenErrors(emptySessionState("s1"), "/repo/src/app.ts")).toBe(false);
  });
});

describe("cleanupStaleSessionFiles", () => {
  it("removes only sessions older than the retention window", () => {
    saveSessionState(emptySessionState("old"), home);
    saveSessionState(emptySessionState("fresh"), home);
    const eightDaysFromNow = Date.now() + 8 * 24 * 60 * 60 * 1000;
    expect(cleanupStaleSessionFiles(home, eightDaysFromNow)).toBe(2);
    expect(cleanupStaleSessionFiles(home)).toBe(0);
    saveSessionState(emptySessionState("s2"), home);
    expect(cleanupStaleSessionFiles(home)).toBe(0);
    expect(loadSessionState("s2", home)).toEqual(emptySessionState("s2"));
  });
});

describe("resolveOpenErrors", () => {
  it("moves matching-family errors to resolved pairs", () => {
    let state = recordFailure(emptySessionState("s1"), failure);
    state = recordFailure(state, { ...failure, fingerprint: "def456", family: "cargo build" });
    attachEditToOpenErrors(state, "/repo/src/app.ts");
    const resolved = resolveOpenErrors(state, "npm test", "npm test", "/repo", "2026-08-08T01:00:00Z");
    expect(resolved).toHaveLength(1);
    expect(resolved[0]).toMatchObject({
      fingerprint: "abc123",
      resolvedCommand: "npm test",
      resolvedAt: "2026-08-08T01:00:00Z",
      edits: ["/repo/src/app.ts"],
    });
    expect(state.openErrors).toHaveLength(1);
    expect(state.openErrors[0]?.family).toBe("cargo build");
    expect(state.resolvedPairs).toHaveLength(1);
  });

  it("returns empty when no family matches", () => {
    const state = recordFailure(emptySessionState("s1"), failure);
    expect(resolveOpenErrors(state, "cargo build", "cargo build")).toEqual([]);
    expect(state.openErrors).toHaveLength(1);
    expect(state.resolvedPairs).toEqual([]);
  });
});

describe("resolveOpenErrors — single most-recent (misattribution guard)", () => {
  it("resolves only the most-recently-seen matching error, leaving the rest open", () => {
    let state = recordFailure(emptySessionState("s1"), { ...failure, fingerprint: "old" }, "2026-08-08T00:00:00Z");
    state = recordFailure(state, { ...failure, fingerprint: "new" }, "2026-08-08T00:05:00Z");
    const resolved = resolveOpenErrors(state, "npm test", "npm test", "/repo", "2026-08-08T00:10:00Z");
    expect(resolved).toHaveLength(1);
    expect(resolved[0]?.fingerprint).toBe("new");
    expect(state.openErrors.map((e) => e.fingerprint)).toEqual(["old"]);
  });
});

describe("attachEditToOpenErrors — most-recent-N ring buffer", () => {
  it("keeps the latest edits so a late real fix is not locked out", () => {
    let state = recordFailure(emptySessionState("s1"), failure);
    for (let i = 0; i < 25; i++) attachEditToOpenErrors(state, `/repo/flail-${i}.ts`);
    attachEditToOpenErrors(state, "/repo/the-real-fix.ts");
    const edits = state.openErrors[0]!.edits;
    expect(edits).toContain("/repo/the-real-fix.ts");
    expect(edits.length).toBeLessThanOrEqual(20);
    expect(edits).not.toContain("/repo/flail-0.ts");
  });
});
