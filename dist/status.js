// src/lib/status.ts
import { readFileSync as readFileSync4 } from "node:fs";

// src/lib/session-state.ts
import { homedir } from "node:os";
import { join } from "node:path";
var EDIT_ATTACH_WINDOW_MS = 15 * 60 * 1e3;
function handbookHome() {
  return process.env.TEAMHANDBOOK_HOME ?? join(homedir(), ".teamhandbook");
}

// src/lib/signals.ts
import { join as join3 } from "node:path";

// src/lib/counters.ts
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join as join2 } from "node:path";
var FIELDS = [
  "redactionBlocked",
  "postToolUse",
  "bashFailuresCaptured",
  "pairsResolved"
];
function countersFile(home = handbookHome()) {
  return join2(home, "counters.json");
}
function readCounters(home = handbookHome()) {
  const base = { redactionBlocked: 0, postToolUse: 0, bashFailuresCaptured: 0, pairsResolved: 0 };
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
import { readdirSync as readdirSync2, readFileSync as readFileSync2, writeFileSync as writeFileSync2 } from "node:fs";
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
    (a, b) => a.createdAt.localeCompare(b.createdAt) || a.slug.localeCompare(b.slug)
  );
}

// src/lib/score.ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";

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

// src/lib/distill.ts
var defaultDistillConfig = {
  model: "",
  timeoutMs: 12e4
};
function loadDistillConfig(home = handbookHome()) {
  const distill = readConfigFile(home).distill;
  return {
    model: typeof distill?.model === "string" ? distill.model : defaultDistillConfig.model,
    timeoutMs: typeof distill?.timeoutMs === "number" && distill.timeoutMs > 0 ? distill.timeoutMs : defaultDistillConfig.timeoutMs
  };
}

// src/lib/notify.ts
function loadNotifyConfig(home = handbookHome()) {
  const notify = readConfigFile(home).notify;
  return { sessionStart: notify?.sessionStart !== false };
}

// src/lib/pipeline.ts
import { basename as basename2, join as join7 } from "node:path";
function pipelineLogFile(home = handbookHome()) {
  return join7(home, "pipeline.log");
}

// src/lib/status.ts
function ledgerStats(home = handbookHome()) {
  const stats = { total: 0, candidates: 0, weak: 0, distinctFingerprints: 0 };
  let raw;
  try {
    raw = readFileSync4(signalsFile(home), "utf8");
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
    raw = readFileSync4(pipelineLogFile(home), "utf8");
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
function gatherStatus(home = handbookHome()) {
  const candidates = listCandidates(home);
  const count = (status) => candidates.filter((c) => c.status === status).length;
  const score = loadScoreConfig(home);
  const distill = loadDistillConfig(home);
  const counters = readCounters(home);
  return {
    home,
    ledger: ledgerStats(home),
    queue: {
      pending: count("pending"),
      approved: count("approved"),
      rejected: count("rejected")
    },
    redactionBlocked: counters.redactionBlocked,
    detector: {
      postToolUse: counters.postToolUse,
      bashFailuresCaptured: counters.bashFailuresCaptured,
      pairsResolved: counters.pairsResolved
    },
    lastRun: lastPipelineRun(home),
    config: {
      gateModel: score.model,
      gateThreshold: score.threshold,
      distillModel: distill.model || "(default)",
      sessionStartNotice: loadNotifyConfig(home).sessionStart
    }
  };
}
function formatStatus(report) {
  const { ledger, queue, lastRun, config } = report;
  const lines = [
    `TeamHandbook status  (${report.home})`,
    "",
    `Detector:        ${report.detector.postToolUse} tool calls seen, ${report.detector.bashFailuresCaptured} failures captured, ${report.detector.pairsResolved} pairs resolved`,
    `Signal ledger:   ${ledger.total} signals (${ledger.candidates} candidate, ${ledger.weak} weak), ${ledger.distinctFingerprints} distinct fingerprints`,
    `Candidate queue: ${queue.pending} pending, ${queue.approved} approved, ${queue.rejected} rejected`,
    `Secret vetoes:   ${report.redactionBlocked} candidate(s) dropped by the secret scan`,
    lastRun ? `Last gate run:   ${lastRun.ts}${lastRun.trigger === "manual" ? " (manual)" : ""} \u2014 ${lastRun.received} received, ${lastRun.sievedOut} sieved out, ${lastRun.rejected} rejected, ${lastRun.errored} errored, ${lastRun.written.length} written` : "Last gate run:   never",
    "",
    `Config:          gate model "${config.gateModel}" (threshold ${config.gateThreshold}/10), distill model ${config.distillModel}, session-start notice ${config.sessionStartNotice ? "on" : "off"}`
  ];
  if (queue.pending > 0) {
    lines.push("", `Run /handbook:review to review the ${queue.pending} pending candidate(s).`);
  }
  return lines.join("\n");
}

// src/cli/status.ts
console.log(formatStatus(gatherStatus()));
