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

function reclaimStaleClaims(dir: string): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const m = entry.match(/^(.+\.json)\.claimed-\d+$/);
    if (!m) continue;
    try {
      const file = join(dir, entry);
      if (Date.now() - statSync(file).mtimeMs > STALE_CLAIM_MS) {
        renameSync(file, join(dir, `reclaimed-${Date.now()}-${m[1]}`));
      }
    } catch {
      // another process may have raced us; nothing to do
    }
  }
}

export interface ClaimedJob {
  job: HarvestJob;
  /** the claimed file; delete it only AFTER the job has been processed */
  claimedFile: string;
}

export function releaseHarvestJob(claimedFile: string): void {
  rmSync(claimedFile, { force: true });
}

export function drainHarvestJobs(home: string = handbookHome()): ClaimedJob[] {
  reclaimStaleClaims(pendingDir(home));
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
    if (job && typeof job === "object" && typeof job.sessionId === "string" && job.evidence) {
      // NOT deleted here: a runner killed mid-harvest must leave the claim behind so
      // reclaimStaleClaims can put the whole session back in the queue
      jobs.push({ job, claimedFile: claimed });
    } else {
      rmSync(claimed, { force: true });
    }
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

export function abandonedFile(home: string = handbookHome()): string {
  return join(home, "abandoned.jsonl");
}

// A harvest job that failed MAX_HARVEST_ATTEMPTS times is given up on, but never
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

// Re-try a harvest whose claude call failed (logged-out CLI, timeout) this many
// times across runs before giving up, instead of losing the session's lessons.
const MAX_HARVEST_ATTEMPTS = 3;

/** Run one harvest job: harvest → write candidates → log; retry or abandon on error. */
export async function runHarvestJob(
  job: HarvestJob,
  home: string = handbookHome(),
  deps: PipelineDeps = {},
  now: () => string = () => new Date().toISOString(),
): Promise<HarvestSummary> {
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
    bumpCounter("gateErrors", home);
    const attempts = (job.attempts ?? 0) + 1;
    if (attempts < MAX_HARVEST_ATTEMPTS) {
      enqueueHarvestJob({ ...job, attempts }, home);
    } else {
      log.outcomes!.push({ fingerprint: job.sessionId, outcome: "error", abandoned: true });
      abandonJob(job, home);
    }
  }
  appendPipelineLog(log, home, now());
  return summary;
}

// ── manual path (/handbook:learn) — unchanged behavior ─────────────────────

export type ManualOutcome =
  | { stage: "sieved"; reason: DropReason; detail?: string }
  | { stage: "error"; message: string }
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
  // The user explicitly asked for this skill, so it is ALWAYS distilled and
  // queued; the gate's dissent travels with it as advice. The share decision —
  // publish to the team or not — is the user's, at /handbook:review.
  const total = verdict.result?.total ?? null;
  const belowThreshold = total !== null && total < scoreConfig.threshold;
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
