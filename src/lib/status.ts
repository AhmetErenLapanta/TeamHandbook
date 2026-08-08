import { readFileSync } from "node:fs";
import { handbookHome } from "./session-state.js";
import { signalsFile } from "./signals.js";
import { readCounters } from "./counters.js";
import { listCandidates } from "./queue.js";
import { loadScoreConfig } from "./score.js";
import { loadDistillConfig } from "./distill.js";
import { loadNotifyConfig } from "./notify.js";
import { pipelineLogFile } from "./pipeline.js";
import type { PipelineSummary } from "./pipeline.js";

export interface LedgerStats {
  total: number;
  candidates: number;
  weak: number;
  distinctFingerprints: number;
}

export function ledgerStats(home: string = handbookHome()): LedgerStats {
  const stats: LedgerStats = { total: 0, candidates: 0, weak: 0, distinctFingerprints: 0 };
  let raw: string;
  try {
    raw = readFileSync(signalsFile(home), "utf8");
  } catch {
    return stats;
  }
  const fingerprints = new Set<string>();
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let parsed: { kind?: unknown; fingerprint?: unknown };
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    stats.total += 1;
    if (parsed.kind === "candidate") stats.candidates += 1;
    if (parsed.kind === "weak") stats.weak += 1;
    if (typeof parsed.fingerprint === "string") fingerprints.add(parsed.fingerprint);
  }
  stats.distinctFingerprints = fingerprints.size;
  return stats;
}

export function lastPipelineRun(
  home: string = handbookHome(),
): (PipelineSummary & { ts: string }) | null {
  let raw: string;
  try {
    raw = readFileSync(pipelineLogFile(home), "utf8");
  } catch {
    return null;
  }
  const lines = raw.split("\n").filter((l) => l.trim());
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const parsed = JSON.parse(lines[i]!);
      if (typeof parsed?.ts === "string") return parsed;
    } catch {
      // skip malformed lines
    }
  }
  return null;
}

export interface StatusReport {
  home: string;
  ledger: LedgerStats;
  queue: { pending: number; approved: number; rejected: number };
  redactionBlocked: number;
  detector: { postToolUse: number; bashFailuresCaptured: number; pairsResolved: number };
  lastRun: (PipelineSummary & { ts: string }) | null;
  config: {
    gateModel: string;
    gateThreshold: number;
    distillModel: string;
    sessionStartNotice: boolean;
  };
}

export function gatherStatus(home: string = handbookHome()): StatusReport {
  const candidates = listCandidates(home);
  const count = (status: string) => candidates.filter((c) => c.status === status).length;
  const score = loadScoreConfig(home);
  const distill = loadDistillConfig(home);
  const counters = readCounters(home);
  return {
    home,
    ledger: ledgerStats(home),
    queue: {
      pending: count("pending"),
      approved: count("approved"),
      rejected: count("rejected"),
    },
    redactionBlocked: counters.redactionBlocked,
    detector: {
      postToolUse: counters.postToolUse,
      bashFailuresCaptured: counters.bashFailuresCaptured,
      pairsResolved: counters.pairsResolved,
    },
    lastRun: lastPipelineRun(home),
    config: {
      gateModel: score.model,
      gateThreshold: score.threshold,
      distillModel: distill.model || "(default)",
      sessionStartNotice: loadNotifyConfig(home).sessionStart,
    },
  };
}

function formatLastRejection(lastRun: (PipelineSummary & { ts: string }) | null): string[] {
  const reject = lastRun?.outcomes?.filter((o) => o.outcome === "reject").at(-1);
  if (!reject) return [];
  const score = reject.total !== undefined ? `${reject.total}/10` : "n/a";
  const why = reject.duplicateOf
    ? `duplicate of "${reject.duplicateOf}"`
    : reject.rationale ?? "no rationale recorded";
  return [`Last rejection:  ${score} — ${why}`];
}

export function formatStatus(report: StatusReport): string {
  const { ledger, queue, lastRun, config } = report;
  const lines = [
    `TeamHandbook status  (${report.home})`,
    "",
    `Detector:        ${report.detector.postToolUse} tool calls seen, ${report.detector.bashFailuresCaptured} failures captured, ${report.detector.pairsResolved} pairs resolved`,
    `Signal ledger:   ${ledger.total} signals (${ledger.candidates} candidate, ${ledger.weak} weak), ${ledger.distinctFingerprints} distinct fingerprints`,
    `Candidate queue: ${queue.pending} pending, ${queue.approved} approved, ${queue.rejected} rejected`,
    `Secret vetoes:   ${report.redactionBlocked} candidate(s) dropped by the secret scan`,
    lastRun
      ? `Last gate run:   ${lastRun.ts}${lastRun.trigger === "manual" ? " (manual)" : ""} — ${lastRun.received} received, ${lastRun.sievedOut} sieved out, ${lastRun.rejected} rejected, ${lastRun.errored} errored, ${lastRun.written.length} written`
      : "Last gate run:   never",
    ...formatLastRejection(lastRun),
    "",
    `Config:          gate model "${config.gateModel}" (threshold ${config.gateThreshold}/10), distill model ${config.distillModel}, session-start notice ${config.sessionStartNotice ? "on" : "off"}`,
  ];
  if (queue.pending > 0) {
    lines.push("", `Run /handbook:review to review the ${queue.pending} pending candidate(s).`);
  }
  return lines.join("\n");
}
