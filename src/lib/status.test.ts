import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatStatus, gatherStatus, lastPipelineRun, ledgerStats, pluginVersion } from "./status.js";
import { incrementRedactionBlocked } from "./counters.js";
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
      version: pluginVersion(),
      ledger: { total: 2, candidates: 1, weak: 1, distinctFingerprints: 2 },
      queue: { pending: 1, approved: 1, rejected: 1 },
      redactionBlocked: 1,
      sinceInstall: { approved: 1, teamShared: 0, pairsCaptured: 0, secretsBlocked: 1 },
      detector: { postToolUse: 0, bashFailuresCaptured: 0, pairsResolved: 0 },
      lastRun: null,
      pipeline: { runs: 0, written: 0, rejected: 0, errored: 0, sievedOut: 0 },
      scoringNow: 0,
      abandoned: 0,
      config: {
        harvestModel: "haiku",
        harvestEnabled: true,
        harvestFloor: 4,
        harvestMax: 3,
        learnThreshold: 7,
        sessionStartNotice: true,
      },
    });
  });

  it("counts team-shared approvals from the persisted mode and renders the recap", () => {
    const solo = join(candidatesDir(home), "solo-skill");
    mkdirSync(solo, { recursive: true });
    writeCandidateMeta(solo, {
      slug: "solo-skill", status: "approved", createdAt: "2026-08-08T00:00:00Z", scope: "team",
      description: "d", fingerprint: "f1", sessionId: "s1", gate: null,
      deliveredTo: "/Users/me/proj/.claude/skills/solo-skill", deliveredMode: "solo",
    });
    const team = join(candidatesDir(home), "team-skill");
    mkdirSync(team, { recursive: true });
    writeCandidateMeta(team, {
      slug: "team-skill", status: "approved", createdAt: "2026-08-08T00:00:00Z", scope: "team",
      description: "d", fingerprint: "f2", sessionId: "s1", gate: null,
      deliveredTo: "/srv/git/team-skills.git (branch handbook/team-skill)", deliveredMode: "team",
    });
    const report = gatherStatus(home);
    expect(report.sinceInstall).toMatchObject({ approved: 2, teamShared: 1 });
    expect(formatStatus(report)).toContain("2 skills approved (1 shared with the team)");
  });

  it("formats a readable report that points at review when candidates are pending", () => {
    seedCandidate("skill-a", "pending");
    const text = formatStatus(gatherStatus(home));
    expect(text).toContain("1 pending, 0 approved, 0 rejected");
    expect(text).toContain("Last harvest:    never");
    expect(text).toContain('harvest model "haiku" (floor 4/10, max 3/session)');
    expect(text).toContain("/handbook:review");
  });

  it("shows getting-started guidance when nothing is approved or pending yet", () => {
    const text = formatStatus(gatherStatus(home));
    expect(text).toContain("No skills yet");
    expect(text).toContain("/handbook:learn");
    expect(text).not.toContain("/handbook:review to review");
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

  it("surfaces the last gate error's reason and points at doctor", () => {
    mkdirSync(home, { recursive: true });
    writeFileSync(
      pipelineLogFile(home),
      JSON.stringify({
        ts: "2026-08-08T01:00:00Z", received: 1, sievedOut: 0, scored: 1, rejected: 0, errored: 1, written: [],
        outcomes: [{ fingerprint: "abc", outcome: "error", error: "claude invocation failed (run /handbook:doctor)" }],
      }) + "\n",
    );
    const text = formatStatus(gatherStatus(home));
    expect(text).toContain("Last error:");
    expect(text).toContain("claude invocation failed");
    expect(text).toContain("/handbook:doctor");
  });

  it("reports abandoned pairs so the loss is never silent", () => {
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "counters.json"), JSON.stringify({ gateAbandoned: 2 }));
    const text = formatStatus(gatherStatus(home));
    expect(text).toContain("Abandoned:");
    expect(text).toContain("2 session harvest(s) given up");
  });
});
