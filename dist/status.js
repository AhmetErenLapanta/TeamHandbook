// src/lib/status.ts
import { readFileSync as readFileSync5 } from "node:fs";
import { dirname, join as join9 } from "node:path";
import { fileURLToPath } from "node:url";

// src/lib/session-state.ts
import { homedir } from "node:os";
import { join } from "node:path";
var EDIT_ATTACH_WINDOW_MS = 15 * 60 * 1e3;
function handbookHome() {
  return process.env.TEAMHANDBOOK_HOME ?? join(homedir(), ".teamhandbook");
}
var SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1e3;
var SESSION_ORPHAN_MS = 3 * 60 * 60 * 1e3;

// src/lib/signals.ts
import { join as join3 } from "node:path";

// src/lib/counters.ts
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join as join2 } from "node:path";
var FIELDS = [
  "redactionBlocked",
  "postToolUse",
  "bashFailuresCaptured",
  "pairsResolved",
  "gateErrors",
  "gateAbandoned"
];
function countersFile(home = handbookHome()) {
  return join2(home, "counters.json");
}
function readCounters(home = handbookHome()) {
  const base = {
    redactionBlocked: 0,
    postToolUse: 0,
    bashFailuresCaptured: 0,
    pairsResolved: 0,
    gateErrors: 0,
    gateAbandoned: 0
  };
  try {
    const parsed = JSON.parse(readFileSync(countersFile(home), "utf8"));
    for (const f of FIELDS) base[f] = Number(parsed?.[f]) || 0;
  } catch {
  }
  return base;
}

// src/lib/signals.ts
function signalsFile(home = handbookHome()) {
  return join3(home, "signals.jsonl");
}

// src/lib/queue.ts
import { readdirSync as readdirSync2, readFileSync as readFileSync2 } from "node:fs";
import { basename, join as join5 } from "node:path";

// src/lib/skill-index.ts
import { join as join4 } from "node:path";
function candidatesDir(home = handbookHome()) {
  return join4(home, "candidates");
}
function parseSkillFrontmatter(md) {
  const match = md.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;
  const fields = /* @__PURE__ */ new Map();
  for (const line of match[1].split("\n")) {
    const kv = line.match(/^([A-Za-z-]+):\s*(.*)$/);
    if (!kv) continue;
    let value = kv[2].trim();
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
      value = value.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
    }
    fields.set(kv[1], value);
  }
  const name = fields.get("name");
  const description = fields.get("description");
  if (!name || !description) return null;
  const scope = fields.get("scope");
  return { name, description, ...scope ? { scope } : {} };
}

// src/lib/queue.ts
var STATUSES = ["pending", "approved", "rejected"];
function candidateMetaFile(dir) {
  return join5(dir, "candidate.json");
}
function synthesizeMeta(dir) {
  let md;
  try {
    md = readFileSync2(join5(dir, "SKILL.md"), "utf8");
  } catch {
    return null;
  }
  const summary = parseSkillFrontmatter(md);
  if (!summary) return null;
  let grounded = {};
  try {
    grounded = JSON.parse(readFileSync2(join5(dir, "grounded-case.json"), "utf8"));
  } catch {
  }
  const gate = grounded.gate;
  return {
    slug: basename(dir),
    status: "pending",
    createdAt: typeof grounded.capturedAt === "string" ? grounded.capturedAt : "",
    scope: summary.scope ?? "team",
    description: summary.description,
    fingerprint: typeof grounded.fingerprint === "string" ? grounded.fingerprint : "",
    sessionId: "",
    gate: gate && typeof gate.total === "number" ? gate : null
  };
}
function readCandidateMeta(dir) {
  try {
    const parsed = JSON.parse(readFileSync2(candidateMetaFile(dir), "utf8"));
    if (typeof parsed === "object" && parsed !== null && STATUSES.includes(parsed.status) && typeof parsed.description === "string" && typeof parsed.scope === "string") {
      return { ...parsed, slug: basename(dir) };
    }
  } catch {
  }
  return synthesizeMeta(dir);
}
function listCandidates(home = handbookHome(), status) {
  const base = candidatesDir(home);
  let entries;
  try {
    entries = readdirSync2(base, { withFileTypes: true });
  } catch {
    return [];
  }
  const metas = entries.filter((e) => e.isDirectory()).map((e) => readCandidateMeta(join5(base, e.name))).filter((m) => m !== null);
  const filtered = status ? metas.filter((m) => m.status === status) : metas;
  return filtered.sort(
    (a, b) => b.createdAt.localeCompare(a.createdAt) || a.slug.localeCompare(b.slug)
  );
}

// src/lib/notify.ts
import { existsSync, readFileSync as readFileSync4, readdirSync as readdirSync3 } from "node:fs";
import { join as join7 } from "node:path";

// src/lib/config.ts
import { readFileSync as readFileSync3 } from "node:fs";
import { join as join6 } from "node:path";
function readConfigFile(home = handbookHome()) {
  try {
    const parsed = JSON.parse(readFileSync3(join6(home, "config.json"), "utf8"));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

// src/lib/score.ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";
var execFileAsync = promisify(execFile);
var defaultScoreConfig = {
  model: "haiku",
  threshold: 7,
  timeoutMs: 6e4
};
function loadScoreConfig(home = handbookHome()) {
  const gate = readConfigFile(home).gate;
  return {
    model: typeof gate?.model === "string" ? gate.model : defaultScoreConfig.model,
    threshold: typeof gate?.threshold === "number" && gate.threshold >= 0 && gate.threshold <= 10 ? gate.threshold : defaultScoreConfig.threshold,
    timeoutMs: typeof gate?.timeoutMs === "number" && gate.timeoutMs > 0 ? gate.timeoutMs : defaultScoreConfig.timeoutMs
  };
}

// src/lib/init.ts
var CONSUMER_NOTICE_HOOKS = JSON.stringify(
  {
    hooks: {
      SessionStart: [
        { hooks: [{ type: "command", command: 'node "${CLAUDE_PLUGIN_ROOT}/hooks/notice.mjs"' }] }
      ]
    }
  },
  null,
  2
);

// src/lib/notify.ts
function loadNotifyConfig(home = handbookHome()) {
  const notify = readConfigFile(home).notify;
  return {
    sessionStart: notify?.sessionStart !== false,
    heartbeat: notify?.heartbeat !== false
  };
}
var DIGEST_INTERVAL_MS = 7 * 24 * 60 * 60 * 1e3;
function pendingHarvestCount(home = handbookHome()) {
  let entries;
  try {
    entries = readdirSync3(join7(home, "pending"));
  } catch {
    return 0;
  }
  let total = 0;
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    try {
      const parsed = JSON.parse(readFileSync4(join7(home, "pending", entry), "utf8"));
      if (parsed && typeof parsed === "object" && typeof parsed.sessionId === "string") total += 1;
    } catch {
    }
  }
  return total;
}

// src/lib/harvest.ts
var defaultHarvestConfig = {
  enabled: true,
  model: "haiku",
  maxPerSession: 3,
  minScore: 4,
  transcriptCharCap: 4e4,
  timeoutMs: 12e4
};
function loadHarvestConfig(home = handbookHome()) {
  const harvest = readConfigFile(home).harvest;
  const num = (v, fallback) => typeof v === "number" && v > 0 ? v : fallback;
  return {
    enabled: harvest?.enabled !== false,
    model: typeof harvest?.model === "string" ? harvest.model : defaultHarvestConfig.model,
    maxPerSession: num(harvest?.maxPerSession, defaultHarvestConfig.maxPerSession),
    minScore: typeof harvest?.minScore === "number" && harvest.minScore >= 0 && harvest.minScore <= 10 ? harvest.minScore : defaultHarvestConfig.minScore,
    transcriptCharCap: num(harvest?.transcriptCharCap, defaultHarvestConfig.transcriptCharCap),
    timeoutMs: num(harvest?.timeoutMs, defaultHarvestConfig.timeoutMs)
  };
}

// src/lib/pipeline.ts
import { basename as basename2, join as join8 } from "node:path";
var STALE_CLAIM_MS = 10 * 60 * 1e3;
function pipelineLogFile(home = handbookHome()) {
  return join8(home, "pipeline.log");
}
var LOG_ROTATE_BYTES = 512 * 1024;

// src/lib/status.ts
function pluginVersion() {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const up of ["..", "../.."]) {
    try {
      const parsed = JSON.parse(
        readFileSync5(join9(here, up, ".claude-plugin", "plugin.json"), "utf8")
      );
      if (typeof parsed?.version === "string") return parsed.version;
    } catch {
    }
  }
  return "unknown";
}
function ledgerStats(home = handbookHome()) {
  const stats = { total: 0, candidates: 0, weak: 0, distinctFingerprints: 0 };
  let raw;
  try {
    raw = readFileSync5(signalsFile(home), "utf8");
  } catch {
    return stats;
  }
  const fingerprints = /* @__PURE__ */ new Set();
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let parsed;
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
function lastPipelineRun(home = handbookHome()) {
  let raw;
  try {
    raw = readFileSync5(pipelineLogFile(home), "utf8");
  } catch {
    return null;
  }
  const lines = raw.split("\n").filter((l) => l.trim());
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const parsed = JSON.parse(lines[i]);
      if (typeof parsed?.ts === "string") return parsed;
    } catch {
    }
  }
  return null;
}
function pipelineAggregate(home = handbookHome()) {
  const agg = { runs: 0, written: 0, rejected: 0, errored: 0, sievedOut: 0 };
  let raw;
  try {
    raw = readFileSync5(pipelineLogFile(home), "utf8");
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
    }
  }
  return agg;
}
function gatherStatus(home = handbookHome()) {
  const candidates = listCandidates(home);
  const count = (status) => candidates.filter((c) => c.status === status).length;
  const score = loadScoreConfig(home);
  const harvest = loadHarvestConfig(home);
  const counters = readCounters(home);
  const approved = candidates.filter((c) => c.status === "approved");
  const teamShared = approved.filter((c) => c.deliveredMode === "team").length;
  return {
    home,
    version: pluginVersion(),
    ledger: ledgerStats(home),
    queue: {
      pending: count("pending"),
      approved: count("approved"),
      rejected: count("rejected")
    },
    redactionBlocked: counters.redactionBlocked,
    sinceInstall: {
      approved: approved.length,
      teamShared,
      pairsCaptured: counters.pairsResolved,
      secretsBlocked: counters.redactionBlocked
    },
    detector: {
      postToolUse: counters.postToolUse,
      bashFailuresCaptured: counters.bashFailuresCaptured,
      pairsResolved: counters.pairsResolved
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
      sessionStartNotice: loadNotifyConfig(home).sessionStart
    }
  };
}
function formatLastRejection(lastRun) {
  const reject = lastRun?.outcomes?.filter((o) => o.outcome === "reject").at(-1);
  if (!reject) return [];
  const score = reject.total !== void 0 ? `${reject.total}/10` : "n/a";
  const why = reject.duplicateOf ? `duplicate of "${reject.duplicateOf}"` : reject.rationale ?? "no rationale recorded";
  return [`Last rejection:  ${score} \u2014 ${why}`];
}
function formatLastError(lastRun) {
  const errored = lastRun?.outcomes?.filter((o) => o.outcome === "error").at(-1);
  if (!errored) return [];
  return [`Last error:      ${errored.error ?? "(no reason recorded)"} \u2014 run /handbook:doctor`];
}
function formatStatus(report) {
  const { ledger, queue, lastRun, config } = report;
  const lines = [
    `TeamHandbook status  (v${report.version}, ${report.home})`,
    "",
    `Detector:        ${report.detector.postToolUse} tool calls seen, ${report.detector.bashFailuresCaptured} failures captured, ${report.detector.pairsResolved} pairs resolved`,
    `Signal ledger:   ${ledger.total} signals (${ledger.candidates} candidate, ${ledger.weak} weak), ${ledger.distinctFingerprints} distinct fingerprints`,
    `Candidate queue: ${queue.pending} pending, ${queue.approved} approved, ${queue.rejected} rejected`,
    `Secret vetoes:   ${report.redactionBlocked} candidate(s) dropped by the secret scan`,
    `Since install:   ${report.sinceInstall.approved} skill${report.sinceInstall.approved === 1 ? "" : "s"} approved${report.sinceInstall.teamShared > 0 ? ` (${report.sinceInstall.teamShared} shared with the team)` : ""}, ${report.sinceInstall.pairsCaptured} error\u2192fix pair${report.sinceInstall.pairsCaptured === 1 ? "" : "s"} captured, ${report.sinceInstall.secretsBlocked} secret${report.sinceInstall.secretsBlocked === 1 ? "" : "s"} blocked`,
    lastRun ? `Last harvest:    ${lastRun.ts}${lastRun.trigger === "manual" ? " (manual)" : ""} \u2014 ${lastRun.received} received, ${lastRun.sievedOut} sieved out, ${lastRun.rejected} rejected, ${lastRun.errored} errored, ${lastRun.written.length} written` : "Last harvest:    never",
    ...formatLastRejection(lastRun),
    ...formatLastError(lastRun),
    `Harvest runs:    ${report.pipeline.runs} run(s) in log \u2014 ${report.pipeline.written} written, ${report.pipeline.rejected} rejected, ${report.pipeline.errored} errored, ${report.pipeline.sievedOut} sieved out`,
    ...report.abandoned > 0 ? [`Abandoned:       ${report.abandoned} session harvest(s) given up after repeated failures (kept in abandoned.jsonl) \u2014 run /handbook:doctor`] : [],
    ...report.scoringNow > 0 ? [`Harvesting now:  ${report.scoringNow} session(s) queued for the background harvest`] : [],
    "",
    config.harvestEnabled ? `Config:          harvest model "${config.harvestModel}" (floor ${config.harvestFloor}/10, max ${config.harvestMax}/session), learn threshold ${config.learnThreshold}/10, session-start notice ${config.sessionStartNotice ? "on" : "off"}` : `Config:          harvest DISABLED (sessions are never read or sent); learn threshold ${config.learnThreshold}/10, session-start notice ${config.sessionStartNotice ? "on" : "off"}`
  ];
  if (queue.pending > 0) {
    lines.push("", `Run /handbook:review to review the ${queue.pending} pending candidate(s).`);
  } else if (report.sinceInstall.approved === 0) {
    lines.push(
      "",
      "No skills yet \u2014 normal early on: TeamHandbook harvests a session after it ends, so finish a real session and check back. /handbook:learn captures something right now; /handbook:doctor confirms TeamHandbook can reach your claude CLI."
    );
  }
  return lines.join("\n");
}

// src/cli/status.ts
console.log(formatStatus(gatherStatus()));
