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
import { existsSync as existsSync2, readFileSync as readFileSync7 } from "node:fs";

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
function handbookHome() {
  return process.env.TEAMHANDBOOK_HOME ?? join(homedir(), ".teamhandbook");
}
var SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1e3;
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
import { readFileSync as readFileSync2 } from "node:fs";
import { join as join2 } from "node:path";
function readConfigFile(home = handbookHome()) {
  try {
    const parsed = JSON.parse(readFileSync2(join2(home, "config.json"), "utf8"));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

// src/lib/counters.ts
import { mkdirSync as mkdirSync2, readdirSync as readdirSync2, readFileSync as readFileSync3, writeFileSync as writeFileSync2 } from "node:fs";
import { join as join3 } from "node:path";
var FIELDS = [
  "redactionBlocked",
  "postToolUse",
  "bashFailuresCaptured",
  "pairsResolved"
];
function countersFile(home = handbookHome()) {
  return join3(home, "counters.json");
}
function readCounters(home = handbookHome()) {
  const base = { redactionBlocked: 0, postToolUse: 0, bashFailuresCaptured: 0, pairsResolved: 0 };
  try {
    const parsed = JSON.parse(readFileSync3(countersFile(home), "utf8"));
    for (const f of FIELDS) base[f] = Number(parsed?.[f]) || 0;
  } catch {
  }
  return base;
}

// src/lib/init.ts
import { homedir as homedir2, tmpdir } from "node:os";
import { dirname as dirname2, join as join5 } from "node:path";

// src/lib/score.ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";
var execFileAsync = promisify(execFile);

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
function isRejectedCandidate(dir, entry) {
  try {
    const meta = JSON.parse(readFileSync4(join4(dir, entry, "candidate.json"), "utf8"));
    return meta?.status === "rejected";
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
      if (isRejectedCandidate(dir, entry)) continue;
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

// src/lib/init.ts
function loadTeamConfig(home = handbookHome()) {
  const team = readConfigFile(home).team;
  if (team && typeof team.repoUrl === "string" && typeof team.marketplaceName === "string") {
    return team;
  }
  return null;
}
function marketplacesRoot() {
  return join5(homedir2(), ".claude", "plugins", "marketplaces");
}
function teamSkillsDir(home = handbookHome(), root = marketplacesRoot()) {
  const team = loadTeamConfig(home);
  return team ? join5(root, team.marketplaceName, "skills") : null;
}

// src/lib/queue.ts
import { readdirSync as readdirSync4, readFileSync as readFileSync5, writeFileSync as writeFileSync3 } from "node:fs";
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
    entries = readdirSync4(base, { withFileTypes: true });
  } catch {
    return [];
  }
  const metas = entries.filter((e) => e.isDirectory()).map((e) => readCandidateMeta(join6(base, e.name))).filter((m) => m !== null);
  const filtered = status ? metas.filter((m) => m.status === status) : metas;
  return filtered.sort(
    (a, b) => a.createdAt.localeCompare(b.createdAt) || a.slug.localeCompare(b.slug)
  );
}

// src/lib/signals.ts
import { existsSync, appendFileSync, mkdirSync as mkdirSync3, readFileSync as readFileSync6 } from "node:fs";
import { join as join7 } from "node:path";
function signalsFile(home = handbookHome()) {
  return join7(home, "signals.jsonl");
}
function workRecurrences(home = handbookHome()) {
  const byFp = /* @__PURE__ */ new Map();
  let raw;
  try {
    raw = readFileSync6(signalsFile(home), "utf8");
  } catch {
    return [];
  }
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed?.family !== "work" || typeof parsed?.fingerprint !== "string" || !parsed?.work) continue;
      const existing = byFp.get(parsed.fingerprint);
      if (existing) existing.count += 1;
      else {
        byFp.set(parsed.fingerprint, {
          fingerprint: parsed.fingerprint,
          count: 1,
          families: Array.isArray(parsed.work.families) ? parsed.work.families : [],
          exts: Array.isArray(parsed.work.exts) ? parsed.work.exts : []
        });
      }
    } catch {
    }
  }
  return [...byFp.values()];
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
  let prior = { bashFailuresCaptured: 0, pairsResolved: 0 };
  try {
    const parsed = JSON.parse(readFileSync7(heartbeatSnapshotFile(home), "utf8"));
    prior = {
      bashFailuresCaptured: Number(parsed?.bashFailuresCaptured) || 0,
      pairsResolved: Number(parsed?.pairsResolved) || 0
    };
  } catch {
  }
  writeFileAtomic(
    heartbeatSnapshotFile(home),
    JSON.stringify(
      { bashFailuresCaptured: current.bashFailuresCaptured, pairsResolved: current.pairsResolved },
      null,
      2
    ) + "\n"
  );
  return {
    failures: Math.max(0, current.bashFailuresCaptured - prior.bashFailuresCaptured),
    pairs: Math.max(0, current.pairsResolved - prior.pairsResolved)
  };
}
var DEFAULT_WORK_NUDGE_THRESHOLD = 2;
function workNudgeThreshold(home = handbookHome()) {
  const notify = readConfigFile(home).notify;
  const value = notify?.workNudgeThreshold;
  return typeof value === "number" && Number.isInteger(value) && value >= 1 ? value : DEFAULT_WORK_NUDGE_THRESHOLD;
}
function nudgedWorkFile(home) {
  return join8(home, "nudged-work.json");
}
function pendingWorkNudge(home = handbookHome()) {
  let nudged = [];
  try {
    const parsed = JSON.parse(readFileSync7(nudgedWorkFile(home), "utf8"));
    if (Array.isArray(parsed)) nudged = parsed.filter((f) => typeof f === "string");
  } catch {
  }
  const threshold = workNudgeThreshold(home);
  const due = workRecurrences(home).filter((r) => r.count >= threshold && !nudged.includes(r.fingerprint)).sort((a, b) => b.count - a.count);
  const top = due[0];
  if (!top) return null;
  writeFileAtomic(nudgedWorkFile(home), JSON.stringify([...nudged, top.fingerprint], null, 2) + "\n");
  const what = [top.families.slice(0, 3).join(", "), top.exts.slice(0, 3).join(" ")].filter(Boolean).join("; editing ");
  return `handbook: you've done similar work ${top.count} times (${what}) \u2014 if that's a repeatable procedure, run /handbook:learn to turn it into a team skill.`;
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
  const { pending, newSkills, firstRun = false, heartbeat = null, workNudge = null } = inputs;
  const lines = [];
  if (firstRun) {
    lines.push(
      "TeamHandbook is active \u2014 watching this machine for error\u2192fix moments worth keeping. Nothing leaves your machine without your approval. Run /handbook:status anytime, or try /handbook:learn after your next completed task."
    );
  }
  if (pending > 0) {
    const noun = pending === 1 ? "candidate skill is" : "candidate skills are";
    lines.push(
      `handbook: ${pending} ${noun} awaiting your review \u2014 run /handbook:review to approve or reject.`
    );
  }
  if (newSkills.length > 0) {
    const noun = newSkills.length === 1 ? "new skill" : "new skills";
    lines.push(
      `handbook: ${newSkills.length} ${noun} available since your last session here: ${newSkills.join(", ")}.`
    );
  }
  if (workNudge) lines.push(workNudge);
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
function sessionStartNotice(cwd, home = handbookHome(), marketplacesRootDir) {
  const config = loadNotifyConfig(home);
  if (!config.sessionStart) return null;
  const pending = listCandidates(home, "pending").length;
  const watchedDirs = [join8(cwd, ".claude", "skills")];
  const teamDir = teamSkillsDir(home, marketplacesRootDir);
  if (teamDir) watchedDirs.push(teamDir);
  const newSkills = watchedDirs.flatMap((dir) => diffNewSkills(dir, listExistingSkills([dir]).map((s) => s.name), home)).sort();
  return buildSessionStartSummary({
    pending,
    newSkills,
    firstRun: isFirstRun(home),
    heartbeat: config.heartbeat ? heartbeatDelta(home) : null,
    workNudge: pendingWorkNudge(home)
  });
}

// src/hooks/session-start.ts
async function main() {
  const input = parseHookInput(await readStdin());
  cleanupStaleSessionFiles();
  const notice = sessionStartNotice(input?.cwd ?? process.cwd());
  if (notice) console.log(notice);
}
main().then(
  () => process.exit(0),
  () => process.exit(0)
);
