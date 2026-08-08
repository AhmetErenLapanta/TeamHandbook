// src/cli/review.ts
import { readFileSync as readFileSync2 } from "node:fs";
import { join as join5 } from "node:path";

// src/lib/deliver.ts
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { join as join4 } from "node:path";

// src/lib/session-state.ts
import { homedir } from "node:os";
import { join } from "node:path";
function handbookHome() {
  return process.env.TEAMHANDBOOK_HOME ?? join(homedir(), ".teamhandbook");
}

// src/lib/skill-index.ts
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

// src/lib/queue.ts
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join as join3 } from "node:path";
var STATUSES = ["pending", "approved", "rejected"];
function isSafeSlug(slug) {
  return /^[a-z0-9][a-z0-9-]*$/.test(slug);
}
function candidateMetaFile(dir) {
  return join3(dir, "candidate.json");
}
function writeCandidateMeta(dir, meta) {
  writeFileSync(candidateMetaFile(dir), JSON.stringify(meta, null, 2) + "\n");
}
function synthesizeMeta(dir) {
  let md;
  try {
    md = readFileSync(join3(dir, "SKILL.md"), "utf8");
  } catch {
    return null;
  }
  const summary = parseSkillFrontmatter(md);
  if (!summary) return null;
  let grounded = {};
  try {
    grounded = JSON.parse(readFileSync(join3(dir, "grounded-case.json"), "utf8"));
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
    const parsed = JSON.parse(readFileSync(candidateMetaFile(dir), "utf8"));
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
    entries = readdirSync(base, { withFileTypes: true });
  } catch {
    return [];
  }
  const metas = entries.filter((e) => e.isDirectory()).map((e) => readCandidateMeta(join3(base, e.name))).filter((m) => m !== null);
  const filtered = status ? metas.filter((m) => m.status === status) : metas;
  return filtered.sort(
    (a, b) => a.createdAt.localeCompare(b.createdAt) || a.slug.localeCompare(b.slug)
  );
}
function decideCandidate(home, slug, status, decidedAt = (/* @__PURE__ */ new Date()).toISOString()) {
  if (!isSafeSlug(slug)) return { ok: false, error: `invalid candidate name "${slug}"` };
  const dir = join3(candidatesDir(home), slug);
  const meta = readCandidateMeta(dir);
  if (!meta) return { ok: false, error: `no candidate named "${slug}"` };
  if (meta.status !== "pending") {
    return { ok: false, meta, error: `candidate "${slug}" is already ${meta.status}` };
  }
  const updated = { ...meta, status, decidedAt };
  writeCandidateMeta(dir, updated);
  return { ok: true, meta: updated };
}
function formatCandidateList(metas) {
  if (metas.length === 0) return "No pending candidates.";
  const lines = [`Pending candidates (${metas.length}):`, ""];
  metas.forEach((meta, i) => {
    const gate = meta.gate ? `gate ${meta.gate.total}/10` : "gate n/a";
    lines.push(`  ${i + 1}. ${meta.slug}  [${meta.scope}]  ${gate}`);
    lines.push(`     ${meta.description}`);
  });
  return lines.join("\n");
}

// src/lib/deliver.ts
function soloSkillsDir(projectCwd) {
  return join4(projectCwd, ".claude", "skills");
}
function resolveDeliveryDir(meta, fallbackCwd, dirExists = existsSync) {
  const origin = meta.cwd && dirExists(meta.cwd) ? meta.cwd : fallbackCwd;
  return soloSkillsDir(origin);
}
function approveAndDeliver(home = handbookHome(), slug, fallbackCwd = process.cwd(), decidedAt = (/* @__PURE__ */ new Date()).toISOString()) {
  if (!isSafeSlug(slug)) return { ok: false, error: `invalid candidate name "${slug}"` };
  const dir = join4(candidatesDir(home), slug);
  const meta = readCandidateMeta(dir);
  if (!meta) return { ok: false, error: `no candidate named "${slug}"` };
  if (meta.status !== "pending") {
    return { ok: false, meta, error: `candidate "${slug}" is already ${meta.status}` };
  }
  const skillsDir = resolveDeliveryDir(meta, fallbackCwd);
  let target = join4(skillsDir, slug);
  for (let i = 2; existsSync(target); i++) {
    target = join4(skillsDir, `${slug}-${i}`);
  }
  try {
    mkdirSync(target, { recursive: true });
    copyFileSync(join4(dir, "SKILL.md"), join4(target, "SKILL.md"));
    if (existsSync(join4(dir, "grounded-case.json"))) {
      copyFileSync(join4(dir, "grounded-case.json"), join4(target, "grounded-case.json"));
    }
  } catch (err) {
    return { ok: false, meta, error: `delivery failed: ${String(err)}` };
  }
  const updated = {
    ...meta,
    status: "approved",
    decidedAt,
    deliveredTo: target
  };
  writeCandidateMeta(dir, updated);
  return { ok: true, meta: updated, deliveredTo: target };
}

// src/cli/review.ts
function usage() {
  console.error("usage: review.js <list|show|approve|reject> [slug]");
  process.exit(2);
}
function main() {
  const [cmd = "list", slug] = process.argv.slice(2);
  const home = handbookHome();
  if (cmd === "list") {
    console.log(formatCandidateList(listCandidates(home, "pending")));
    return;
  }
  if (!slug || !isSafeSlug(slug)) usage();
  if (cmd === "show") {
    const dir = join5(candidatesDir(home), slug);
    try {
      console.log(readFileSync2(join5(dir, "SKILL.md"), "utf8"));
      console.log("--- grounded-case.json ---");
      console.log(readFileSync2(join5(dir, "grounded-case.json"), "utf8"));
    } catch {
      console.error(`error: no candidate named "${slug}"`);
      process.exit(1);
    }
    return;
  }
  if (cmd !== "approve" && cmd !== "reject") usage();
  if (cmd === "approve") {
    const result2 = approveAndDeliver(home, slug);
    if (!result2.ok) {
      console.error(`error: ${result2.error}`);
      process.exit(1);
    }
    console.log(`Approved "${slug}" and installed it at ${result2.deliveredTo}.`);
    return;
  }
  const result = decideCandidate(home, slug, "rejected");
  if (!result.ok) {
    console.error(`error: ${result.error}`);
    process.exit(1);
  }
  console.log(`Rejected "${slug}". It will not be delivered; its signal stays in the local ledger.`);
}
main();
