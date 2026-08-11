// src/hooks/session-start.ts
import { fileURLToPath } from "node:url";

// src/lib/hook-io.ts
async function readStdin(stream = process.stdin) {
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}
function parseHookInput(raw) {
  if (!raw.trim()) return null;
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

// src/lib/notify.ts
import { existsSync as existsSync2, readFileSync as readFileSync7, readdirSync as readdirSync5 } from "node:fs";

// src/lib/fs-atomic.ts
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
var seq = 0;
function writeFileAtomic(file, data) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${seq++}-${process.hrtime.bigint().toString(36)}`;
  try {
    writeFileSync(tmp, data);
    renameSync(tmp, file);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

// src/lib/notify.ts
import { join as join8 } from "node:path";

// src/lib/session-state.ts
import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync, readdirSync, rmSync as rmSync2, statSync } from "node:fs";
var EDIT_ATTACH_WINDOW_MS = 15 * 60 * 1e3;
function emptySessionState(sessionId) {
  return { sessionId, openErrors: [], resolvedPairs: [] };
}
function handbookHome() {
  return process.env.TEAMHANDBOOK_HOME ?? join(homedir(), ".teamhandbook");
}
function sessionFile(sessionId, home) {
  const safe = sessionId.replace(/[^A-Za-z0-9_-]/g, "_");
  return join(home, "sessions", `${safe}.json`);
}
function loadSessionState(sessionId, home = handbookHome()) {
  try {
    const raw = readFileSync(sessionFile(sessionId, home), "utf8");
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || !Array.isArray(parsed.openErrors)) {
      return emptySessionState(sessionId);
    }
    const activity = typeof parsed.activity === "object" && parsed.activity !== null && Array.isArray(parsed.activity.families) && Array.isArray(parsed.activity.exts) ? { families: parsed.activity.families, exts: parsed.activity.exts } : void 0;
    return {
      sessionId,
      openErrors: parsed.openErrors.map((e) => ({ ...e, edits: e.edits ?? [] })),
      resolvedPairs: Array.isArray(parsed.resolvedPairs) ? parsed.resolvedPairs : [],
      ...activity ? { activity } : {},
      ...typeof parsed.transcriptPath === "string" ? { transcriptPath: parsed.transcriptPath } : {},
      ...typeof parsed.meaningfulToolCalls === "number" ? { meaningfulToolCalls: parsed.meaningfulToolCalls } : {},
      ...typeof parsed.harvestedAt === "string" ? { harvestedAt: parsed.harvestedAt } : {},
      ...Array.isArray(parsed.corrections) ? { corrections: parsed.corrections } : {}
    };
  } catch {
    return emptySessionState(sessionId);
  }
}
function saveSessionState(state, home = handbookHome()) {
  writeFileAtomic(sessionFile(state.sessionId, home), JSON.stringify(state, null, 2));
}
var SUBSTANCE_MIN_TOOL_CALLS = 5;
function sessionHasSubstance(state) {
  if (state.resolvedPairs.length > 0) return true;
  if ((state.corrections?.length ?? 0) > 0) return true;
  const activity = state.activity;
  if (activity && activity.families.length > 0 && activity.exts.length > 0) return true;
  return (state.meaningfulToolCalls ?? 0) >= SUBSTANCE_MIN_TOOL_CALLS;
}
var SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1e3;
var SESSION_ORPHAN_MS = 3 * 60 * 60 * 1e3;
function orphanedSessionIds(home = handbookHome(), now = Date.now()) {
  const dir = join(home, "sessions");
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const ids = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    try {
      if (now - statSync(join(dir, entry)).mtimeMs > SESSION_ORPHAN_MS) {
        ids.push(entry.replace(/\.json$/, ""));
      }
    } catch {
    }
  }
  return ids;
}
function cleanupStaleSessionFiles(home = handbookHome(), now = Date.now()) {
  const dir = join(home, "sessions");
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const entry of entries) {
    try {
      const file = join(dir, entry);
      if (now - statSync(file).mtimeMs > SESSION_MAX_AGE_MS) {
        rmSync2(file, { force: true });
        removed += 1;
      }
    } catch {
    }
  }
  return removed;
}

// src/lib/config.ts
import { existsSync, readFileSync as readFileSync2 } from "node:fs";
import { join as join2 } from "node:path";
function configFile(home = handbookHome()) {
  return join2(home, "config.json");
}
function readConfigFile(home = handbookHome()) {
  try {
    const parsed = JSON.parse(readFileSync2(configFile(home), "utf8"));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}
function configIsBroken(home = handbookHome()) {
  const file = configFile(home);
  if (!existsSync(file)) return false;
  try {
    const parsed = JSON.parse(readFileSync2(file, "utf8"));
    return !(typeof parsed === "object" && parsed !== null && !Array.isArray(parsed));
  } catch {
    return true;
  }
}

// src/lib/counters.ts
import { mkdirSync as mkdirSync2, readdirSync as readdirSync2, readFileSync as readFileSync3, writeFileSync as writeFileSync2 } from "node:fs";
import { join as join3 } from "node:path";
var FIELDS = [
  "redactionBlocked",
  "postToolUse",
  "bashFailuresCaptured",
  "pairsResolved",
  "gateErrors",
  "gateAbandoned"
];
function countersFile(home = handbookHome()) {
  return join3(home, "counters.json");
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
    const parsed = JSON.parse(readFileSync3(countersFile(home), "utf8"));
    for (const f of FIELDS) base[f] = Number(parsed?.[f]) || 0;
  } catch {
  }
  return base;
}
function bumpCounter(field, home = handbookHome(), by = 1) {
  const counters = readCounters(home);
  counters[field] += by;
  mkdirSync2(home, { recursive: true });
  writeFileAtomic(countersFile(home), JSON.stringify(counters, null, 2));
  return counters;
}
function incrementRedactionBlocked(home = handbookHome(), by = 1) {
  return bumpCounter("redactionBlocked", home, by);
}

// src/lib/init.ts
import { homedir as homedir2, tmpdir } from "node:os";
import { dirname as dirname2, join as join5 } from "node:path";

// src/lib/score.ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";
var execFileAsync = promisify(execFile);
function gateAutoEnabled(home = handbookHome()) {
  if (configIsBroken(home)) return false;
  const gate = readConfigFile(home).gate;
  return gate?.auto !== false;
}

// src/lib/skill-index.ts
import { readdirSync as readdirSync3, readFileSync as readFileSync4 } from "node:fs";
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
function isDecidedCandidate(dir, entry) {
  try {
    const meta = JSON.parse(readFileSync4(join4(dir, entry, "candidate.json"), "utf8"));
    return meta?.status === "rejected" || meta?.status === "approved";
  } catch {
    return false;
  }
}
function listExistingSkills(dirs) {
  const byName = /* @__PURE__ */ new Map();
  for (const dir of dirs) {
    let entries;
    try {
      entries = readdirSync3(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (isDecidedCandidate(dir, entry)) continue;
      let raw;
      try {
        raw = readFileSync4(join4(dir, entry, "SKILL.md"), "utf8");
      } catch {
        continue;
      }
      const summary = parseSkillFrontmatter(raw);
      if (summary && !byName.has(summary.name)) byName.set(summary.name, summary);
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

// src/lib/secrets.ts
var SECRET_PATTERNS = [
  // Covers PEM, armored PGP ("… BLOCK-----") and ssh.com/SSH2 ("---- BEGIN SSH2
  // ENCRYPTED PRIVATE KEY ----": four dashes with spaces).
  // Deliberately NOT the generic /-----BEGIN [A-Z ]+-----/: that swallows
  // -----BEGIN CERTIFICATE-----, which is public and routine in TLS work.
  { name: "private-key", re: /-{4,5}\s?BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?\s?-{4,5}/ },
  // PuTTY .ppk keys are not PEM-armored at all
  { name: "putty-key", re: /^\s*(?:PuTTY-User-Key-File-\d|Private-Lines:|Private-MAC:)/m },
  { name: "age-key", re: /\bAGE-SECRET-KEY-1[0-9A-Z]{50,}/ },
  { name: "aws-access-key", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { name: "jwt", re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/ },
  { name: "github-token", re: /\b(?:gh[pousr]|github_pat)_[A-Za-z0-9_]{20,}\b/ },
  { name: "gitlab-token", re: /\bglpat-[A-Za-z0-9_-]{20,}\b/ },
  { name: "slack-token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { name: "slack-webhook", re: /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/]{20,}/ },
  { name: "stripe-key", re: /\bsk_(?:live|test)_[A-Za-z0-9]{16,}\b/ },
  { name: "openai-key", re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/ },
  { name: "google-api-key", re: /\bAIza[A-Za-z0-9_-]{30,}\b/ },
  { name: "npm-token", re: /\bnpm_[A-Za-z0-9]{30,}\b/ },
  { name: "bearer-token", re: /\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*/i },
  { name: "basic-auth-header", re: /\bAuthorization\s*:\s*Basic\s+[A-Za-z0-9+/]{16,}=*/i },
  { name: "url-credentials", re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:[^\s@/]{3,}@/i },
  // common credential shapes the generic keyword rule misses
  { name: "db-password-env", re: /(?:\b|_)(?:PGPASSWORD|MYSQL_PWD|DB_PASS(?:WORD)?|POSTGRES_PASSWORD|REDIS_PASSWORD)\s*=\s*\S+/i },
  { name: "inline-basic-auth", re: /\bcurl\b[^\n]*\s-{1,2}(?:u|user)\s+[^\s:]+:[^\s]+/i },
  { name: "mysql-inline-password", re: /\bmysql\b[^\n]*\s-p\S+/i },
  {
    // keyword may be preceded by a word boundary OR an underscore (AWS_SECRET_KEY=...),
    // which \b cannot match between two word chars.
    name: "assigned-secret",
    re: /(?:\b|_)(?:api[_-]?key|secret|token|passw(?:or)?d|access[_-]?key)["']?\s*[=:]\s*["']?[A-Za-z0-9+/_.-]{8,}/i
  }
];
function detectSecret(text) {
  for (const { name, re } of SECRET_PATTERNS) {
    if (re.test(text)) return name;
  }
  return null;
}
function signalSecret(fields) {
  return detectSecret(
    [
      fields.command ?? "",
      fields.error ?? "",
      fields.resolvedCommand ?? "",
      ...fields.edits ?? [],
      fields.task?.goal ?? "",
      ...fields.task?.steps ?? [],
      fields.task?.verification ?? ""
    ].join("\n")
  );
}

// src/lib/init.ts
function loadTeamConfig(home = handbookHome()) {
  const team = readConfigFile(home).team;
  if (team && typeof team.repoUrl === "string" && typeof team.marketplaceName === "string") {
    return team;
  }
  return null;
}
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
function marketplacesRoot() {
  return join5(homedir2(), ".claude", "plugins", "marketplaces");
}
function teamSkillsDir(home = handbookHome(), root = marketplacesRoot()) {
  const team = loadTeamConfig(home);
  return team ? join5(root, team.marketplaceName, "skills") : null;
}

// src/lib/queue.ts
import { readdirSync as readdirSync4, readFileSync as readFileSync5 } from "node:fs";
import { basename, join as join6 } from "node:path";
var STATUSES = ["pending", "approved", "rejected"];
function candidateMetaFile(dir) {
  return join6(dir, "candidate.json");
}
function synthesizeMeta(dir) {
  let md;
  try {
    md = readFileSync5(join6(dir, "SKILL.md"), "utf8");
  } catch {
    return null;
  }
  const summary = parseSkillFrontmatter(md);
  if (!summary) return null;
  let grounded = {};
  try {
    grounded = JSON.parse(readFileSync5(join6(dir, "grounded-case.json"), "utf8"));
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
    const parsed = JSON.parse(readFileSync5(candidateMetaFile(dir), "utf8"));
    if (typeof parsed === "object" && parsed !== null && STATUSES.includes(parsed.status) && typeof parsed.description === "string" && typeof parsed.scope === "string") {
      return {
        ...parsed,
        slug: basename(dir),
        createdAt: typeof parsed.createdAt === "string" ? parsed.createdAt : ""
      };
    }
  } catch {
  }
  return synthesizeMeta(dir);
}
function listCandidates(home = handbookHome(), status) {
  const base = candidatesDir(home);
  let entries;
  try {
    entries = readdirSync4(base, { withFileTypes: true });
  } catch {
    return [];
  }
  const metas = entries.filter((e) => e.isDirectory()).map((e) => readCandidateMeta(join6(base, e.name))).filter((m) => m !== null);
  const filtered = status ? metas.filter((m) => m.status === status) : metas;
  return filtered.sort(
    (a, b) => b.createdAt.localeCompare(a.createdAt) || a.slug.localeCompare(b.slug)
  );
}

// src/lib/usage.ts
import { readFileSync as readFileSync6 } from "node:fs";
import { basename as basename2, join as join7 } from "node:path";
function usageFile(home = handbookHome()) {
  return join7(home, "skill-usage.json");
}
function readSkillUsage(home = handbookHome()) {
  try {
    const parsed = JSON.parse(readFileSync6(usageFile(home), "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const usage = {};
    for (const [slug, value] of Object.entries(parsed)) {
      const entry = value;
      if (typeof entry?.count === "number" && typeof entry?.lastAt === "string") {
        usage[slug] = { count: entry.count, lastAt: entry.lastAt };
      }
    }
    return usage;
  } catch {
    return {};
  }
}
function handbookSkills(home = handbookHome()) {
  const delivered = listCandidates(home, "approved").filter((c) => c.deliveredMode === "personal" || c.deliveredMode === "solo").map((c) => c.deliveredTo ? basename2(c.deliveredTo) : c.slug);
  const teamDir = teamSkillsDir(home);
  const fromTeam = teamDir ? listExistingSkills([teamDir]).map((s) => s.name) : [];
  return [.../* @__PURE__ */ new Set([...delivered, ...fromTeam])];
}
function summarizeUsage(usage, known) {
  const relevant = known.filter((slug) => usage[slug]);
  const totalUses = relevant.reduce((sum, slug) => sum + usage[slug].count, 0);
  const top = relevant.map((slug) => ({ slug, count: usage[slug].count })).sort((a, b) => b.count - a.count)[0];
  return { fired: relevant.length, totalUses, topSkill: top ?? null };
}

// src/lib/notify.ts
function loadNotifyConfig(home = handbookHome()) {
  const notify = readConfigFile(home).notify;
  return {
    sessionStart: notify?.sessionStart !== false,
    heartbeat: notify?.heartbeat !== false
  };
}
function welcomeMarkerFile(home) {
  return join8(home, "welcomed");
}
function isFirstRun(home = handbookHome()) {
  const marker = welcomeMarkerFile(home);
  if (existsSync2(marker)) return false;
  writeFileAtomic(marker, (/* @__PURE__ */ new Date()).toISOString() + "\n");
  return true;
}
function heartbeatSnapshotFile(home) {
  return join8(home, "notified-counters.json");
}
function heartbeatDelta(home = handbookHome()) {
  const current = readCounters(home);
  let prior = { bashFailuresCaptured: 0, pairsResolved: 0, gateErrors: 0 };
  try {
    const parsed = JSON.parse(readFileSync7(heartbeatSnapshotFile(home), "utf8"));
    prior = {
      bashFailuresCaptured: Number(parsed?.bashFailuresCaptured) || 0,
      pairsResolved: Number(parsed?.pairsResolved) || 0,
      gateErrors: Number(parsed?.gateErrors) || 0
    };
  } catch {
  }
  writeFileAtomic(
    heartbeatSnapshotFile(home),
    JSON.stringify(
      {
        bashFailuresCaptured: current.bashFailuresCaptured,
        pairsResolved: current.pairsResolved,
        gateErrors: current.gateErrors
      },
      null,
      2
    ) + "\n"
  );
  return {
    failures: Math.max(0, current.bashFailuresCaptured - prior.bashFailuresCaptured),
    pairs: Math.max(0, current.pairsResolved - prior.pairsResolved),
    gateErrors: Math.max(0, current.gateErrors - prior.gateErrors)
  };
}
var TEAM_NUDGE_APPROVALS = 3;
function teamNudgeMarkerFile(home) {
  return join8(home, "nudged-team");
}
function digestMarkerFile(home) {
  return join8(home, "last-digest");
}
var DIGEST_INTERVAL_MS = 7 * 24 * 60 * 60 * 1e3;
function weeklyDigest(home = handbookHome(), now = Date.now()) {
  const marker = digestMarkerFile(home);
  let since = 0;
  try {
    since = Date.parse(readFileSync7(marker, "utf8").trim());
  } catch {
    writeFileAtomic(marker, new Date(now).toISOString() + "\n");
    return null;
  }
  if (!Number.isFinite(since) || now - since < DIGEST_INTERVAL_MS) return null;
  writeFileAtomic(marker, new Date(now).toISOString() + "\n");
  const decided = listCandidates(home).filter(
    (c) => c.decidedAt && Date.parse(c.decidedAt) >= since
  );
  const kept = decided.filter(
    (c) => c.status === "approved" && (c.deliveredMode === "personal" || c.deliveredMode === "solo")
  ).length;
  const shared = decided.filter((c) => c.status === "approved" && c.deliveredMode === "team").length;
  const pending = listCandidates(home, "pending").length;
  if (kept + shared + pending === 0) return null;
  const parts = [];
  if (kept > 0) parts.push(`${kept} skill${kept === 1 ? "" : "s"} kept`);
  if (shared > 0) parts.push(`${shared} shared with the team`);
  if (pending > 0) parts.push(`${pending} waiting for your call`);
  const usage = summarizeUsage(readSkillUsage(home), handbookSkills(home));
  if (usage.totalUses > 0) {
    parts.push(
      `your skills fired ${usage.totalUses} time${usage.totalUses === 1 ? "" : "s"}` + (usage.topSkill ? ` (${usage.topSkill.slug} most of all)` : "")
    );
  }
  return `TeamHandbook \u2014 your week: ${parts.join(", ")}. Run /handbook:status for the full picture.`;
}
function pendingTeamNudge(home = handbookHome()) {
  if (loadTeamConfig(home)) return null;
  if (existsSync2(teamNudgeMarkerFile(home))) return null;
  const approved = listCandidates(home, "approved").length;
  if (approved < TEAM_NUDGE_APPROVALS) return null;
  writeFileAtomic(teamNudgeMarkerFile(home), (/* @__PURE__ */ new Date()).toISOString() + "\n");
  return `handbook: ${approved} approved skills live only on this machine \u2014 one /handbook:init shares them with your team (teammates get every future merge automatically).`;
}
function pendingHarvestCount(home = handbookHome()) {
  let entries;
  try {
    entries = readdirSync5(join8(home, "pending"));
  } catch {
    return 0;
  }
  let total = 0;
  for (const entry of entries) {
    if (!entry.includes(".json")) continue;
    try {
      const parsed = JSON.parse(readFileSync7(join8(home, "pending", entry), "utf8"));
      if (parsed && typeof parsed === "object" && typeof parsed.sessionId === "string") total += 1;
    } catch {
    }
  }
  return total;
}
function seenSkillsFile(home = handbookHome()) {
  return join8(home, "seen-skills.json");
}
function readSeenSkills(home) {
  try {
    const parsed = JSON.parse(readFileSync7(seenSkillsFile(home), "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    return parsed;
  } catch {
    return {};
  }
}
function diffNewSkills(dir, currentNames, home = handbookHome()) {
  const state = readSeenSkills(home);
  const prior = state[dir];
  state[dir] = [...currentNames].sort();
  writeFileAtomic(seenSkillsFile(home), JSON.stringify(state, null, 2) + "\n");
  if (!Array.isArray(prior)) return [];
  const priorSet = new Set(prior);
  return currentNames.filter((name) => !priorSet.has(name)).sort();
}
function buildSessionStartSummary(inputs) {
  const {
    pending,
    pendingPreviews = [],
    harvested = null,
    harvestedNothing = false,
    newSkills,
    firstRun = false,
    heartbeat = null,
    teamNudge = null,
    digest = null,
    scoring = 0
  } = inputs;
  const lines = [];
  if (inputs.configBroken) {
    lines.push(
      "handbook: ~/.teamhandbook/config.json could not be parsed \u2014 automatic harvesting is OFF until it is valid JSON (failing closed on purpose). Run /handbook:doctor."
    );
  }
  if (firstRun) {
    lines.push(
      'TeamHandbook is active \u2014 it learns from the corrections you give, the procedures you complete, and the traps you hit. After each session where you did real work, it reads that session (your prompts included, secrets redacted) through your OWN claude CLI and tells you at your next session start what it learned \u2014 you decide whether to keep it, put it in the repo, or share it with the team. Nothing installs or ships without your say-so. Turn the reading off entirely with ~/.teamhandbook/config.json \u2192 {"harvest": {"enabled": false}}. Want to see the whole loop in two minutes instead of waiting? Run /handbook:demo. And /handbook:doctor once confirms TeamHandbook can reach your claude CLI.'
    );
  }
  if (harvested) {
    const score = harvested.total !== null ? `, ${harvested.total}/10` : "";
    const more = harvested.more > 0 ? ` (+${harvested.more} more)` : "";
    const repeats = (harvested.taughtBefore ?? 0) + 1;
    const lead = repeats > 1 ? `TeamHandbook learned something you have now told Claude in ${repeats} sessions` : "TeamHandbook learned from your last session";
    lines.push(
      `${lead}: "${harvested.name}" (${harvested.kind}${score})${more} \u2014 keep it for yourself, share it with the team, or skip: run /handbook:review.`
    );
  }
  if (pending > 0) {
    const noun = pending === 1 ? "candidate skill is" : "candidate skills are";
    const preview = pendingPreviews.length > 0 ? ` (${pendingPreviews.join("; ")})` : "";
    const repeated = inputs.pendingRepeats ?? 0;
    const nag = repeated > 0 ? ` \u2014 you have told Claude one of these in ${repeated} sessions now, and it is still waiting: run /handbook:review.` : " \u2014 run /handbook:review to approve or reject.";
    lines.push(`handbook: ${pending} ${noun} awaiting your review${preview}${nag}`);
  }
  if (harvestedNothing && !harvested && pending === 0 && scoring === 0) {
    lines.push(
      "handbook: read your last session and found nothing worth keeping \u2014 that's a normal answer, not a failure. Run /handbook:learn if there was something it missed."
    );
  }
  if (scoring > 0 && pending === 0 && !harvested) {
    lines.push(
      `handbook: harvesting your last session${scoring === 1 ? "" : ` (${scoring} sessions)`} in the background \u2014 check /handbook:review shortly.`
    );
  }
  if (newSkills.length > 0) {
    const noun = newSkills.length === 1 ? "new skill" : "new skills";
    lines.push(
      `handbook: ${newSkills.length} ${noun} available since your last session here: ${newSkills.join(", ")}.`
    );
  }
  if (teamNudge) lines.push(teamNudge);
  if (digest) lines.push(digest);
  if (heartbeat && heartbeat.gateErrors > 0) {
    lines.push(
      `handbook: ${heartbeat.gateErrors} gate run${heartbeat.gateErrors === 1 ? "" : "s"} failed since your last session (claude may be logged out, missing, or rate-limited) \u2014 run /handbook:doctor.`
    );
  }
  if (!firstRun && lines.length === 0 && heartbeat && (heartbeat.failures > 0 || heartbeat.pairs > 0)) {
    const parts = [];
    if (heartbeat.failures > 0) {
      parts.push(`${heartbeat.failures} failure${heartbeat.failures === 1 ? "" : "s"} watched`);
    }
    if (heartbeat.pairs > 0) {
      parts.push(`${heartbeat.pairs} error\u2192fix pair${heartbeat.pairs === 1 ? "" : "s"} captured`);
    }
    lines.push(`handbook: since your last session \u2014 ${parts.join(", ")}.`);
  }
  return lines.length > 0 ? lines.join("\n") : null;
}
function lastHarvestFoundNothing(home) {
  let raw;
  try {
    raw = readFileSync7(join8(home, "pipeline.log"), "utf8");
  } catch {
    return false;
  }
  const lines = raw.split("\n").filter((l) => l.trim());
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const run = JSON.parse(lines[i]);
      if (!run?.harvest) continue;
      return !run.harvest.skipped && Array.isArray(run.written) && run.written.length === 0 && !run.errored;
    } catch {
    }
  }
  return false;
}
function sessionStartNotice(cwd, home = handbookHome(), marketplacesRootDir) {
  const config = loadNotifyConfig(home);
  if (!config.sessionStart) return null;
  const pendingCandidates = listCandidates(home, "pending");
  const harvestedPending = pendingCandidates.filter((c) => c.origin === "harvest");
  const rest = pendingCandidates.filter((c) => c.origin !== "harvest");
  const top = harvestedPending.sort(
    (a, b) => (b.taughtBefore ?? 0) - (a.taughtBefore ?? 0) || (b.gate?.total ?? -1) - (a.gate?.total ?? -1)
  )[0];
  const harvested = top ? {
    name: top.slug,
    kind: top.kind ?? "lesson",
    total: top.gate?.total ?? null,
    more: harvestedPending.length - 1,
    ...top.taughtBefore ? { taughtBefore: top.taughtBefore } : {}
  } : null;
  const pendingRepeats = Math.max(0, ...rest.map((c) => c.taughtBefore ? c.taughtBefore + 1 : 0));
  const pendingPreviews = rest.slice(0, 2).map((c) => `${c.slug} \u2014 ${c.description.slice(0, 60)}`);
  const watchedDirs = [join8(cwd, ".claude", "skills")];
  const teamDir = teamSkillsDir(home, marketplacesRootDir);
  if (teamDir) watchedDirs.push(teamDir);
  const newSkills = watchedDirs.flatMap((dir) => diffNewSkills(dir, listExistingSkills([dir]).map((s) => s.name), home)).sort();
  return buildSessionStartSummary({
    pending: rest.length,
    pendingPreviews,
    pendingRepeats,
    harvested,
    newSkills,
    firstRun: isFirstRun(home),
    heartbeat: config.heartbeat ? heartbeatDelta(home) : null,
    teamNudge: pendingTeamNudge(home),
    harvestedNothing: lastHarvestFoundNothing(home),
    digest: weeklyDigest(home),
    configBroken: configIsBroken(home),
    scoring: pendingHarvestCount(home)
  });
}

// src/lib/signals.ts
import { existsSync as existsSync3, appendFileSync, mkdirSync as mkdirSync3, readFileSync as readFileSync8 } from "node:fs";
import { join as join9 } from "node:path";
function sanitizeSignalsForPersistence(signals) {
  let redacted = 0;
  const clean = signals.map((s) => {
    if (s.secretRedacted || !signalSecret(s)) return s;
    redacted += 1;
    return {
      ts: s.ts,
      sessionId: s.sessionId,
      kind: "weak",
      fingerprint: s.fingerprint,
      family: "",
      command: "",
      error: "",
      cwd: "",
      count: s.count,
      edits: [],
      secretRedacted: true
    };
  });
  return { clean, redacted };
}
function signalsFile(home = handbookHome()) {
  return join9(home, "signals.jsonl");
}
function ledgerFingerprintCounts(home = handbookHome()) {
  const counts = /* @__PURE__ */ new Map();
  let raw;
  try {
    raw = readFileSync8(signalsFile(home), "utf8");
  } catch {
    return counts;
  }
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      if (typeof parsed?.fingerprint === "string") {
        counts.set(parsed.fingerprint, (counts.get(parsed.fingerprint) ?? 0) + 1);
      }
    } catch {
    }
  }
  return counts;
}
function appendSignals(signals, home = handbookHome()) {
  if (signals.length === 0) return;
  const { clean, redacted } = sanitizeSignalsForPersistence(signals);
  if (redacted > 0) incrementRedactionBlocked(home, redacted);
  mkdirSync3(home, { recursive: true });
  const lines = clean.map((s) => JSON.stringify(s)).join("\n") + "\n";
  appendFileSync(signalsFile(home), lines);
}
function signalFromPair(pair, sessionId, ts, fileExists = existsSync3) {
  const persistedEdits = pair.edits.filter(fileExists);
  return {
    ts,
    sessionId,
    kind: persistedEdits.length > 0 ? "candidate" : "weak",
    fingerprint: pair.fingerprint,
    family: pair.family,
    command: pair.command,
    error: pair.error,
    cwd: pair.cwd,
    count: pair.count,
    edits: persistedEdits,
    resolvedCommand: pair.resolvedCommand,
    resolvedAt: pair.resolvedAt
  };
}
function flushResolvedPairs(sessionId, home = handbookHome(), ts = (/* @__PURE__ */ new Date()).toISOString(), fileExists = existsSync3) {
  const state = loadSessionState(sessionId, home);
  if (state.resolvedPairs.length === 0) return [];
  const signals = state.resolvedPairs.map((p) => signalFromPair(p, sessionId, ts, fileExists));
  appendSignals(signals, home);
  state.resolvedPairs = [];
  saveSessionState(state, home);
  return signals;
}
function ledgerPairsForSession(sessionId, home = handbookHome()) {
  let raw;
  try {
    raw = readFileSync8(signalsFile(home), "utf8");
  } catch {
    return [];
  }
  const pairs = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (parsed.sessionId !== sessionId || !parsed.resolvedCommand || parsed.secretRedacted) continue;
    pairs.push({
      fingerprint: parsed.fingerprint,
      family: parsed.family,
      command: parsed.command,
      error: parsed.error,
      resolvedCommand: parsed.resolvedCommand,
      edits: parsed.edits ?? [],
      ...parsed.cwd ? { cwd: parsed.cwd } : {}
    });
  }
  return pairs;
}

// src/lib/pipeline.ts
import { spawn } from "node:child_process";
import {
  appendFileSync as appendFileSync2,
  mkdirSync as mkdirSync4,
  readdirSync as readdirSync6,
  readFileSync as readFileSync9,
  renameSync as renameSync2,
  rmSync as rmSync3,
  statSync as statSync2,
  utimesSync,
  writeFileSync as writeFileSync4
} from "node:fs";
import { basename as basename3, join as join10 } from "node:path";

// src/lib/harvest.ts
var defaultHarvestConfig = {
  enabled: true,
  // Measured, not assumed: on an identical prompt from a real session, haiku
  // proposed the developer's stated rule 1 time in 3 and sonnet 3 in 3. The whole
  // product is "every session teaches it something"; a default that stays silent
  // two thirds of the time fails that. One call per session, and
  // {"harvest": {"model": "haiku"}} is still there for whoever wants it cheaper.
  model: "sonnet",
  maxPerSession: 3,
  minScore: 4,
  transcriptCharCap: 4e4,
  // Latency is dominated by how much the model writes, not by the slice: a 31k-char
  // prompt returning nothing took 9s, a 6k one returning a full skill took 25s. Three
  // items is the cap, so ~75s is the realistic ceiling — and a timeout here does not
  // degrade to a smaller answer, it burns an attempt and can park the session in
  // abandoned.jsonl. This is the value the yield measurement was run at.
  timeoutMs: 18e4
};
function loadHarvestConfig(home = handbookHome()) {
  const harvest = readConfigFile(home).harvest;
  const num = (v, fallback) => typeof v === "number" && v > 0 ? v : fallback;
  return {
    // fail closed on a broken config — see configIsBroken
    enabled: !configIsBroken(home) && harvest?.enabled !== false,
    model: typeof harvest?.model === "string" ? harvest.model : defaultHarvestConfig.model,
    maxPerSession: num(harvest?.maxPerSession, defaultHarvestConfig.maxPerSession),
    minScore: typeof harvest?.minScore === "number" && harvest.minScore >= 0 && harvest.minScore <= 10 ? harvest.minScore : defaultHarvestConfig.minScore,
    transcriptCharCap: num(harvest?.transcriptCharCap, defaultHarvestConfig.transcriptCharCap),
    timeoutMs: num(harvest?.timeoutMs, defaultHarvestConfig.timeoutMs)
  };
}

// src/lib/pipeline.ts
function pendingDir(home = handbookHome()) {
  return join10(home, "pending");
}
function enqueueHarvestJob(job, home = handbookHome()) {
  mkdirSync4(pendingDir(home), { recursive: true });
  const session = job.sessionId.replace(/[^A-Za-z0-9_-]/g, "_");
  const base = `${session}-${Date.now()}`;
  let file = join10(pendingDir(home), `${base}.json`);
  for (let i = 0; i < 50; i++) {
    try {
      writeFileSync4(file, JSON.stringify(job), { flag: "wx" });
      return file;
    } catch {
      file = join10(pendingDir(home), `${base}-x${i}.json`);
    }
  }
  return null;
}
var STALE_CLAIM_MS = 10 * 60 * 1e3;
var LOG_ROTATE_BYTES = 512 * 1024;
function spawnPipelineRunner(runnerScript, spawnFn = spawn) {
  const child = spawnFn(process.execPath, [runnerScript], {
    detached: true,
    stdio: "ignore"
  });
  child.unref();
}

// src/hooks/session-start.ts
function salvageOrphans(currentSessionId) {
  if (!gateAutoEnabled() || !loadHarvestConfig().enabled) return;
  let enqueued = 0;
  for (const id of orphanedSessionIds()) {
    if (id === currentSessionId) continue;
    const state = loadSessionState(id);
    if (state.harvestedAt) continue;
    flushResolvedPairs(id);
    if (!sessionHasSubstance(state)) continue;
    const pairs = ledgerPairsForSession(id);
    const counts = ledgerFingerprintCounts();
    const recurrence = {};
    for (const pair of pairs) recurrence[pair.fingerprint] = counts.get(pair.fingerprint) ?? 1;
    enqueueHarvestJob({
      sessionId: id,
      cwd: pairs[0]?.cwd ?? "",
      ...state.transcriptPath ? { transcriptPath: state.transcriptPath } : {},
      evidence: {
        pairs,
        ...state.activity ? { work: state.activity } : {},
        ...state.corrections?.length ? { corrections: state.corrections } : {},
        recurrence
      }
    });
    const fresh = loadSessionState(id);
    fresh.harvestedAt = (/* @__PURE__ */ new Date()).toISOString();
    saveSessionState(fresh);
    enqueued += 1;
  }
  if (enqueued > 0) {
    spawnPipelineRunner(fileURLToPath(new URL("./run-pipeline.js", import.meta.url)));
  }
}
async function main() {
  const input = parseHookInput(await readStdin());
  salvageOrphans(input?.session_id);
  cleanupStaleSessionFiles();
  const notice = sessionStartNotice(input?.cwd ?? process.cwd());
  if (notice) console.log(notice);
}
main().then(
  () => process.exit(0),
  () => process.exit(0)
);
