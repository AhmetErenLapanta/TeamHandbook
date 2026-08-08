import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  drainPendingSignals,
  enqueuePendingSignals,
  pendingDir,
  pipelineLogFile,
  runManualSignal,
  runPipeline,
  spawnPipelineRunner,
} from "./pipeline.js";
import { readCounters } from "./counters.js";
import { readCandidateMeta } from "./queue.js";
import type { ClaudeRunner } from "./score.js";
import { appendSignals, ledgerFingerprintCounts } from "./signals.js";
import type { Signal } from "./signals.js";
import { candidatesDir } from "./skill-index.js";
import { writeFileSync } from "node:fs";

function candidate(overrides: Partial<Signal> = {}): Signal {
  return {
    ts: "2026-08-08T00:00:00Z",
    sessionId: "s1",
    kind: "candidate",
    fingerprint: "abc123",
    family: "npm test",
    command: "npm test",
    error: "1 test failed",
    cwd: "/repo",
    count: 2,
    edits: ["/repo/src/app.ts"],
    resolvedCommand: "npm test",
    resolvedAt: "2026-08-08T00:10:00Z",
    ...overrides,
  };
}

const scoreResponse = JSON.stringify({
  scores: { recurrence: 2, unfindability: 2, generality: 2, durability: 1, costOfError: 1 },
  rationale: "recurring and unfindable",
  duplicateOf: null,
});

const distillResponse = JSON.stringify({
  name: "fix-npm-test",
  description: "Use when npm test fails with a stale snapshot.",
  body: "## Symptom\n\nTest fails.\n\n## Fix\n\nUpdate the snapshot.",
  expect: "npm test exits 0 after the snapshot update.",
});

function fakeRunner(calls: string[] = []): ClaudeRunner {
  return async (prompt) => {
    calls.push(prompt);
    return prompt.includes("promotion gate") ? scoreResponse : distillResponse;
  };
}

function seedLedger(home: string, signal: Signal, times: number): void {
  appendSignals(Array.from({ length: times }, () => signal), home);
}

describe("pending hand-off", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "handbook-test-"));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("round-trips signals through the pending directory and consumes the files", () => {
    enqueuePendingSignals([candidate()], home);
    enqueuePendingSignals([candidate({ fingerprint: "def456" })], home);
    const drained = drainPendingSignals(home);
    expect(drained.map((s) => s.fingerprint).sort()).toEqual(["abc123", "def456"]);
    expect(drainPendingSignals(home)).toEqual([]);
    expect(readdirSync(pendingDir(home))).toEqual([]);
  });

  it("writes nothing for an empty batch", () => {
    expect(enqueuePendingSignals([], home)).toBeNull();
    expect(existsSync(pendingDir(home))).toBe(false);
  });

  it("drains an empty home without error", () => {
    expect(drainPendingSignals(home)).toEqual([]);
  });

  it("drops malformed batch files but keeps draining the rest", () => {
    enqueuePendingSignals([candidate()], home);
    writeFileSync(join(pendingDir(home), "zz-broken.json"), "not json");
    const drained = drainPendingSignals(home);
    expect(drained).toHaveLength(1);
    expect(readdirSync(pendingDir(home))).toEqual([]);
  });

  it("reclaims a stale claimed batch left by a crashed runner", () => {
    enqueuePendingSignals([candidate()], home);
    const entry = readdirSync(pendingDir(home))[0]!;
    const claimed = join(pendingDir(home), `${entry}.claimed-99999`);
    renameSync(join(pendingDir(home), entry), claimed);
    const old = new Date(Date.now() - 11 * 60 * 1000);
    utimesSync(claimed, old, old);
    const drained = drainPendingSignals(home);
    expect(drained).toHaveLength(1);
    expect(readdirSync(pendingDir(home))).toEqual([]);
  });

  it("leaves a fresh claim alone (its runner may still be alive)", () => {
    enqueuePendingSignals([candidate()], home);
    const entry = readdirSync(pendingDir(home))[0]!;
    renameSync(join(pendingDir(home), entry), join(pendingDir(home), `${entry}.claimed-99999`));
    expect(drainPendingSignals(home)).toEqual([]);
    expect(readdirSync(pendingDir(home))).toHaveLength(1);
  });
});

describe("runPipeline", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "handbook-test-"));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("carries a recurring candidate through sieve, score, distill, and into the queue", async () => {
    const signal = candidate();
    seedLedger(home, signal, 2);
    const summary = await runPipeline([signal], home, {
      runner: fakeRunner(),
      remoteUrl: () => null,
    });
    expect(summary).toEqual({
      received: 1,
      sievedOut: 0,
      scored: 1,
      rejected: 0,
      errored: 0,
      written: ["fix-npm-test"],
      outcomes: [
        { fingerprint: "abc123", outcome: "promote", total: 8, rationale: "recurring and unfindable" },
      ],
    });
    const dir = join(candidatesDir(home), "fix-npm-test");
    expect(readFileSync(join(dir, "SKILL.md"), "utf8")).toContain("name: fix-npm-test");
    expect(JSON.parse(readFileSync(join(dir, "grounded-case.json"), "utf8")).fingerprint).toBe("abc123");
    const meta = readCandidateMeta(dir);
    expect(meta?.status).toBe("pending");
    expect(meta?.gate?.total).toBe(8);
    expect(meta?.sessionId).toBe("s1");
  });

  it("appends a summary line to the pipeline log", async () => {
    const signal = candidate();
    seedLedger(home, signal, 2);
    await runPipeline([signal], home, { runner: fakeRunner(), remoteUrl: () => null });
    const lines = readFileSync(pipelineLogFile(home), "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ received: 1, written: ["fix-npm-test"] });
  });

  it("never calls the model for a signal the secret sieve dropped", async () => {
    const signal = candidate({ error: "auth failed: api_key=abcd1234efgh5678" });
    // Seed recurrence with a clean signal sharing the fingerprint, so only the
    // pipeline's own secret sieve increments the redaction counter.
    seedLedger(home, candidate(), 2);
    const calls: string[] = [];
    const summary = await runPipeline([signal], home, {
      runner: fakeRunner(calls),
      remoteUrl: () => null,
    });
    expect(summary.sievedOut).toBe(1);
    expect(summary.written).toEqual([]);
    expect(calls).toEqual([]);
    expect(readCounters(home).redactionBlocked).toBe(1);
  });

  it("counts a gate rejection and writes no candidate", async () => {
    const signal = candidate();
    seedLedger(home, signal, 2);
    const lowScore = JSON.stringify({
      scores: { recurrence: 1, unfindability: 0, generality: 0, durability: 0, costOfError: 0 },
      duplicateOf: null,
    });
    const summary = await runPipeline([signal], home, {
      runner: async () => lowScore,
      remoteUrl: () => null,
    });
    expect(summary.rejected).toBe(1);
    expect(summary.written).toEqual([]);
    expect(existsSync(candidatesDir(home))).toBe(false);
  });

  it("fails closed when the model call errors", async () => {
    const signal = candidate();
    seedLedger(home, signal, 2);
    const summary = await runPipeline([signal], home, {
      runner: async () => {
        throw new Error("claude unavailable");
      },
      remoteUrl: () => null,
    });
    expect(summary.errored).toBe(1);
    expect(summary.written).toEqual([]);
  });

  it("passes existing skills from the queue and the signal's project to the gate prompt", async () => {
    const signal = candidate();
    seedLedger(home, signal, 2);
    const seenDirs: string[][] = [];
    await runPipeline([signal], home, {
      runner: fakeRunner(),
      remoteUrl: () => null,
      listSkills: (dirs) => {
        seenDirs.push(dirs);
        return [];
      },
    });
    expect(seenDirs).toEqual([[candidatesDir(home), join("/repo", ".claude", "skills")]]);
  });
});

describe("runManualSignal", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "handbook-test-"));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  function manual(overrides: Partial<Signal> = {}): Signal {
    return candidate({ trigger: "manual", edits: [], ...overrides });
  }

  it("writes a first-occurrence manual signal without edits into the queue", async () => {
    const outcome = await runManualSignal(manual(), home, {
      runner: fakeRunner(),
      remoteUrl: () => null,
    });
    expect(outcome).toEqual({
      stage: "written",
      slug: "fix-npm-test",
      gateTotal: 8,
      scope: "team",
    });
    expect(readCandidateMeta(join(candidatesDir(home), "fix-npm-test"))?.status).toBe("pending");
  });

  it("appends the manual signal to the ledger and marks the log line as manual", async () => {
    await runManualSignal(manual(), home, { runner: fakeRunner(), remoteUrl: () => null });
    expect(ledgerFingerprintCounts(home).get("abc123")).toBe(1);
    const line = JSON.parse(readFileSync(pipelineLogFile(home), "utf8").trim());
    expect(line).toMatchObject({ trigger: "manual", received: 1, written: ["fix-npm-test"] });
  });

  it("vetoes a manual signal on secret without calling the model", async () => {
    const calls: string[] = [];
    const outcome = await runManualSignal(
      manual({ error: "auth failed: api_key=abcd1234efgh5678" }),
      home,
      { runner: fakeRunner(calls), remoteUrl: () => null },
    );
    expect(outcome).toMatchObject({ stage: "sieved", reason: "secret" });
    expect(calls).toEqual([]);
    expect(readCounters(home).redactionBlocked).toBe(1);
  });

  it("returns the gate verdict with duplicate and rationale details on rejection", async () => {
    const duplicate = JSON.stringify({
      scores: { recurrence: 2, unfindability: 2, generality: 2, durability: 2, costOfError: 2 },
      rationale: "already covered",
      duplicateOf: "fix-npm-test",
    });
    const outcome = await runManualSignal(manual(), home, {
      runner: async () => duplicate,
      remoteUrl: () => null,
    });
    expect(outcome).toEqual({
      stage: "gate-rejected",
      total: 10,
      threshold: 7,
      duplicateOf: "fix-npm-test",
      rationale: "already covered",
    });
  });

  it("fails closed when the model call errors", async () => {
    const outcome = await runManualSignal(manual(), home, {
      runner: async () => {
        throw new Error("claude unavailable");
      },
      remoteUrl: () => null,
    });
    expect(outcome).toMatchObject({ stage: "error" });
    expect(existsSync(candidatesDir(home))).toBe(false);
  });
});

describe("spawnPipelineRunner", () => {
  it("detaches and unrefs a node process running the given script", () => {
    const calls: unknown[] = [];
    let unrefd = false;
    const spawnFn = ((cmd: string, args: string[], opts: unknown) => {
      calls.push([cmd, args, opts]);
      return { unref: () => (unrefd = true) };
    }) as unknown as typeof import("node:child_process").spawn;
    spawnPipelineRunner("/plugin/dist/run-pipeline.js", spawnFn);
    expect(calls).toEqual([
      [process.execPath, ["/plugin/dist/run-pipeline.js"], { detached: true, stdio: "ignore" }],
    ]);
    expect(unrefd).toBe(true);
  });
});
