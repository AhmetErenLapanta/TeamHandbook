import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  abandonedFile,
  drainHarvestJobs,
  harvestedDir,
  releaseHarvestJob,
  enqueueHarvestJob,
  hasPendingHarvestJobs,
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
import { emptySessionState, loadSessionState, saveSessionState } from "./session-state.js";

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
    JSON.stringify({ type: "user", isSidechain: false, message: { role: "user", content: "we keep feature flags in config, not in env vars" } }) + "\n",
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
    expect(drained.map((c) => c.job.sessionId).sort()).toEqual(["s1", "s2"]);
    // the claim is held until the runner releases it, so a killed runner keeps the job
    expect(readdirSync(pendingDir(home)).every((f) => f.includes(".claimed-"))).toBe(true);
    for (const c of drained) releaseHarvestJob(c.claimedFile);
    expect(drainHarvestJobs(home)).toEqual([]);
    expect(readdirSync(pendingDir(home))).toEqual([]);
  });

  it("drops malformed job files but keeps draining the rest", () => {
    enqueueHarvestJob(job(home), home);
    writeFileSync(join(pendingDir(home), "zz-broken.json"), "not json");
    writeFileSync(join(pendingDir(home), "zz-wrong-shape.json"), JSON.stringify({ nope: true }));
    const drained = drainHarvestJobs(home);
    expect(drained).toHaveLength(1);
    for (const c of drained) releaseHarvestJob(c.claimedFile);
    expect(readdirSync(pendingDir(home))).toEqual([]);
  });

  it("reclaims a stale claimed job left by a crashed runner", () => {
    enqueueHarvestJob(job(home), home);
    const entry = readdirSync(pendingDir(home))[0]!;
    const claimed = join(pendingDir(home), `${entry}.claimed-99999`);
    renameSync(join(pendingDir(home), entry), claimed);
    const old = new Date(Date.now() - 11 * 60 * 1000);
    utimesSync(claimed, old, old);
    const reclaimed = drainHarvestJobs(home);
    expect(reclaimed).toHaveLength(1);
    for (const c of reclaimed) releaseHarvestJob(c.claimedFile);
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
    expect(requeued[0]!.job.attempts).toBe(1);
    for (const c of requeued) releaseHarvestJob(c.claimedFile);
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

describe("harvest once per transcript state", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "handbook-test-"));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  const deps = { listSkills: () => [], skillDirs: () => [], remoteUrl: () => null };

  function countingRunner(calls: { n: number }): ClaudeRunner {
    return async () => {
      calls.n += 1;
      return harvestReply;
    };
  }

  function logLines(h: string): Array<Record<string, unknown>> {
    return readFileSync(pipelineLogFile(h), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
  }

  it("given a completed run for a session, when the same job is claimed again, then no model call, no candidate, and a logged reason", async () => {
    const calls = { n: 0 };
    const j = job(home);
    await runHarvestJob(j, home, { ...deps, runner: countingRunner(calls) });
    expect(calls.n).toBe(1);

    const again = await runHarvestJob(j, home, { ...deps, runner: countingRunner(calls) });

    expect(calls.n).toBe(1);
    expect(again.outcome).toBe("skipped");
    expect(again.written).toEqual([]);
    const lines = logLines(home);
    expect(lines).toHaveLength(2);
    expect((lines[1]!.harvest as { skipped?: string }).skipped).toBe(
      "already harvested at this transcript length",
    );
    expect(readdirSync(candidatesDir(home))).toEqual(["prefer-config-feature-flags"]);
  });

  it("given a different sessionId, when its job is claimed, then it harvests normally", async () => {
    const calls = { n: 0 };
    await runHarvestJob(job(home), home, { ...deps, runner: countingRunner(calls) });

    const other = join(home, "other.jsonl");
    writeFileSync(
      other,
      JSON.stringify({
        type: "user",
        isSidechain: false,
        message: { role: "user", content: "we keep flags in config" },
      }) + "\n",
    );
    const summary = await runHarvestJob(
      { sessionId: "s2", cwd: home, transcriptPath: other, evidence: { pairs: [], recurrence: {} } },
      home,
      { ...deps, runner: countingRunner(calls) },
    );

    expect(calls.n).toBe(2);
    expect(summary.outcome).toBe("harvested");
  });

  it("given a reclaimed stale claim and no completed run for that session, when it is drained, then it harvests", async () => {
    const calls = { n: 0 };
    enqueueHarvestJob(job(home), home);
    const entry = readdirSync(pendingDir(home))[0]!;
    const claimed = join(pendingDir(home), `${entry}.claimed-99999`);
    renameSync(join(pendingDir(home), entry), claimed);
    const old = new Date(Date.now() - 11 * 60 * 1000);
    utimesSync(claimed, old, old);

    const reclaimed = drainHarvestJobs(home);
    expect(reclaimed).toHaveLength(1);
    const summary = await runHarvestJob(reclaimed[0]!.job, home, {
      ...deps,
      runner: countingRunner(calls),
    });

    expect(calls.n).toBe(1);
    expect(summary.outcome).toBe("harvested");
    expect(summary.written).toEqual(["prefer-config-feature-flags"]);
  });

  it("given a runner killed mid-harvest, when the queue hands its job back, then the harvest runs", async () => {
    const calls = { n: 0 };
    const j = job(home);
    enqueueHarvestJob(j, home);
    const entry = readdirSync(pendingDir(home))[0]!;
    // exactly what a SIGKILL leaves on disk: the claim the runner never released,
    // and a marker that never graduated from "claimed" to "done"
    const claimed = join(pendingDir(home), `${entry}.claimed-99999`);
    renameSync(join(pendingDir(home), entry), claimed);
    mkdirSync(harvestedDir(home), { recursive: true });
    const marker = join(harvestedDir(home), `s1-${statSync(j.transcriptPath!).size}`);
    writeFileSync(marker, "claimed");
    const old = new Date(Date.now() - 11 * 60 * 1000);
    utimesSync(claimed, old, old);
    utimesSync(marker, old, old);

    const reclaimed = drainHarvestJobs(home);
    const summary = await runHarvestJob(reclaimed[0]!.job, home, {
      ...deps,
      runner: countingRunner(calls),
    });

    expect(reclaimed).toHaveLength(1);
    expect(calls.n).toBe(1);
    expect(summary.outcome).toBe("harvested");
    expect(summary.written).toEqual(["prefer-config-feature-flags"]);
  });

  it("given an abandoned claim and no drain in between, when the job runs, then the guard steps aside", async () => {
    const calls = { n: 0 };
    const j = job(home);
    // the sweep only runs at drain time, so a marker that crosses the horizon while
    // a runner is already working through its drained jobs reaches the guard itself
    mkdirSync(harvestedDir(home), { recursive: true });
    const marker = join(harvestedDir(home), `s1-${statSync(j.transcriptPath!).size}`);
    writeFileSync(marker, "claimed");
    const old = new Date(Date.now() - 11 * 60 * 1000);
    utimesSync(marker, old, old);

    const summary = await runHarvestJob(j, home, { ...deps, runner: countingRunner(calls) });

    expect(calls.n).toBe(1);
    expect(summary.outcome).toBe("harvested");
    expect(readFileSync(marker, "utf8")).toBe("done");
  });

  it("given a run that errored, when the retry claims the same transcript, then the model is called again", async () => {
    const j = job(home);
    const down: ClaudeRunner = async () => {
      throw new Error("logged out");
    };
    await runHarvestJob(j, home, { ...deps, runner: down });
    expect(readdirSync(harvestedDir(home))).toEqual([]);

    const calls = { n: 0 };
    const retried = drainHarvestJobs(home);
    const summary = await runHarvestJob(retried[0]!.job, home, {
      ...deps,
      runner: countingRunner(calls),
    });

    expect(calls.n).toBe(1);
    expect(summary.written).toEqual(["prefer-config-feature-flags"]);
  });

  it("given a resumed session whose transcript grew, when it is claimed again, then it harvests the new tail", async () => {
    const calls = { n: 0 };
    const j = job(home);
    await runHarvestJob(j, home, { ...deps, runner: countingRunner(calls) });

    appendFileSync(
      j.transcriptPath!,
      JSON.stringify({
        type: "user",
        isSidechain: false,
        message: { role: "user", content: "and never commit without asking" },
      }) + "\n",
    );
    const summary = await runHarvestJob(j, home, { ...deps, runner: countingRunner(calls) });

    expect(calls.n).toBe(2);
    expect(summary.outcome).toBe("harvested");
  });

  it("given two runners in flight before either has logged, when both claim one transcript, then only one model call happens", async () => {
    let calls = 0;
    let enteredCall!: () => void;
    let releaseCall!: () => void;
    const inCall = new Promise<void>((resolve) => (enteredCall = resolve));
    const held = new Promise<void>((resolve) => (releaseCall = resolve));
    const runner: ClaudeRunner = async () => {
      calls += 1;
      enteredCall();
      await held;
      return harvestReply;
    };
    const j = job(home);

    const first = runHarvestJob(j, home, { ...deps, runner });
    await inCall;
    expect(existsSync(pipelineLogFile(home))).toBe(false);
    const second = await runHarvestJob(j, home, { ...deps, runner });

    expect(second.outcome).toBe("skipped");
    expect(calls).toBe(1);
    releaseCall();
    await first;
    expect(calls).toBe(1);
  });

  it("given a stamped and an unstamped session, when the marker guard runs, then the harvestedAt session-end branches on is unchanged for both", async () => {
    const stamped = emptySessionState("s1");
    stamped.harvestedAt = "2026-09-09T12:00:00Z";
    saveSessionState(stamped, home);
    saveSessionState(emptySessionState("s2"), home);

    await runHarvestJob(job(home), home, { ...deps, runner: async () => harvestReply });

    // the exact expression session-end.ts reads before it enqueues anything
    expect(!!loadSessionState("s1", home).harvestedAt).toBe(true);
    expect(!!loadSessionState("s2", home).harvestedAt).toBe(false);
  });

  it("given a marker past the sweep horizon, when the queue is drained, then it is removed and a fresh marker is kept", async () => {
    await runHarvestJob(job(home), home, { ...deps, runner: async () => harvestReply });
    const markers = readdirSync(harvestedDir(home));
    expect(markers).toHaveLength(1);
    const stale = join(harvestedDir(home), markers[0]!);
    const old = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
    utimesSync(stale, old, old);
    const fresh = join(harvestedDir(home), "s2-4096");
    writeFileSync(fresh, "");

    drainHarvestJobs(home);

    expect(existsSync(stale)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
  });

  it("given a finished marker older than the claim horizon, when the queue is drained, then it survives and still refuses the session", async () => {
    const calls = { n: 0 };
    const j = job(home);
    await runHarvestJob(j, home, { ...deps, runner: countingRunner(calls) });
    const marker = join(harvestedDir(home), readdirSync(harvestedDir(home))[0]!);
    // past the horizon an UNFINISHED marker expires at, far inside the one a
    // finished marker expires at: a completed harvest must not decay into a
    // ten minute dedup just because its runner has long since exited
    const old = new Date(Date.now() - 24 * 60 * 60 * 1000);
    utimesSync(marker, old, old);

    drainHarvestJobs(home);

    expect(existsSync(marker)).toBe(true);
    const again = await runHarvestJob(j, home, { ...deps, runner: countingRunner(calls) });
    expect(calls.n).toBe(1);
    expect(again.outcome).toBe("skipped");
  });
});

describe("a failed harvest is picked up again", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "handbook-test-"));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  const deps = { listSkills: () => [], skillDirs: () => [], remoteUrl: () => null };
  const down: ClaudeRunner = async () => {
    throw new Error("logged out");
  };

  it("given a job whose model call failed, when the queue is drained again, then it is claimed again and its attempts go up", async () => {
    await runHarvestJob(job(home), home, { ...deps, runner: down });

    const second = drainHarvestJobs(home);
    expect(second).toHaveLength(1);
    expect(second[0]!.job.attempts).toBe(1);
    await runHarvestJob(second[0]!.job, home, { ...deps, runner: down });
    releaseHarvestJob(second[0]!.claimedFile);

    const third = drainHarvestJobs(home);
    expect(third).toHaveLength(1);
    expect(third[0]!.job.attempts).toBe(2);
    // the retry carries the ORIGINAL evidence, not a re-derived one: a transient
    // failure must cost nothing but the attempt
    expect(third[0]!.job.sessionId).toBe("s1");
    expect(readCounters(home).gateErrors).toBe(2);
    expect(readCounters(home).gateAbandoned).toBe(0);
    for (const c of third) releaseHarvestJob(c.claimedFile);
  });

  it("given a retry whose model call works, when it runs, then the session's lessons land after all", async () => {
    await runHarvestJob(job(home), home, { ...deps, runner: down });
    const retry = drainHarvestJobs(home);
    const summary = await runHarvestJob(retry[0]!.job, home, { ...deps, runner: async () => harvestReply });
    releaseHarvestJob(retry[0]!.claimedFile);

    expect(summary.outcome).toBe("harvested");
    expect(summary.written).toEqual(["prefer-config-feature-flags"]);
    expect(hasPendingHarvestJobs(home)).toBe(false); // nothing left owed
  });

  it("given a queue holding a retry, when a session starts, then the runner has something to find", () => {
    expect(hasPendingHarvestJobs(home)).toBe(false); // no pending dir at all yet
    enqueueHarvestJob(job(home), home);
    expect(hasPendingHarvestJobs(home)).toBe(true);
  });

  it("given a runner killed mid-harvest, when a session starts, then the queue still owes its job a runner", () => {
    enqueueHarvestJob(job(home), home);
    const claimed = drainHarvestJobs(home);
    expect(claimed).toHaveLength(1);
    // the runner dies here: the claim is never released, and only a drain reclaims it
    const dead = new Date(Date.now() - 11 * 60 * 1000);
    utimesSync(claimed[0]!.claimedFile, dead, dead);

    expect(hasPendingHarvestJobs(home)).toBe(true);
    const reclaimed = drainHarvestJobs(home);
    expect(reclaimed).toHaveLength(1);
    expect(reclaimed[0]!.job.sessionId).toBe("s1");
    for (const c of reclaimed) releaseHarvestJob(c.claimedFile);
  });

  it("given a job another runner is already harvesting, when a session starts, then no second runner is spawned for it", () => {
    enqueueHarvestJob(job(home), home);
    const claimed = drainHarvestJobs(home);
    expect(claimed).toHaveLength(1);
    // in flight as `<job>.json.claimed-<pid>`: the queue owes nothing to a new runner
    expect(hasPendingHarvestJobs(home)).toBe(false);
    releaseHarvestJob(claimed[0]!.claimedFile);
    expect(hasPendingHarvestJobs(home)).toBe(false);
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
