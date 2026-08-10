import { spawn } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { teamSkillsDir } from "./init.js";
import { writeFileAtomic } from "./fs-atomic.js";
import { handbookHome } from "./session-state.js";
import type { Signal } from "./signals.js";
import { appendSignals, ledgerFingerprintCounts, sanitizeSignalsForPersistence } from "./signals.js";
import { signalSecret } from "./secrets.js";
import { incrementRedactionBlocked, bumpCounter } from "./counters.js";
import { runRuleSieves } from "./gate.js";
import type { DropReason } from "./gate.js";
import { loadScoreConfig, runClaudeCli, scoreSignal } from "./score.js";
import type { ClaudeRunner } from "./score.js";
import { distillVerdict, gitRemoteUrl, loadDistillConfig, writeCandidate } from "./distill.js";
import { defaultSkillDirs, listExistingSkills } from "./skill-index.js";
import type { SkillSummary } from "./skill-index.js";
import { candidateMetaFromArtifact, writeCandidateMeta } from "./queue.js";

export function pendingDir(home: string = handbookHome()): string {
  return join(home, "pending");
}

export function enqueuePendingSignals(signals: Signal[], home: string = handbookHome()): string | null {
  if (signals.length === 0) return null;
  // The handoff file also lands on disk, so sanitize it too. The ledger append
  // (appendSignals) already counted these secrets, so don't re-count here.
  const { clean } = sanitizeSignalsForPersistence(signals);
  mkdirSync(pendingDir(home), { recursive: true });
  const session = signals[0]!.sessionId.replace(/[^A-Za-z0-9_-]/g, "_");
  const base = `${session}-${Date.now()}`;
  let file = join(pendingDir(home), `${base}.json`);
  for (let i = 2; existsSync(file); i++) {
    file = join(pendingDir(home), `${base}-${i}.json`);
  }
  // wx: fail rather than clobber a batch a concurrent hook wrote at the same ms.
  for (let i = 0; i < 50; i++) {
    try {
      writeFileSync(file, JSON.stringify(clean), { flag: "wx" });
      return file;
    } catch {
      file = join(pendingDir(home), `${base}-x${i}.json`);
    }
  }
  return null;
}

// A runner that crashed between claim and delete leaves a *.claimed-<pid> file no
// drain would ever pick up again — those signals would be silently lost. Reclaim
// claims older than this back into the queue.
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

export function drainPendingSignals(home: string = handbookHome()): Signal[] {
  reclaimStaleClaims(pendingDir(home));
  let entries: string[];
  try {
    entries = readdirSync(pendingDir(home));
  } catch {
    return [];
  }
  const signals: Signal[] = [];
  for (const entry of entries.filter((e) => e.endsWith(".json")).sort()) {
    const file = join(pendingDir(home), entry);
    const claimed = `${file}.claimed-${process.pid}`;
    try {
      renameSync(file, claimed);
    } catch {
      continue; // another runner claimed this batch first
    }
    try {
      const parsed = JSON.parse(readFileSync(claimed, "utf8"));
      if (Array.isArray(parsed)) signals.push(...parsed);
    } catch {
      // malformed batch: dropped, but the signals remain in the ledger
    }
    rmSync(claimed, { force: true });
  }
  return signals;
}

export interface PipelineDeps {
  runner?: ClaudeRunner;
  remoteUrl?: (cwd: string) => string | null;
  listSkills?: (dirs: string[]) => SkillSummary[];
  marketplacesRoot?: string;
}

/** The dirs the gate's dedup scans: queue, the signal's project, and (when a team
 * is configured) the locally-pulled team marketplace skills. */
function dedupSkillDirs(home: string, cwd: string, marketplacesRootDir?: string): string[] {
  const dirs = defaultSkillDirs(home, cwd);
  const team = teamSkillsDir(home, marketplacesRootDir);
  if (team) dirs.push(team);
  return dirs;
}

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
  deferred?: number;
  written: string[];
  // Why each scored signal was promoted/rejected/sieved — without this a user
  // whose candidates keep vanishing has no way to see the scores or reasons.
  outcomes?: GateOutcomeLog[];
  trigger?: "manual";
}

export function pipelineLogFile(home: string = handbookHome()): string {
  return join(home, "pipeline.log");
}

export function abandonedFile(home: string = handbookHome()): string {
  return join(home, "abandoned.jsonl");
}

// A signal that failed the gate/distill MAX_GATE_ATTEMPTS times is given up on, but
// never silently: keep the (already secret-sanitized) signal in abandoned.jsonl so
// the work is recoverable, and count it so status/doctor can report the loss.
function abandonSignal(signal: Signal, home: string): void {
  try {
    mkdirSync(home, { recursive: true });
    appendFileSync(abandonedFile(home), JSON.stringify(signal) + "\n");
  } catch {
    // best-effort; the counter below is the durable signal that this happened
  }
  bumpCounter("gateAbandoned", home);
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

// A bad week can queue many recurring pairs; cap the gate calls per run so a
// single detached run never fires a surprise stack of claude -p invocations
// against the user's quota. The rest wait for the next run.
const MAX_SCORED_PER_RUN = 6;
// Re-try a signal whose gate/distill call failed (logged-out claude, timeout)
// this many times across runs before giving up, instead of losing it.
const MAX_GATE_ATTEMPTS = 3;

export async function runPipeline(
  signals: Signal[],
  home: string = handbookHome(),
  deps: PipelineDeps = {},
  now: () => string = () => new Date().toISOString(),
): Promise<PipelineSummary> {
  const runner = deps.runner ?? runClaudeCli;
  const remoteUrl = deps.remoteUrl ?? gitRemoteUrl;
  const listSkills = deps.listSkills ?? listExistingSkills;
  const scoreConfig = loadScoreConfig(home);
  const distillConfig = loadDistillConfig(home);
  const { passed, dropped } = runRuleSieves(signals, home);
  const counts = ledgerFingerprintCounts(home);
  const toScore = passed.slice(0, MAX_SCORED_PER_RUN);
  const deferred = passed.slice(MAX_SCORED_PER_RUN);
  const summary: PipelineSummary = {
    received: signals.length,
    sievedOut: dropped.length,
    scored: 0,
    rejected: 0,
    errored: 0,
    deferred: deferred.length,
    written: [],
    outcomes: dropped.map((d) => ({
      fingerprint: d.signal.fingerprint,
      outcome: "sieved" as const,
      ...(d.reason ? { reason: d.reason } : {}),
      ...(d.detail ? { detail: d.detail } : {}),
    })),
  };
  const retry: Signal[] = [];
  for (const signal of toScore) {
    const occurrences = counts.get(signal.fingerprint) ?? 0;
    const existing = listSkills(dedupSkillDirs(home, signal.cwd, deps.marketplacesRoot));
    const verdict = await scoreSignal(signal, occurrences, scoreConfig, runner, existing);
    summary.scored += 1;
    const log: GateOutcomeLog = {
      fingerprint: signal.fingerprint,
      outcome: verdict.outcome === "promote" ? "promote" : verdict.outcome === "reject" ? "reject" : "error",
      ...(verdict.result ? { total: verdict.result.total } : {}),
      ...(verdict.result?.rationale ? { rationale: verdict.result.rationale.slice(0, 200) } : {}),
      ...(verdict.result?.duplicateOf ? { duplicateOf: verdict.result.duplicateOf } : {}),
      ...(verdict.outcome === "error" && verdict.error ? { error: verdict.error.slice(0, 200) } : {}),
    };
    summary.outcomes!.push(log);
    if (verdict.outcome === "reject") {
      summary.rejected += 1;
      continue;
    }
    if (verdict.outcome === "error") {
      summary.errored += 1;
      if (!queueRetry(signal, retry)) {
        log.abandoned = true;
        abandonSignal(signal, home);
      }
      continue;
    }
    const outcome = await distillVerdict(verdict, occurrences, distillConfig, runner, remoteUrl);
    if (outcome.outcome !== "distilled" || !outcome.artifact) {
      summary.errored += 1;
      // The gate promoted it but distillation failed; correct the log entry so the
      // signal is recorded as errored (not a phantom "promote") with the reason.
      log.outcome = "error";
      if (outcome.error) log.error = outcome.error.slice(0, 200);
      if (!queueRetry(signal, retry)) {
        log.abandoned = true;
        abandonSignal(signal, home);
      }
      continue;
    }
    const dir = writeCandidate(outcome.artifact, home);
    const slug = basename(dir);
    writeCandidateMeta(dir, candidateMetaFromArtifact(slug, outcome.artifact, verdict, now()));
    summary.written.push(slug);
  }
  // hold the deferred-but-clean signals and the retryable failures for next run
  const requeue = [...deferred, ...retry];
  if (requeue.length > 0) enqueuePendingSignals(requeue, home);
  if (summary.errored > 0) bumpCounter("gateErrors", home);
  appendPipelineLog(summary, home, now());
  return summary;
}

function queueRetry(signal: Signal, retry: Signal[]): boolean {
  const attempts = (signal.attempts ?? 0) + 1;
  if (attempts < MAX_GATE_ATTEMPTS) {
    retry.push({ ...signal, attempts });
    return true;
  }
  return false;
}

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
      reason: decision.reason ?? "not-candidate",
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
