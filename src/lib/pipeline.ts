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
import { incrementRedactionBlocked } from "./counters.js";
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
  outcome: "promote" | "reject" | "error";
  total?: number;
  rationale?: string;
  duplicateOf?: string;
}

export interface PipelineSummary {
  received: number;
  sievedOut: number;
  scored: number;
  rejected: number;
  errored: number;
  written: string[];
  // Why each scored signal was promoted/rejected — without this a user whose
  // candidates keep being rejected has no way to see the scores or reasons.
  outcomes?: GateOutcomeLog[];
  trigger?: "manual";
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
  const summary: PipelineSummary = {
    received: signals.length,
    sievedOut: dropped.length,
    scored: 0,
    rejected: 0,
    errored: 0,
    written: [],
    outcomes: [],
  };
  for (const signal of passed) {
    const occurrences = counts.get(signal.fingerprint) ?? 0;
    const existing = listSkills(dedupSkillDirs(home, signal.cwd, deps.marketplacesRoot));
    const verdict = await scoreSignal(signal, occurrences, scoreConfig, runner, existing);
    summary.scored += 1;
    summary.outcomes!.push({
      fingerprint: signal.fingerprint,
      outcome: verdict.outcome === "promote" ? "promote" : verdict.outcome === "reject" ? "reject" : "error",
      ...(verdict.result ? { total: verdict.result.total } : {}),
      ...(verdict.result?.rationale ? { rationale: verdict.result.rationale.slice(0, 200) } : {}),
      ...(verdict.result?.duplicateOf ? { duplicateOf: verdict.result.duplicateOf } : {}),
    });
    if (verdict.outcome === "reject") {
      summary.rejected += 1;
      continue;
    }
    if (verdict.outcome === "error") {
      summary.errored += 1;
      continue;
    }
    const outcome = await distillVerdict(verdict, occurrences, distillConfig, runner, remoteUrl);
    if (outcome.outcome !== "distilled" || !outcome.artifact) {
      summary.errored += 1;
      continue;
    }
    const dir = writeCandidate(outcome.artifact, home);
    const slug = basename(dir);
    writeCandidateMeta(dir, candidateMetaFromArtifact(slug, outcome.artifact, verdict, now()));
    summary.written.push(slug);
  }
  appendPipelineLog(summary, home, now());
  return summary;
}

export type ManualOutcome =
  | { stage: "sieved"; reason: DropReason; detail?: string }
  | { stage: "gate-rejected"; total: number; threshold: number; duplicateOf?: string; rationale?: string }
  | { stage: "error"; message: string }
  | { stage: "written"; slug: string; gateTotal: number | null; scope: string };

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
  appendSignals([signal], home);
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
  const occurrences = ledgerFingerprintCounts(home).get(signal.fingerprint) ?? 1;
  const existing = listSkills(dedupSkillDirs(home, signal.cwd, deps.marketplacesRoot));
  const verdict = await scoreSignal(signal, occurrences, scoreConfig, runner, existing);
  summary.scored = 1;
  if (verdict.outcome === "error") {
    summary.errored = 1;
    return finish({ stage: "error", message: verdict.error ?? "gate scoring failed" });
  }
  if (verdict.outcome === "reject") {
    summary.rejected = 1;
    return finish({
      stage: "gate-rejected",
      total: verdict.result?.total ?? 0,
      threshold: scoreConfig.threshold,
      ...(verdict.result?.duplicateOf ? { duplicateOf: verdict.result.duplicateOf } : {}),
      ...(verdict.result?.rationale ? { rationale: verdict.result.rationale } : {}),
    });
  }
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
    gateTotal: verdict.result?.total ?? null,
    scope: outcome.artifact.scope,
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
