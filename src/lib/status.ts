import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { handbookHome } from "./session-state.js";
import { signalsFile } from "./signals.js";
import { readCounters } from "./counters.js";
import { listCandidates } from "./queue.js";
import { pendingHarvestCount } from "./notify.js";
import { loadScoreConfig } from "./score.js";
import { loadHarvestConfig } from "./harvest.js";
import { loadNotifyConfig } from "./notify.js";
import { pipelineLogFile } from "./pipeline.js";
import type { PipelineSummary } from "./pipeline.js";

/**
 * The installed plugin's version, for support/bug reports. The bundle runs from
 * <plugin-root>/dist and the source tests from <root>/src/lib, so walk up a
 * couple of levels looking for .claude-plugin/plugin.json.
 */
export function pluginVersion(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const up of ["..", "../.."]) {
    try {
      const parsed = JSON.parse(
        readFileSync(join(here, up, ".claude-plugin", "plugin.json"), "utf8"),
      );
      if (typeof parsed?.version === "string") return parsed.version;
    } catch {
      // keep walking
    }
  }
  return "unknown";
}

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

export interface PipelineAggregate {
  runs: number;
  written: number;
  rejected: number;
  errored: number;
  sievedOut: number;
}

export function pipelineAggregate(home: string = handbookHome()): PipelineAggregate {
  const agg: PipelineAggregate = { runs: 0, written: 0, rejected: 0, errored: 0, sievedOut: 0 };
  let raw: string;
  try {
    raw = readFileSync(pipelineLogFile(home), "utf8");
  } catch {
    return agg;
  }
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const p = JSON.parse(line);
      agg.runs += 1;
      agg.written += Array.isArray(p.written) ? p.written.length : 0;
      agg.rejected += Number(p.rejected) || 0;
      agg.errored += Number(p.errored) || 0;
      agg.sievedOut += Number(p.sievedOut) || 0;
    } catch {
      // skip malformed lines
    }
  }
  return agg;
}

export interface StatusReport {
  home: string;
  version: string;
  ledger: LedgerStats;
  queue: { pending: number; approved: number; rejected: number };
  redactionBlocked: number;
  // cumulative value scoreboard — the user's ready-made "was it worth it" line
  sinceInstall: { approved: number; teamShared: number; pairsCaptured: number; secretsBlocked: number };
  detector: { postToolUse: number; bashFailuresCaptured: number; pairsResolved: number };
  lastRun: (PipelineSummary & { ts: string }) | null;
  pipeline: PipelineAggregate;
  scoringNow: number;
  // captured pairs given up on after repeated gate failures — never silent
  abandoned: number;
  config: {
    harvestModel: string;
    harvestEnabled: boolean;
    harvestFloor: number;
    harvestMax: number;
    learnThreshold: number;
    sessionStartNotice: boolean;
  };
}

export function gatherStatus(home: string = handbookHome()): StatusReport {
  const candidates = listCandidates(home);
  const count = (status: string) => candidates.filter((c) => c.status === status).length;
  const score = loadScoreConfig(home);
  const harvest = loadHarvestConfig(home);
  const counters = readCounters(home);
  const approved = candidates.filter((c) => c.status === "approved");
  // delivery mode is persisted at approval time — inferring it from the
  // deliveredTo string misclassifies local-path team repos and Windows paths
  const teamShared = approved.filter((c) => c.deliveredMode === "team").length;
  return {
    home,
    version: pluginVersion(),
    ledger: ledgerStats(home),
    queue: {
      pending: count("pending"),
      approved: count("approved"),
      rejected: count("rejected"),
    },
    redactionBlocked: counters.redactionBlocked,
    sinceInstall: {
      approved: approved.length,
      teamShared,
      pairsCaptured: counters.pairsResolved,
      secretsBlocked: counters.redactionBlocked,
    },
    detector: {
      postToolUse: counters.postToolUse,
      bashFailuresCaptured: counters.bashFailuresCaptured,
      pairsResolved: counters.pairsResolved,
    },
    lastRun: lastPipelineRun(home),
    pipeline: pipelineAggregate(home),
    scoringNow: pendingHarvestCount(home),
    abandoned: counters.gateAbandoned,
    config: {
      harvestModel: harvest.model,
      harvestEnabled: harvest.enabled,
      harvestFloor: harvest.minScore,
      harvestMax: harvest.maxPerSession,
      learnThreshold: score.threshold,
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

function formatLastError(lastRun: (PipelineSummary & { ts: string }) | null): string[] {
  const errored = lastRun?.outcomes?.filter((o) => o.outcome === "error").at(-1);
  if (!errored) return [];
  return [`Last error:      ${errored.error ?? "(no reason recorded)"} — run /handbook:doctor`];
}

export function formatStatus(report: StatusReport): string {
  const { ledger, queue, lastRun, config } = report;
  const lines = [
    `TeamHandbook status  (v${report.version}, ${report.home})`,
    "",
    `Detector:        ${report.detector.postToolUse} tool calls seen, ${report.detector.bashFailuresCaptured} failures captured, ${report.detector.pairsResolved} pairs resolved`,
    `Signal ledger:   ${ledger.total} signals (${ledger.candidates} candidate, ${ledger.weak} weak), ${ledger.distinctFingerprints} distinct fingerprints`,
    `Candidate queue: ${queue.pending} pending, ${queue.approved} approved, ${queue.rejected} rejected`,
    `Secret vetoes:   ${report.redactionBlocked} candidate(s) dropped by the secret scan`,
    `Since install:   ${report.sinceInstall.approved} skill${report.sinceInstall.approved === 1 ? "" : "s"} approved${report.sinceInstall.teamShared > 0 ? ` (${report.sinceInstall.teamShared} shared with the team)` : ""}, ${report.sinceInstall.pairsCaptured} error→fix pair${report.sinceInstall.pairsCaptured === 1 ? "" : "s"} captured, ${report.sinceInstall.secretsBlocked} secret${report.sinceInstall.secretsBlocked === 1 ? "" : "s"} blocked`,
    lastRun
      ? `Last harvest:    ${lastRun.ts}${lastRun.trigger === "manual" ? " (manual)" : ""} — ${lastRun.received} received, ${lastRun.sievedOut} sieved out, ${lastRun.rejected} rejected, ${lastRun.errored} errored, ${lastRun.written.length} written`
      : "Last harvest:    never",
    ...formatLastRejection(lastRun),
    ...formatLastError(lastRun),
    `Harvest runs:    ${report.pipeline.runs} run(s) in log — ${report.pipeline.written} written, ${report.pipeline.rejected} rejected, ${report.pipeline.errored} errored, ${report.pipeline.sievedOut} sieved out`,
    ...(report.abandoned > 0 ? [`Abandoned:       ${report.abandoned} session harvest(s) given up after repeated failures (kept in abandoned.jsonl) — run /handbook:doctor`] : []),
    ...(report.scoringNow > 0 ? [`Harvesting now:  ${report.scoringNow} session(s) queued for the background harvest`] : []),
    "",
    config.harvestEnabled
      ? `Config:          harvest model "${config.harvestModel}" (floor ${config.harvestFloor}/10, max ${config.harvestMax}/session), learn threshold ${config.learnThreshold}/10, session-start notice ${config.sessionStartNotice ? "on" : "off"}`
      : `Config:          harvest DISABLED (sessions are never read or sent); learn threshold ${config.learnThreshold}/10, session-start notice ${config.sessionStartNotice ? "on" : "off"}`,
  ];
  if (queue.pending > 0) {
    lines.push("", `Run /handbook:review to review the ${queue.pending} pending candidate(s).`);
  } else if (report.sinceInstall.approved === 0) {
    // Nothing approved yet and nothing waiting: keep the getting-started guidance
    // reachable even if the one-time welcome scrolled past unseen.
    lines.push(
      "",
      "No skills yet — normal early on: TeamHandbook harvests a session after it ends, so finish a real " +
        "session and check back. /handbook:learn captures something right now; /handbook:doctor confirms " +
        "TeamHandbook can reach your claude CLI.",
    );
  }
  return lines.join("\n");
}
