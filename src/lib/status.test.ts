import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatStatus, gatherStatus, lastPipelineRun, ledgerStats } from "./status.js";
import { incrementRedactionBlocked } from "./gate.js";
import { pipelineLogFile } from "./pipeline.js";
import { writeCandidateMeta } from "./queue.js";
import type { CandidateMeta } from "./queue.js";
import { appendSignals } from "./signals.js";
import type { Signal } from "./signals.js";
import { candidatesDir } from "./skill-index.js";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "handbook-test-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function signal(overrides: Partial<Signal> = {}): Signal {
  return {
    ts: "2026-08-08T00:00:00Z",
    sessionId: "s1",
    kind: "candidate",
    fingerprint: "abc123",
    family: "npm test",
    command: "npm test",
    error: "1 test failed",
    cwd: "/repo",
    count: 1,
    edits: ["/repo/app.ts"],
    ...overrides,
  };
}

function seedCandidate(slug: string, status: CandidateMeta["status"]): void {
  const dir = join(candidatesDir(home), slug);
  mkdirSync(dir, { recursive: true });
  writeCandidateMeta(dir, {
    slug,
    status,
    createdAt: "2026-08-08T00:00:00Z",
    scope: "team",
    description: "A test candidate.",
    fingerprint: "abc123",
    sessionId: "s1",
    gate: null,
  });
}

describe("ledgerStats", () => {
  it("returns zeros for a missing ledger", () => {
    expect(ledgerStats(home)).toEqual({ total: 0, candidates: 0, weak: 0, distinctFingerprints: 0 });
  });

  it("counts kinds and distinct fingerprints, skipping malformed lines", () => {
    appendSignals(
      [signal(), signal({ kind: "weak", fingerprint: "def456" }), signal({ fingerprint: "def456" })],
      home,
    );
    appendFileSync(join(home, "signals.jsonl"), "not json\n");
    expect(ledgerStats(home)).toEqual({ total: 3, candidates: 2, weak: 1, distinctFingerprints: 2 });
  });
});

describe("lastPipelineRun", () => {
  it("returns null when the log does not exist", () => {
    expect(lastPipelineRun(home)).toBeNull();
  });

  it("returns the last well-formed line", () => {
    mkdirSync(home, { recursive: true });
    const first = { ts: "2026-08-07T00:00:00Z", received: 2, sievedOut: 1, scored: 1, rejected: 0, errored: 0, written: ["a"] };
    const last = { ts: "2026-08-08T00:00:00Z", received: 1, sievedOut: 0, scored: 1, rejected: 1, errored: 0, written: [] };
    writeFileSync(
      pipelineLogFile(home),
      [JSON.stringify(first), JSON.stringify(last), "broken"].join("\n") + "\n",
    );
    expect(lastPipelineRun(home)).toEqual(last);
  });
});

describe("gatherStatus / formatStatus", () => {
  it("assembles ledger, queue, counters, last run, and config defaults", () => {
    appendSignals([signal(), signal({ kind: "weak", fingerprint: "def456" })], home);
    seedCandidate("skill-a", "pending");
    seedCandidate("skill-b", "approved");
    seedCandidate("skill-c", "rejected");
    incrementRedactionBlocked(home);
    const report = gatherStatus(home);
    expect(report).toEqual({
      home,
      ledger: { total: 2, candidates: 1, weak: 1, distinctFingerprints: 2 },
      queue: { pending: 1, approved: 1, rejected: 1 },
      redactionBlocked: 1,
      lastRun: null,
      config: {
        gateModel: "haiku",
        gateThreshold: 7,
        distillModel: "(default)",
        sessionStartNotice: true,
      },
    });
  });

  it("formats a readable report that points at review when candidates are pending", () => {
    seedCandidate("skill-a", "pending");
    const text = formatStatus(gatherStatus(home));
    expect(text).toContain("1 pending, 0 approved, 0 rejected");
    expect(text).toContain("Last gate run:   never");
    expect(text).toContain('gate model "haiku" (threshold 7/10)');
    expect(text).toContain("/handbook:review");
  });

  it("marks a manual last run and omits the review hint when nothing is pending", () => {
    mkdirSync(home, { recursive: true });
    writeFileSync(
      pipelineLogFile(home),
      JSON.stringify({ ts: "2026-08-08T01:00:00Z", trigger: "manual", received: 1, sievedOut: 0, scored: 1, rejected: 0, errored: 0, written: ["x"] }) + "\n",
    );
    const text = formatStatus(gatherStatus(home));
    expect(text).toContain("2026-08-08T01:00:00Z (manual)");
    expect(text).not.toContain("/handbook:review");
  });
});
