import { spawn } from "node:child_process";
import {
  appendFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { teamSkillsDir } from "./init.js";
import { writeFileAtomic } from "./fs-atomic.js";
import { handbookHome } from "./session-state.js";
import type { Signal } from "./signals.js";
import { appendSignals, ledgerFingerprintCounts } from "./signals.js";
import { signalSecret } from "./secrets.js";
import { incrementRedactionBlocked, bumpCounter } from "./counters.js";
import { runRuleSieves } from "./gate.js";
import type { DropReason } from "./gate.js";
import { loadScoreConfig, runClaudeCli, scoreSignal } from "./score.js";
import { distillVerdict, gitRemoteUrl, loadDistillConfig, writeCandidate } from "./distill.js";
import { defaultSkillDirs, listExistingSkills } from "./skill-index.js";
import type { SkillSummary } from "./skill-index.js";
import { candidateMetaFromArtifact, writeCandidateMeta } from "./queue.js";
import { harvestSession } from "./harvest.js";
import type { HarvestDeps, HarvestJob, HarvestSummary } from "./harvest.js";

// ── harvest job hand-off ────────────────────────────────────────────────────
// A session-end hook must exit immediately, so the harvest runs in a detached
// runner. The job file is the crash-safe hand-off between the two.

export function pendingDir(home: string = handbookHome()): string {
  return join(home, "pending");
}

export function enqueueHarvestJob(job: HarvestJob, home: string = handbookHome()): string | null {
  mkdirSync(pendingDir(home), { recursive: true });
  const session = job.sessionId.replace(/[^A-Za-z0-9_-]/g, "_");
  const base = `${session}-${Date.now()}`;
  let file = join(pendingDir(home), `${base}.json`);
  // wx: fail rather than clobber a job a concurrent hook wrote at the same ms.
  for (let i = 0; i < 50; i++) {
    try {
      writeFileSync(file, JSON.stringify(job), { flag: "wx" });
      return file;
    } catch {
      file = join(pendingDir(home), `${base}-x${i}.json`);
    }
  }
  return null;
}

// A runner that crashed between claim and delete leaves a *.claimed-<pid> file no
// drain would ever pick up again — that job would be silently lost. Reclaim claims
// older than this back into the queue.
const STALE_CLAIM_MS = 10 * 60 * 1000;

// ONE stamp per job, never a chain. Every reclaim used to prepend another
// `reclaimed-<ms>-`, so a job handed back round after round grew its name by 24 bytes
// each time: measured at 139 bytes after four reclaims, and renameSync would have
// started failing with ENAMETOOLONG at the 255-byte limit about five rounds later. A
// loop that ends by breaking is not a loop that ends. Replacing the stamp keeps the
// name a constant length while still telling the job coming back apart from a fresh
// enqueue of the same session in the same millisecond.
const RECLAIM_STAMP = /^reclaimed-\d+-/;

// writeFileAtomic's temp sibling below. It survives its own rename only if a runner
// was killed in the microseconds between the two, and it is not a job - but it is
// named `<job>.json.tmp-...`, and notify's pending count reads every name containing
// ".json", so a leaked one would report a session as harvesting forever.
const CLAIM_TEMP = /\.tmp-\d+-\d+-[0-9a-z]+$/;

function reclaimStaleClaims(dir: string): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const file = join(dir, entry);
    if (CLAIM_TEMP.test(entry)) {
      try {
        if (Date.now() - statSync(file).mtimeMs > STALE_CLAIM_MS) rmSync(file, { force: true });
      } catch {
        // raced with the runner that is writing it; it will still be here next drain
      }
      continue;
    }
    const m = entry.match(/^(.+\.json)\.claimed-\d+$/);
    if (!m) continue;
    try {
      if (Date.now() - statSync(file).mtimeMs > STALE_CLAIM_MS) {
        renameSync(file, join(dir, `reclaimed-${Date.now()}-${m[1]!.replace(RECLAIM_STAMP, "")}`));
      }
    } catch {
      // another process may have raced us; nothing to do
    }
  }
}

/**
 * Whether the queue owes a runner any work. The predicate mirrors what the next drain
 * will actually DO, which is more than "an unclaimed file": drainHarvestJobs reclaims
 * stale claims first, so both shapes count.
 *
 * A FRESH claim is not work owed. Its runner is alive and sitting in its model call,
 * and waking a second runner beside it is the duplicate harvest the pipeline hardens
 * against when two runs overlap.
 *
 * A STALE claim is the only kind of work nothing else will ever notice. Its runner was
 * killed mid-harvest, and reclaimStaleClaims - which runs INSIDE the drain - is what
 * hands the job back. Leaving it out here would have rebuilt the very defect this
 * function exists to close, reached from a different file state: no unclaimed `.json`
 * means no runner spawned, no drain, and so nothing to reclaim it, forever.
 */
export function hasPendingHarvestJobs(home: string = handbookHome()): boolean {
  const dir = pendingDir(home);
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return false; // no pending dir yet: nothing to run
  }
  return entries.some((entry) => {
    if (entry.endsWith(".json")) return true;
    if (!/^.+\.json\.claimed-\d+$/.test(entry)) return false;
    try {
      return Date.now() - statSync(join(dir, entry)).mtimeMs > STALE_CLAIM_MS;
    } catch {
      return false; // swept while we looked; the next start will see whatever is left
    }
  });
}

export interface ClaimedJob {
  job: HarvestJob;
  /** the claimed file; delete it only AFTER the job has been processed */
  claimedFile: string;
}

export function releaseHarvestJob(claimedFile: string): void {
  rmSync(claimedFile, { force: true });
}

// How many times a runner may take one job out of the queue before it is given up
// on, instead of losing the session's lessons to a CLI that is logged out or a
// machine that keeps dying. It is a CLAIM budget, not an error budget: a run that
// ends in a logged failure and a run whose runner is killed without logging anything
// cost exactly one each.
const MAX_HARVEST_ATTEMPTS = 3;

export function abandonedFile(home: string = handbookHome()): string {
  return join(home, "abandoned.jsonl");
}

// A harvest job that used up MAX_HARVEST_ATTEMPTS is given up on, but never
// silently: keep the job (its evidence is already secret-sanitized; the transcript
// path is just a path) in abandoned.jsonl so the work is recoverable, and count it
// so status/doctor can report the loss.
function abandonJob(job: HarvestJob, home: string): void {
  try {
    mkdirSync(home, { recursive: true });
    appendFileSync(abandonedFile(home), JSON.stringify(job) + "\n");
  } catch {
    // best-effort; the counter below is the durable signal that this happened
  }
  bumpCounter("gateAbandoned", home);
}

export function drainHarvestJobs(home: string = handbookHome()): ClaimedJob[] {
  reclaimStaleClaims(pendingDir(home));
  cleanupStaleHarvestMarkers(home);
  let entries: string[];
  try {
    entries = readdirSync(pendingDir(home));
  } catch {
    return [];
  }
  const jobs: ClaimedJob[] = [];
  for (const entry of entries.filter((e) => e.endsWith(".json")).sort()) {
    const file = join(pendingDir(home), entry);
    const claimed = `${file}.claimed-${process.pid}`;
    try {
      renameSync(file, claimed);
      // rename PRESERVES mtime, so staleness would be measured from enqueue time —
      // a job that waited 10 min in the queue would be reclaimable the instant it is
      // claimed, handing the same session to two runners. Stamp the claim instead.
      const claimedAt = new Date();
      utimesSync(claimed, claimedAt, claimedAt);
    } catch {
      continue; // another runner claimed this job first
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(claimed, "utf8"));
    } catch {
      rmSync(claimed, { force: true }); // malformed: evidence remains in the ledger
      continue;
    }
    const job = parsed as HarvestJob;
    if (!job || typeof job !== "object" || typeof job.sessionId !== "string" || !job.evidence) {
      rmSync(claimed, { force: true });
      continue;
    }
    // THE ATTEMPT IS SPENT HERE, at the claim, and not where a failure is reported.
    // A runner killed mid-harvest (machine asleep, OOM, kill -9) never reaches the
    // error branch in runHarvestJob, so counting there capped only the failures that
    // lived long enough to log themselves. Measured on that path before this line
    // existed: four session starts, five model calls, attempts stuck at 0, the job
    // never leaving the queue - one call per session start for as long as the user
    // keeps opening sessions. Claiming is the ONE moment both endings pass through,
    // so `attempts` counts times a runner took this job out of the queue, and the cap
    // holds however that runner ended.
    const attempts = (job.attempts ?? 0) + 1;
    if (attempts > MAX_HARVEST_ATTEMPTS) {
      abandonJob(job, home); // out of the queue, into abandoned.jsonl: never silent
      rmSync(claimed, { force: true });
      continue;
    }
    const claimedJob: HarvestJob = { ...job, attempts };
    try {
      // Durable BEFORE the model call, or a kill would not cost what it just spent.
      // Atomic because a torn rewrite would be read back as a malformed job and
      // deleted above, which is the one outcome worse than the loop. A write that
      // fails spends no model call at all: the claim keeps the fresh mtime stamped
      // above, so nothing reclaims this job for another claim horizon.
      writeFileAtomic(claimed, JSON.stringify(claimedJob));
    } catch {
      continue;
    }
    // NOT deleted here: a runner killed mid-harvest must leave the claim behind so
    // reclaimStaleClaims can put the whole session back in the queue
    jobs.push({ job: claimedJob, claimedFile: claimed });
  }
  return jobs;
}

export interface PipelineDeps extends HarvestDeps {
  marketplacesRoot?: string;
}

/** The dirs dedup scans: queue, the signal's project, and (when a team is
 * configured) the locally-pulled team marketplace skills. */
function dedupSkillDirs(home: string, cwd: string, marketplacesRootDir?: string): string[] {
  const dirs = defaultSkillDirs(home, cwd);
  const team = teamSkillsDir(home, marketplacesRootDir);
  if (team) dirs.push(team);
  return dirs;
}

// ── shared run log ──────────────────────────────────────────────────────────

export interface GateOutcomeLog {
  fingerprint: string;
  outcome: "promote" | "reject" | "error" | "sieved";
  total?: number;
  rationale?: string;
  duplicateOf?: string;
  reason?: string;
  detail?: string;
  error?: string;
  // set when the signal exhausted its retries and was given up on this run
  abandoned?: boolean;
}

export interface PipelineSummary {
  received: number;
  sievedOut: number;
  scored: number;
  rejected: number;
  errored: number;
  written: string[];
  // Why each item was written/dropped — without this a user whose candidates keep
  // vanishing has no way to see the scores or reasons.
  outcomes?: GateOutcomeLog[];
  trigger?: "manual";
  // present on session-harvest runs
  harvest?: { sessionId: string; skipped?: string; redactedLines?: number };
}

export function pipelineLogFile(home: string = handbookHome()): string {
  return join(home, "pipeline.log");
}

const LOG_ROTATE_BYTES = 512 * 1024;
const LOG_KEEP_LINES = 200;

function appendPipelineLog(summary: PipelineSummary, home: string, ts: string): void {
  mkdirSync(home, { recursive: true });
  const file = pipelineLogFile(home);
  appendFileSync(file, JSON.stringify({ ts, ...summary }) + "\n");
  try {
    if (statSync(file).size > LOG_ROTATE_BYTES) {
      const lines = readFileSync(file, "utf8").trim().split("\n");
      writeFileAtomic(file, lines.slice(-LOG_KEEP_LINES).join("\n") + "\n");
    }
  } catch {
    // rotation is best-effort
  }
}

// ── harvest once per transcript state ───────────────────────────────────────
// Measured on one machine's pipeline.log: 13 sessions were harvested more than
// once. Eight of them were RESUMED sessions whose transcript had grown between the
// runs, so each run read a tail the previous one could not see and produced its own
// real lessons (one session was resumed across a month and yielded 13 candidates
// over five later runs). Keying this guard on sessionId alone would have thrown all
// of those away. The waste is the four sessions whose transcript had NOT changed:
// 5 model calls and 6 duplicate candidates, two of them the same three lessons
// reworded. So the identity of a harvest is the session AND the transcript state it
// read, not the session.
//
// The marker is created with "wx" - the exclusive-create idiom enqueueHarvestJob
// already uses above - because O_EXCL is atomic across processes and a look-then-run
// check on pipeline.log is not. That difference is the fix: the duplicate pairs
// finished 1.702s and 0.007s apart against a harvest measured at ~25s, so both runs
// were already in flight before either could log anything to look at.
export function harvestedDir(home: string = handbookHome()): string {
  return join(home, "harvested");
}

function harvestMarkerFile(job: HarvestJob, home: string): string | null {
  // No transcript, or a transcript we cannot stat, means no identity to key on, so
  // the guard steps aside and the job runs. A session whose transcript appears later
  // must never be locked out by a run that skipped for "no transcript".
  if (!job.transcriptPath) return null;
  let size: number;
  try {
    size = statSync(job.transcriptPath).size;
  } catch {
    return null;
  }
  const session = job.sessionId.replace(/[^A-Za-z0-9_-]/g, "_");
  return join(harvestedDir(home), `${session}-${size}`);
}

// A marker is written in two phases, because a harvest can die between them. The
// exclusive create that wins the race says "claimed"; only a harvest that RETURNED
// overwrites it with "done". A marker still reading "claimed" long after its claim
// belongs to a runner that never came back (SIGKILL, OOM, a machine that slept and
// then shut down), and it must NOT turn the session away. Measured against this
// file before the phases existed: a runner killed mid-harvest left its marker
// behind, and the job reclaimStaleClaims handed back was skipped with zero model
// calls, so the session's lessons were lost until its transcript grew.
const MARKER_CLAIMED = "claimed";
const MARKER_DONE = "done";

function markerIsFinished(marker: string): boolean {
  try {
    return readFileSync(marker, "utf8").trim() === MARKER_DONE;
  } catch {
    // An unreadable marker counts as unfinished on purpose: re-harvesting costs one
    // model call, believing it costs the session's lessons.
    return false;
  }
}

function claimHarvest(marker: string, home: string): boolean {
  try {
    mkdirSync(harvestedDir(home), { recursive: true });
    writeFileSync(marker, MARKER_CLAIMED, { flag: "wx" });
    return true;
  } catch (err) {
    // Any failure OTHER than EEXIST (unwritable home, full disk) lets the harvest
    // proceed - this guard exists to save duplicate work, not to become a new way to
    // lose a session's lessons.
    if ((err as NodeJS.ErrnoException)?.code !== "EEXIST") return true;
    // EEXIST on a finished marker is the whole point: this session was already
    // harvested at this exact transcript length.
    if (markerIsFinished(marker)) return false;
    let claimedAt: number;
    try {
      claimedAt = statSync(marker).mtimeMs;
    } catch {
      return true; // swept between the create and the stat: nothing holds it now
    }
    // Still "claimed" inside the horizon is a runner sitting in its model call,
    // which is the concurrent-duplicate case this guard was built to stop.
    if (Date.now() - claimedAt <= STALE_CLAIM_MS) return false;
    // Past the horizon with no "done": its runner was killed mid-harvest. Take the
    // marker over the way it was won in the first place, by deleting it and racing
    // for the exclusive create again. A plain overwrite would be the one non-atomic
    // step in a guard whose correctness rests on O_EXCL, and two runners reclaiming
    // the same abandoned marker would then both harvest.
    rmSync(marker, { force: true });
    try {
      writeFileSync(marker, MARKER_CLAIMED, { flag: "wx" });
      return true;
    } catch {
      return false; // another runner took it over first, and is harvesting it now
    }
  }
}

function finishHarvest(marker: string): void {
  try {
    writeFileSync(marker, MARKER_DONE);
  } catch {
    // The marker stays "claimed" and is swept at the claim horizon below: at worst
    // one duplicate harvest later, never a lost one.
  }
}

// TWO HORIZONS, deliberately different because they answer different questions.
//
// An UNFINISHED marker expires at STALE_CLAIM_MS, the same ten minutes
// reclaimStaleClaims uses to put a killed runner's job back in the queue. The two
// must agree: a longer-lived unfinished marker is the queue handing the session
// back and the marker turning it away at the door. Nothing legitimate lives that
// long on this side of the line either, because the harvest's own claude call is
// capped at 180s (defaultHarvestConfig.timeoutMs), so a running harvest cannot be
// mistaken for an abandoned one.
//
// A FINISHED marker expires at MARKER_MAX_AGE_MS. It records work that really
// happened, so it outlives the session file it guards (SESSION_MAX_AGE_MS, 7d) and
// then stops meaning anything: a resumed session gets a different length and so a
// different marker. Both are swept at drain time, where reclaimStaleClaims already
// does the queue's housekeeping, so the directory cannot grow without bound.
const MARKER_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

function cleanupStaleHarvestMarkers(home: string, now: number = Date.now()): void {
  const dir = harvestedDir(home);
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    try {
      const file = join(dir, entry);
      const horizon = markerIsFinished(file) ? MARKER_MAX_AGE_MS : STALE_CLAIM_MS;
      if (now - statSync(file).mtimeMs > horizon) rmSync(file, { force: true });
    } catch {
      // raced with a live runner; leave it
    }
  }
}

/** Run one harvest job: harvest → write candidates → log; retry or abandon on error. */
export async function runHarvestJob(
  job: HarvestJob,
  home: string = handbookHome(),
  deps: PipelineDeps = {},
  now: () => string = () => new Date().toISOString(),
): Promise<HarvestSummary> {
  const marker = harvestMarkerFile(job, home);
  if (marker && !claimHarvest(marker, home)) {
    const reason = "already harvested at this transcript length";
    appendPipelineLog(
      {
        received: 0,
        sievedOut: 0,
        scored: 0,
        rejected: 0,
        errored: 0,
        written: [],
        harvest: { sessionId: job.sessionId, skipped: reason },
      },
      home,
      now(),
    );
    return { outcome: "skipped", reason, written: [] };
  }
  const summary = await harvestSession(job, home, deps);
  const log: PipelineSummary = {
    received: summary.produced ?? 0,
    sievedOut: summary.dropped?.length ?? 0,
    scored: summary.produced ?? 0,
    rejected: 0,
    errored: summary.outcome === "error" ? 1 : 0,
    written: summary.written,
    harvest: {
      sessionId: job.sessionId,
      ...(summary.outcome === "skipped" ? { skipped: summary.reason } : {}),
      ...(summary.redactedLines ? { redactedLines: summary.redactedLines } : {}),
    },
    outcomes: [
      ...(summary.dropped ?? []).map((d) => ({
        // an item dropped FOR containing a secret must not have its name logged —
        // the name is model output derived from the same text
        fingerprint: d.reason === "secret" ? "(redacted)" : d.name,
        outcome: "sieved" as const,
        reason: d.reason,
      })),
      ...(summary.outcome === "error"
        ? [{ fingerprint: job.sessionId, outcome: "error" as const, error: summary.error?.slice(0, 200) }]
        : []),
    ],
  };
  if (summary.outcome === "error") {
    // An errored run harvested nothing, so it must not block its own retry: a
    // measured session whose model call failed produced two real candidates on the
    // retry, from the very same transcript bytes. Releasing the marker here is what
    // keeps "already harvested" meaning a run that COMPLETED, rather than a run that
    // merely happened.
    if (marker) rmSync(marker, { force: true });
    bumpCounter("gateErrors", home);
    // This attempt was already spent, and written into the job, when the runner
    // claimed it. Counting it again here would charge a reported failure twice what a
    // silent kill costs and burn the budget in half the runs.
    const attempts = job.attempts ?? 0;
    if (attempts < MAX_HARVEST_ATTEMPTS) {
      enqueueHarvestJob({ ...job, attempts }, home);
    } else {
      log.outcomes!.push({ fingerprint: job.sessionId, outcome: "error", abandoned: true });
      abandonJob(job, home);
    }
  } else if (marker) {
    // The harvest returned, so the claim graduates to "done" and starts refusing
    // duplicates for real. Until this line runs the marker only means "a runner took
    // this on", which is why a run that never reached it does not block the next one.
    finishHarvest(marker);
  }
  appendPipelineLog(log, home, now());
  return summary;
}

// ── manual path (/handbook:learn) ───────────────────────────────────────────

export type ManualOutcome =
  | { stage: "sieved"; reason: DropReason; detail?: string }
  | { stage: "error"; message: string }
  // the model invoked /handbook:learn on its own (signal.trigger === "manual-model")
  // and the gate rejected it: enforced, not carried as advice, because there was no
  // explicit ask to honor
  | { stage: "vetoed"; gateTotal: number | null; threshold: number; rationale?: string }
  | {
      stage: "written";
      slug: string;
      gateTotal: number | null;
      scope: string;
      // the user explicitly asked for this skill, so a low gate score is advice,
      // not a veto: the candidate is written either way and these fields let the
      // review surface the gate's dissent
      belowThreshold?: boolean;
      threshold?: number;
      rationale?: string;
      duplicateOf?: string;
    };

export async function runManualSignal(
  signal: Signal,
  home: string = handbookHome(),
  deps: PipelineDeps = {},
  now: () => string = () => new Date().toISOString(),
): Promise<ManualOutcome> {
  const runner = deps.runner ?? runClaudeCli;
  const remoteUrl = deps.remoteUrl ?? gitRemoteUrl;
  const listSkills = deps.listSkills ?? listExistingSkills;
  const scoreConfig = loadScoreConfig(home);
  const distillConfig = loadDistillConfig(home);
  const summary: PipelineSummary = {
    received: 1,
    sievedOut: 0,
    scored: 0,
    rejected: 0,
    errored: 0,
    written: [],
    trigger: "manual",
  };
  const finish = <T extends ManualOutcome>(outcome: T): T => {
    appendPipelineLog(summary, home, now());
    return outcome;
  };
  // On a secret, store nothing at all (not even a ledger tombstone beyond the
  // counter) and tell the user honestly — matches learn.ts's message.
  const secret = signalSecret(signal);
  if (secret) {
    incrementRedactionBlocked(home, 1);
    summary.sievedOut = 1;
    return finish({ stage: "sieved", reason: "secret", detail: secret });
  }
  // Sieve BEFORE the ledger append: an oversized capture must not park its full
  // content in signals.jsonl, and a retried capture must not inflate recurrence.
  const { passed, dropped } = runRuleSieves([signal], home);
  if (passed.length === 0) {
    summary.sievedOut = 1;
    const decision = dropped[0]!;
    return finish({
      stage: "sieved",
      reason: decision.reason ?? "oversized",
      ...(decision.detail ? { detail: decision.detail } : {}),
    });
  }
  appendSignals([signal], home);
  const occurrences = ledgerFingerprintCounts(home).get(signal.fingerprint) ?? 1;
  const existing = listSkills(dedupSkillDirs(home, signal.cwd, deps.marketplacesRoot));
  const verdict = await scoreSignal(signal, occurrences, scoreConfig, runner, existing);
  summary.scored = 1;
  // A scoring failure only aborts when the model itself is unreachable (distill
  // would fail the same way). An unparseable score reply still lets the user's
  // explicit capture proceed — with gate: null attached.
  if (verdict.outcome === "error" && !(verdict.error ?? "").includes("unparseable")) {
    summary.errored = 1;
    return finish({ stage: "error", message: verdict.error ?? "gate scoring failed" });
  }
  // A capture the user explicitly typed is ALWAYS distilled and queued; the gate's
  // dissent travels with it as advice, and the share decision (publish to the team
  // or not) is the user's, at /handbook:review. One the model started on its own
  // (signal.trigger === "manual-model") gets no such pass: a rejected verdict is
  // enforced here, the same as the automatic end-of-session harvest, because there
  // was no explicit ask to honor.
  const total = verdict.result?.total ?? null;
  const belowThreshold = total !== null && total < scoreConfig.threshold;
  if (verdict.outcome !== "promote" && signal.trigger !== "manual") {
    summary.rejected = 1;
    return finish({
      stage: "vetoed",
      gateTotal: total,
      threshold: scoreConfig.threshold,
      ...(verdict.result?.rationale ? { rationale: verdict.result.rationale } : {}),
    });
  }
  const duplicateOf = verdict.result?.duplicateOf;
  const outcome = await distillVerdict(verdict, occurrences, distillConfig, runner, remoteUrl);
  if (outcome.outcome !== "distilled" || !outcome.artifact) {
    summary.errored = 1;
    return finish({ stage: "error", message: outcome.error ?? "distillation failed" });
  }
  const dir = writeCandidate(outcome.artifact, home);
  const slug = basename(dir);
  writeCandidateMeta(dir, candidateMetaFromArtifact(slug, outcome.artifact, verdict, now()));
  summary.written.push(slug);
  return finish({
    stage: "written",
    slug,
    gateTotal: total,
    scope: outcome.artifact.scope,
    ...(belowThreshold
      ? {
          belowThreshold: true,
          threshold: scoreConfig.threshold,
          ...(verdict.result?.rationale ? { rationale: verdict.result.rationale } : {}),
        }
      : {}),
    ...(duplicateOf ? { duplicateOf } : {}),
  });
}

export function spawnPipelineRunner(
  runnerScript: string,
  spawnFn: typeof spawn = spawn,
): void {
  const child = spawnFn(process.execPath, [runnerScript], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
}

// re-exported so hooks and tests keep a single import site
export type { SkillSummary };
