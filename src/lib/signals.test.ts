import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  attachEditToOpenErrors,
  emptySessionState,
  loadSessionState,
  recordFailure,
  resolveOpenErrors,
  saveSessionState,
} from "./session-state.js";
import {
  appendSignals,
  flushResolvedPairs,
  flushSessionEnd,
  ledgerFingerprintCounts,
  ledgerPairsForSession,
  signalsFile,
} from "./signals.js";
import { readCounters } from "./counters.js";
import type { Signal } from "./signals.js";

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

function seedResolvedPair(edits: string[] = []): void {
  const state = recordFailure(emptySessionState("s1"), failure, "2026-08-08T00:00:00Z");
  for (const edit of edits) attachEditToOpenErrors(state, edit, "2026-08-08T00:05:00Z");
  resolveOpenErrors(state, "npm test", "npm test", "/repo", "2026-08-08T00:10:00Z");
  saveSessionState(state, home);
}

function readSignals(): Signal[] {
  return readFileSync(signalsFile(home), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}

describe("flushResolvedPairs", () => {
  it("writes a candidate signal when an attached edit persists on disk", () => {
    const editedFile = join(home, "app.ts");
    writeFileSync(editedFile, "fixed");
    seedResolvedPair([editedFile]);
    const signals = flushResolvedPairs("s1", home, "2026-08-08T01:00:00Z");
    expect(signals).toHaveLength(1);
    expect(readSignals()[0]).toMatchObject({
      ts: "2026-08-08T01:00:00Z",
      sessionId: "s1",
      kind: "candidate",
      fingerprint: "abc123",
      family: "npm test",
      resolvedCommand: "npm test",
      resolvedAt: "2026-08-08T00:10:00Z",
      edits: [editedFile],
    });
  });

  it("downgrades to weak when the edited file no longer exists", () => {
    seedResolvedPair([join(home, "deleted.ts")]);
    flushResolvedPairs("s1", home, "2026-08-08T01:00:00Z");
    expect(readSignals()[0]).toMatchObject({ kind: "weak", edits: [] });
  });

  it("marks pairs without any edit as weak", () => {
    seedResolvedPair([]);
    flushResolvedPairs("s1", home, "2026-08-08T01:00:00Z");
    expect(readSignals()[0]?.kind).toBe("weak");
  });

  it("clears resolved pairs but keeps open errors for later turns", () => {
    seedResolvedPair([]);
    let state = loadSessionState("s1", home);
    state = recordFailure(state, { ...failure, fingerprint: "def456", family: "cargo build" });
    saveSessionState(state, home);
    flushResolvedPairs("s1", home);
    const after = loadSessionState("s1", home);
    expect(after.resolvedPairs).toEqual([]);
    expect(after.openErrors).toHaveLength(1);
  });

  it("does not append twice when flushed twice", () => {
    seedResolvedPair([]);
    flushResolvedPairs("s1", home);
    expect(flushResolvedPairs("s1", home)).toEqual([]);
    expect(readSignals()).toHaveLength(1);
  });

  it("writes nothing when there is no state", () => {
    expect(flushResolvedPairs("s1", home)).toEqual([]);
    expect(existsSync(signalsFile(home))).toBe(false);
  });
});

describe("flushSessionEnd", () => {
  it("writes remaining open errors as weak signals and deletes the session file", () => {
    const state = recordFailure(emptySessionState("s1"), failure, "2026-08-08T00:00:00Z");
    attachEditToOpenErrors(state, join(home, "attempt.ts"));
    saveSessionState(state, home);
    const signals = flushSessionEnd("s1", home, "2026-08-08T02:00:00Z");
    expect(signals).toHaveLength(1);
    expect(readSignals()[0]).toMatchObject({
      kind: "weak",
      fingerprint: "abc123",
      count: 1,
    });
    expect(readSignals()[0]?.resolvedCommand).toBeUndefined();
    expect(loadSessionState("s1", home)).toEqual(emptySessionState("s1"));
  });

  it("flushes unflushed resolved pairs alongside open errors", () => {
    const editedFile = join(home, "app.ts");
    writeFileSync(editedFile, "fixed");
    const state = recordFailure(emptySessionState("s1"), failure);
    attachEditToOpenErrors(state, editedFile);
    resolveOpenErrors(state, "npm test", "npm test");
    recordFailure(state, { ...failure, fingerprint: "def456", family: "cargo build" });
    saveSessionState(state, home);
    const signals = flushSessionEnd("s1", home);
    expect(signals.map((s) => s.kind)).toEqual(["candidate", "weak"]);
    expect(readSignals()).toHaveLength(2);
  });

  it("appends to signals from earlier flushes instead of overwriting", () => {
    seedResolvedPair([]);
    flushResolvedPairs("s1", home);
    const state = recordFailure(loadSessionState("s1", home), { ...failure, fingerprint: "def456" });
    saveSessionState(state, home);
    flushSessionEnd("s1", home);
    expect(readSignals()).toHaveLength(2);
  });
});

describe("secret redaction at persistence (Decision T)", () => {
  const secretSignal: Signal = {
    ts: "2026-08-08T00:00:00Z",
    sessionId: "s1",
    kind: "candidate",
    fingerprint: "fp-secret",
    family: "curl example.com",
    command: "curl -H 'Authorization: Bearer sk-proj-abcdef1234567890ABCDEF'",
    error: "401 unauthorized",
    cwd: "/repo",
    count: 1,
    edits: ["/repo/api.ts"],
  };

  it("writes a fingerprint-only tombstone, never the secret, and counts it", () => {
    appendSignals([secretSignal], home);
    const raw = readFileSync(signalsFile(home), "utf8");
    expect(raw).not.toContain("sk-proj");
    expect(raw).not.toContain("Bearer");
    const written = readSignals()[0]!;
    expect(written).toMatchObject({ fingerprint: "fp-secret", kind: "weak", secretRedacted: true });
    expect(written.command).toBe("");
    expect(written.error).toBe("");
    expect(readCounters(home).redactionBlocked).toBe(1);
    // fingerprint survives, so recurrence counting still works
    expect(ledgerFingerprintCounts(home).has("fp-secret")).toBe(true);
  });

  it("passes clean signals through untouched", () => {
    appendSignals([{ ...secretSignal, command: "npm test", error: "1 failed", fingerprint: "fp-clean" }], home);
    const written = readSignals()[0]!;
    expect(written.command).toBe("npm test");
    expect(written.secretRedacted).toBeUndefined();
    expect(readCounters(home).redactionBlocked).toBe(0);
  });
});

describe("ledgerFingerprintCounts", () => {
  it("returns an empty set when the ledger does not exist", () => {
    expect(ledgerFingerprintCounts(home).size).toBe(0);
  });

  it("collects fingerprints and skips malformed or fingerprint-less lines", () => {
    writeFileSync(
      signalsFile(home),
      ['{"fingerprint":"abc123"}', "not json", '{"kind":"weak"}', '{"fingerprint":"def456"}', ""].join("\n"),
    );
    expect([...ledgerFingerprintCounts(home).keys()].sort()).toEqual(["abc123", "def456"]);
  });

  it("reads back fingerprints written by appendSignals", () => {
    const signal: Signal = {
      ts: "2026-08-08T00:00:00Z",
      sessionId: "s1",
      kind: "weak",
      fingerprint: "abc123",
      family: "npm test",
      command: "npm test",
      error: "1 test failed",
      cwd: "/repo",
      count: 1,
      edits: [],
    };
    appendSignals([signal], home);
    appendSignals([{ ...signal, fingerprint: "def456" }], home);
    expect([...ledgerFingerprintCounts(home).keys()].sort()).toEqual(["abc123", "def456"]);
  });
});

describe("ledgerPairsForSession (harvest evidence)", () => {
  it("returns only this session's resolved pairs, skipping redacted and unresolved rows", () => {
    const editedFile = join(home, "app.ts");
    writeFileSync(editedFile, "fixed");
    seedResolvedPair([editedFile]);
    flushResolvedPairs("s1", home, "2026-08-08T01:00:00Z");
    // another session's pair + an unresolved weak row must not leak in
    const other = recordFailure(emptySessionState("s2"), { ...failure, fingerprint: "zzz" });
    saveSessionState(other, home);
    flushSessionEnd("s2", home);

    const pairs = ledgerPairsForSession("s1", home);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]).toMatchObject({
      fingerprint: "abc123",
      family: "npm test",
      resolvedCommand: "npm test",
      cwd: "/repo",
    });
    expect(ledgerPairsForSession("s2", home)).toEqual([]); // open error → no pair
    expect(ledgerPairsForSession("nope", home)).toEqual([]);
  });
});
