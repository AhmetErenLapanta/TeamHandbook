import { spawn } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
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

export function drainPendingSignals(home: string = handbookHome()): Signal[] {
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
}

export interface PipelineSummary {
  received: number;
  sievedOut: number;
  scored: number;
  rejected: number;
  errored: number;
  written: string[];
  trigger?: "manual";
}

export function pipelineLogFile(home: string = handbookHome()): string {
  return join(home, "pipeline.log");
}

function appendPipelineLog(summary: PipelineSummary, home: string, ts: string): void {
  mkdirSync(home, { recursive: true });
  appendFileSync(pipelineLogFile(home), JSON.stringify({ ts, ...summary }) + "\n");
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
  };
  for (const signal of passed) {
    const occurrences = counts.get(signal.fingerprint) ?? 0;
    const existing = listSkills(defaultSkillDirs(home, signal.cwd));
    const verdict = await scoreSignal(signal, occurrences, scoreConfig, runner, existing);
    summary.scored += 1;
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
  const existing = listSkills(defaultSkillDirs(home, signal.cwd));
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
