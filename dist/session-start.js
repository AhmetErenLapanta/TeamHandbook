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
import { mkdirSync, readFileSync as readFileSync3, writeFileSync as writeFileSync2 } from "node:fs";
import { join as join4 } from "node:path";

// src/lib/session-state.ts
import { homedir } from "node:os";
import { join } from "node:path";
function handbookHome() {
  return process.env.TEAMHANDBOOK_HOME ?? join(homedir(), ".teamhandbook");
}

// src/lib/queue.ts
import { readdirSync as readdirSync2, readFileSync as readFileSync2, writeFileSync } from "node:fs";
import { basename, join as join3 } from "node:path";

// src/lib/skill-index.ts
import { readdirSync, readFileSync } from "node:fs";
import { join as join2 } from "node:path";
function candidatesDir(home = handbookHome()) {
  return join2(home, "candidates");
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
function listExistingSkills(dirs) {
  const byName = /* @__PURE__ */ new Map();
  for (const dir of dirs) {
    let entries;
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      let raw;
      try {
        raw = readFileSync(join2(dir, entry, "SKILL.md"), "utf8");
      } catch {
        continue;
      }
      const summary = parseSkillFrontmatter(raw);
      if (summary && !byName.has(summary.name)) byName.set(summary.name, summary);
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

// src/lib/queue.ts
var STATUSES = ["pending", "approved", "rejected"];
function candidateMetaFile(dir) {
  return join3(dir, "candidate.json");
}
function synthesizeMeta(dir) {
  let md;
  try {
    md = readFileSync2(join3(dir, "SKILL.md"), "utf8");
  } catch {
    return null;
  }
  const summary = parseSkillFrontmatter(md);
  if (!summary) return null;
  let grounded = {};
  try {
    grounded = JSON.parse(readFileSync2(join3(dir, "grounded-case.json"), "utf8"));
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
  const metas = entries.filter((e) => e.isDirectory()).map((e) => readCandidateMeta(join3(base, e.name))).filter((m) => m !== null);
  const filtered = status ? metas.filter((m) => m.status === status) : metas;
  return filtered.sort(
    (a, b) => a.createdAt.localeCompare(b.createdAt) || a.slug.localeCompare(b.slug)
  );
}

// src/lib/notify.ts
var defaultNotifyConfig = {
  sessionStart: true
};
function loadNotifyConfig(home = handbookHome()) {
  try {
    const parsed = JSON.parse(readFileSync3(join4(home, "config.json"), "utf8"));
    return { sessionStart: parsed?.notify?.sessionStart !== false };
  } catch {
    return { ...defaultNotifyConfig };
  }
}
function seenSkillsFile(home = handbookHome()) {
  return join4(home, "seen-skills.json");
}
function readSeenSkills(home) {
  try {
    const parsed = JSON.parse(readFileSync3(seenSkillsFile(home), "utf8"));
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
  mkdirSync(home, { recursive: true });
  writeFileSync2(seenSkillsFile(home), JSON.stringify(state, null, 2) + "\n");
  if (!Array.isArray(prior)) return [];
  const priorSet = new Set(prior);
  return currentNames.filter((name) => !priorSet.has(name)).sort();
}
function buildSessionStartSummary(pending, newSkills) {
  const lines = [];
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
  return lines.length > 0 ? lines.join("\n") : null;
}
function sessionStartNotice(cwd, home = handbookHome()) {
  if (!loadNotifyConfig(home).sessionStart) return null;
  const pending = listCandidates(home, "pending").length;
  const skillsDir = join4(cwd, ".claude", "skills");
  const current = listExistingSkills([skillsDir]).map((s) => s.name);
  return buildSessionStartSummary(pending, diffNewSkills(skillsDir, current, home));
}

// src/hooks/session-start.ts
async function main() {
  const input = parseHookInput(await readStdin());
  const notice = sessionStartNotice(input?.cwd ?? process.cwd());
  if (notice) console.log(notice);
}
main().then(
  () => process.exit(0),
  () => process.exit(0)
);
