import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  abandonedFile,
  drainHarvestJobs,
  enqueueHarvestJob,
  pendingDir,
  pipelineLogFile,
  runHarvestJob,
  runManualSignal,
  spawnPipelineRunner,
} from "./pipeline.js";
import { readCounters } from "./counters.js";
import { readCandidateMeta } from "./queue.js";
import type { ClaudeRunner } from "./score.js";
import { ledgerFingerprintCounts } from "./signals.js";
import type { Signal } from "./signals.js";
import type { HarvestJob } from "./harvest.js";
import { candidatesDir } from "./skill-index.js";

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
    return prompt.includes("kebab-case-skill-name") ? distillResponse : scoreResponse;
  };
}

const harvestReply = JSON.stringify([
  {
    kind: "correction",
    name: "prefer-config-feature-flags",
    description: "Use when adding a feature flag.",
    body: "## Rule\n\nFlags live in config.",
    expect: "New flags are read from config.",
    scope: "team",
    scores: { recurrence: 1, unfindability: 2, generality: 2, durability: 1, costOfError: 1 },
    quote: "we keep feature flags in config",
  },
]);

function job(home: string, overrides: Partial<HarvestJob> = {}): HarvestJob {
  const transcript = join(home, "t.jsonl");
  writeFileSync(
    transcript,
    JSON.stringify({ type: "user", isSidechain: false, message: { role: "user", content: "we keep flags in config" } }) + "\n",
  );
  return {
    sessionId: "s1",
    cwd: home,
    transcriptPath: transcript,
    evidence: { pairs: [], recurrence: {} },
    ...overrides,
  };
}

describe("harvest job hand-off", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "handbook-test-"));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("round-trips a job through the pending directory and consumes the file", () => {
    enqueueHarvestJob(job(home), home);
    enqueueHarvestJob(job(home, { sessionId: "s2" }), home);
    const drained = drainHarvestJobs(home);
    expect(drained.map((j) => j.sessionId).sort()).toEqual(["s1", "s2"]);
    expect(drainHarvestJobs(home)).toEqual([]);
    expect(readdirSync(pendingDir(home))).toEqual([]);
  });

  it("drops malformed job files but keeps draining the rest", () => {
    enqueueHarvestJob(job(home), home);
    writeFileSync(join(pendingDir(home), "zz-broken.json"), "not json");
    writeFileSync(join(pendingDir(home), "zz-wrong-shape.json"), JSON.stringify({ nope: true }));
    const drained = drainHarvestJobs(home);
    expect(drained).toHaveLength(1);
    expect(readdirSync(pendingDir(home))).toEqual([]);
  });

  it("reclaims a stale claimed job left by a crashed runner", () => {
    enqueueHarvestJob(job(home), home);
    const entry = readdirSync(pendingDir(home))[0]!;
    const claimed = join(pendingDir(home), `${entry}.claimed-99999`);
    renameSync(join(pendingDir(home), entry), claimed);
    const old = new Date(Date.now() - 11 * 60 * 1000);
    utimesSync(claimed, old, old);
    expect(drainHarvestJobs(home)).toHaveLength(1);
    expect(readdirSync(pendingDir(home))).toEqual([]);
  });

  it("leaves a fresh claim alone (its runner may still be alive)", () => {
    enqueueHarvestJob(job(home), home);
    const entry = readdirSync(pendingDir(home))[0]!;
    renameSync(join(pendingDir(home), entry), join(pendingDir(home), `${entry}.claimed-99999`));
    expect(drainHarvestJobs(home)).toEqual([]);
    expect(readdirSync(pendingDir(home))).toHaveLength(1);
  });

  it("drains an empty home without error", () => {
    expect(drainHarvestJobs(home)).toEqual([]);
  });
});

describe("runHarvestJob", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "handbook-test-"));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  const deps = { listSkills: () => [], skillDirs: () => [], remoteUrl: () => null };

  it("harvests a session into pending candidates and logs the run", async () => {
    const summary = await runHarvestJob(job(home), home, { ...deps, runner: async () => harvestReply });
    expect(summary.outcome).toBe("harvested");
    expect(summary.written).toEqual(["prefer-config-feature-flags"]);
    const meta = readCandidateMeta(join(candidatesDir(home), "prefer-config-feature-flags"));
    expect(meta).toMatchObject({ origin: "harvest", kind: "correction", status: "pending" });
    const line = JSON.parse(readFileSync(pipelineLogFile(home), "utf8").trim());
    expect(line).toMatchObject({ received: 1, written: ["prefer-config-feature-flags"] });
    expect(line.harvest.sessionId).toBe("s1");
  });

  it("re-enqueues a failed job up to the attempt cap, then abandons it — never silently", async () => {
    const down: ClaudeRunner = async () => {
      throw new Error("logged out");
    };
    await runHarvestJob(job(home), home, { ...deps, runner: down });
    const requeued = drainHarvestJobs(home);
    expect(requeued).toHaveLength(1);
    expect(requeued[0]!.attempts).toBe(1);
    expect(readCounters(home).gateErrors).toBe(1);

    await runHarvestJob({ ...job(home), attempts: 2 }, home, { ...deps, runner: down });
    expect(drainHarvestJobs(home)).toEqual([]); // gone from the queue
    expect(readCounters(home).gateAbandoned).toBe(1); // but counted
    expect(JSON.parse(readFileSync(abandonedFile(home), "utf8").trim()).sessionId).toBe("s1");
  });

  it("logs a skipped harvest when there is nothing to work from", async () => {
    const empty: HarvestJob = { sessionId: "s0", cwd: home, evidence: { pairs: [], recurrence: {} } };
    const summary = await runHarvestJob(empty, home, { ...deps, runner: async () => harvestReply });
    expect(summary.outcome).toBe("skipped");
    const line = JSON.parse(readFileSync(pipelineLogFile(home), "utf8").trim());
    expect(line.harvest.skipped).toContain("no transcript");
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

  it("still writes a gate-rejected manual candidate, carrying the gate's dissent", async () => {
    const duplicate = JSON.stringify({
      scores: { recurrence: 2, unfindability: 2, generality: 2, durability: 2, costOfError: 2 },
      rationale: "already covered",
      duplicateOf: "fix-npm-test",
    });
    const outcome = await runManualSignal(manual(), home, {
      runner: async (prompt) => (prompt.includes("kebab-case-skill-name") ? distillResponse : duplicate),
      remoteUrl: () => null,
    });
    // the user explicitly asked: the candidate is queued anyway, with the gate's
    // objection attached for the review to surface. A 10/10 duplicate is NOT
    // "below threshold" — the duplicate flag is its own, separate advice.
    expect(outcome).toMatchObject({
      stage: "written",
      slug: "fix-npm-test",
      gateTotal: 10,
      duplicateOf: "fix-npm-test",
    });
    expect((outcome as { belowThreshold?: boolean }).belowThreshold).toBeUndefined();
    const meta = readCandidateMeta(join(candidatesDir(home), "fix-npm-test"));
    expect(meta?.status).toBe("pending");
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
