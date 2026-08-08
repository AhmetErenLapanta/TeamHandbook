// src/cli/review.ts
import { readFileSync as readFileSync5 } from "node:fs";
import { join as join7 } from "node:path";

// src/lib/deliver.ts
import { copyFileSync as copyFileSync2, existsSync as existsSync2, mkdirSync as mkdirSync2, readFileSync as readFileSync4, writeFileSync as writeFileSync3 } from "node:fs";
import { join as join6 } from "node:path";

// src/lib/init.ts
import { execFileSync } from "node:child_process";

// src/lib/session-state.ts
import { homedir } from "node:os";
import { join } from "node:path";
var EDIT_ATTACH_WINDOW_MS = 15 * 60 * 1e3;
function handbookHome() {
  return process.env.TEAMHANDBOOK_HOME ?? join(homedir(), ".teamhandbook");
}

// src/lib/config.ts
import { readFileSync } from "node:fs";
import { join as join2 } from "node:path";
function readConfigFile(home = handbookHome()) {
  try {
    const parsed = JSON.parse(readFileSync(join2(home, "config.json"), "utf8"));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

// src/lib/score.ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";
var execFileAsync = promisify(execFile);

// src/lib/skill-index.ts
import { join as join3 } from "node:path";
function candidatesDir(home = handbookHome()) {
  return join3(home, "candidates");
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

// src/lib/distill.ts
function normalizeRemoteUrl(raw) {
  let s = raw.trim();
  if (!s) return null;
  const hadProtocol = /^[a-z][a-z0-9+.-]*:\/\//i.test(s);
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
  s = s.replace(/^[^@/]+@/, "");
  if (!hadProtocol) {
    const colon = s.indexOf(":");
    const slash2 = s.indexOf("/");
    if (colon > 0 && (slash2 === -1 || colon < slash2)) {
      s = s.slice(0, colon) + "/" + s.slice(colon + 1);
    }
  }
  s = s.replace(/\.git$/i, "").replace(/\/+$/, "");
  const slash = s.indexOf("/");
  if (slash <= 0 || slash === s.length - 1) return null;
  return s.slice(0, slash).toLowerCase() + s.slice(slash);
}
function renameSkillMd(skillMd, newSlug) {
  return skillMd.replace(/^name:.*$/m, `name: ${newSlug}`);
}
function uniqueSlug(baseSlug, taken) {
  let slug = baseSlug;
  for (let i = 2; taken(slug); i++) slug = `${baseSlug}-${i}`;
  return slug;
}

// src/lib/init.ts
var REMOTE_HELPER = /^[A-Za-z][A-Za-z0-9+.-]*::/;
function assertSafeGitUrl(url) {
  const u = url.trim();
  if (!u || u.startsWith("-") || REMOTE_HELPER.test(u) || /[\r\n\0]/.test(u)) {
    throw new Error(`unsafe or unsupported git URL: ${url}`);
  }
}
function loadTeamConfig(home = handbookHome()) {
  const team = readConfigFile(home).team;
  if (team && typeof team.repoUrl === "string" && typeof team.marketplaceName === "string") {
    return team;
  }
  return null;
}
function hostFromUrl(url) {
  const normalized = normalizeRemoteUrl(url);
  if (!normalized) return null;
  return normalized.slice(0, normalized.indexOf("/"));
}
function runGit(args, cwd) {
  execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });
}

// src/lib/publish.ts
import { execFileSync as execFileSync2 } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync as readFileSync2, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as join4 } from "node:path";
function runForge(tool, args, cwd) {
  return execFileSync2(tool, args, { cwd, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });
}
function buildPrTitle(slug) {
  return `feat(skill): add ${slug}`;
}
function buildPrBody(meta, grounded) {
  const lines = [
    meta.description,
    "",
    `- scope: \`${meta.scope}\``,
    `- gate score: ${meta.gate ? `${meta.gate.total}/10` : "n/a"}`
  ];
  if (meta.gate) {
    const scores = Object.entries(meta.gate.scores).map(([criterion, score]) => `${criterion} ${score}`).join(", ");
    if (scores) lines.push(`- criteria: ${scores}`);
  }
  if (grounded) {
    lines.push(
      "",
      "## Grounded case",
      "",
      "This skill was distilled from a real error-to-fix session; the case below ships with it",
      "as its regression gate.",
      "",
      `- failed command: \`${grounded.command}\``,
      `- error (normalized): \`${grounded.error}\``,
      `- resolving command: ${grounded.resolvedCommand ? `\`${grounded.resolvedCommand}\`` : "(none recorded)"}`,
      `- files edited for the fix: ${grounded.edits.join(", ") || "(none)"}`,
      `- expect: ${grounded.expect}`
    );
  }
  lines.push("", "---", "Opened by TeamHandbook after human approval of the candidate.");
  return lines.join("\n");
}
function manualPrUrl(repoUrl, branch) {
  const normalized = normalizeRemoteUrl(repoUrl);
  if (!normalized) return null;
  const host = hostFromUrl(repoUrl);
  if (host && host.includes("github")) {
    return `https://${normalized}/pull/new/${branch}`;
  }
  return `https://${normalized}/-/merge_requests/new?merge_request%5Bsource_branch%5D=${encodeURIComponent(branch)}`;
}
function readGroundedCase(candidateDir) {
  try {
    const parsed = JSON.parse(readFileSync2(join4(candidateDir, "grounded-case.json"), "utf8"));
    if (typeof parsed?.command === "string" && typeof parsed?.error === "string" && typeof parsed?.expect === "string" && Array.isArray(parsed?.edits)) {
      return parsed;
    }
  } catch {
  }
  return null;
}
function extractUrl(output) {
  return output.match(/https?:\/\/\S+/)?.[0] ?? null;
}
function openPr(repoUrl, branch, title, body, repoDir, forge) {
  const host = hostFromUrl(repoUrl);
  try {
    if (host && host.includes("github")) {
      return extractUrl(forge("gh", ["pr", "create", "--head", branch, "--title", title, "--body", body], repoDir));
    }
    return extractUrl(
      forge(
        "glab",
        ["mr", "create", "--source-branch", branch, "--title", title, "--description", body, "--yes"],
        repoDir
      )
    );
  } catch {
    return null;
  }
}
function publishCandidate(candidateDir, meta, team, git = runGit, forge = runForge) {
  try {
    assertSafeGitUrl(team.repoUrl);
  } catch (err) {
    return { ok: false, error: String(err instanceof Error ? err.message : err) };
  }
  const workdir = mkdtempSync(join4(tmpdir(), "handbook-publish-"));
  const repoDir = join4(workdir, "repo");
  try {
    try {
      git(["clone", "--depth", "1", "--", team.repoUrl, repoDir], workdir);
    } catch (err) {
      return { ok: false, error: `git clone failed (is the team repo reachable?): ${String(err)}` };
    }
    const slug = uniqueSlug(meta.slug, (s) => existsSync(join4(repoDir, "skills", s)));
    const branch = `handbook/${slug}`;
    const skillDir = `skills/${slug}`;
    const title = buildPrTitle(slug);
    try {
      git(["checkout", "-b", branch], repoDir);
      mkdirSync(join4(repoDir, skillDir), { recursive: true });
      const skillMd = readFileSync2(join4(candidateDir, "SKILL.md"), "utf8");
      writeFileSync(
        join4(repoDir, skillDir, "SKILL.md"),
        slug === meta.slug ? skillMd : renameSkillMd(skillMd, slug)
      );
      if (existsSync(join4(candidateDir, "grounded-case.json"))) {
        copyFileSync(
          join4(candidateDir, "grounded-case.json"),
          join4(repoDir, skillDir, "grounded-case.json")
        );
      }
      git(["add", "-A"], repoDir);
      git(["commit", "-m", title], repoDir);
      git(["push", "-u", "origin", branch], repoDir);
    } catch (err) {
      return { ok: false, error: `git push failed (branch ${branch}): ${String(err)}` };
    }
    const body = buildPrBody(meta, readGroundedCase(candidateDir));
    const prUrl = openPr(team.repoUrl, branch, title, body, repoDir, forge);
    if (prUrl) return { ok: true, branch, skillDir, prUrl };
    return {
      ok: true,
      branch,
      skillDir,
      manualUrl: manualPrUrl(team.repoUrl, branch) ?? void 0
    };
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
}

// src/lib/queue.ts
import { readdirSync, readFileSync as readFileSync3, writeFileSync as writeFileSync2 } from "node:fs";
import { basename, join as join5 } from "node:path";
var STATUSES = ["pending", "approved", "rejected"];
function isSafeSlug(slug) {
  return /^[a-z0-9][a-z0-9-]*$/.test(slug);
}
function candidateMetaFile(dir) {
  return join5(dir, "candidate.json");
}
function writeCandidateMeta(dir, meta) {
  writeFileSync2(candidateMetaFile(dir), JSON.stringify(meta, null, 2) + "\n");
}
function synthesizeMeta(dir) {
  let md;
  try {
    md = readFileSync3(join5(dir, "SKILL.md"), "utf8");
  } catch {
    return null;
  }
  const summary = parseSkillFrontmatter(md);
  if (!summary) return null;
  let grounded = {};
  try {
    grounded = JSON.parse(readFileSync3(join5(dir, "grounded-case.json"), "utf8"));
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
    const parsed = JSON.parse(readFileSync3(candidateMetaFile(dir), "utf8"));
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
  const metas = entries.filter((e) => e.isDirectory()).map((e) => readCandidateMeta(join5(base, e.name))).filter((m) => m !== null);
  const filtered = status ? metas.filter((m) => m.status === status) : metas;
  return filtered.sort(
    (a, b) => a.createdAt.localeCompare(b.createdAt) || a.slug.localeCompare(b.slug)
  );
}
function decideCandidate(home, slug, status, decidedAt = (/* @__PURE__ */ new Date()).toISOString()) {
  if (!isSafeSlug(slug)) return { ok: false, error: `invalid candidate name "${slug}"` };
  const dir = join5(candidatesDir(home), slug);
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
  return join6(projectCwd, ".claude", "skills");
}
function resolveDeliveryDir(meta, fallbackCwd, dirExists = existsSync2) {
  const origin = meta.cwd && dirExists(meta.cwd) ? meta.cwd : fallbackCwd;
  return soloSkillsDir(origin);
}
function approveAndDeliver(home = handbookHome(), slug, fallbackCwd = process.cwd(), decidedAt = (/* @__PURE__ */ new Date()).toISOString(), team = loadTeamConfig(home), git = runGit, forge = runForge) {
  if (!isSafeSlug(slug)) return { ok: false, error: `invalid candidate name "${slug}"` };
  const dir = join6(candidatesDir(home), slug);
  const meta = readCandidateMeta(dir);
  if (!meta) return { ok: false, error: `no candidate named "${slug}"` };
  if (meta.status !== "pending") {
    return { ok: false, meta, error: `candidate "${slug}" is already ${meta.status}` };
  }
  if (team) return deliverToTeam(dir, meta, team, decidedAt, git, forge);
  return deliverSolo(dir, meta, fallbackCwd, decidedAt);
}
function deliverToTeam(dir, meta, team, decidedAt, git, forge) {
  const published = publishCandidate(dir, meta, team, git, forge);
  if (!published.ok) return { ok: false, mode: "team", meta, error: published.error };
  const deliveredTo = published.prUrl ?? `${team.repoUrl} (branch ${published.branch})`;
  const updated = { ...meta, status: "approved", decidedAt, deliveredTo };
  writeCandidateMeta(dir, updated);
  return {
    ok: true,
    mode: "team",
    meta: updated,
    deliveredTo,
    branch: published.branch,
    prUrl: published.prUrl,
    manualUrl: published.manualUrl
  };
}
function deliverSolo(dir, meta, fallbackCwd, decidedAt) {
  const skillsDir = resolveDeliveryDir(meta, fallbackCwd);
  const slug = uniqueSlug(meta.slug, (s) => existsSync2(join6(skillsDir, s)));
  const target = join6(skillsDir, slug);
  try {
    mkdirSync2(target, { recursive: true });
    const skillMd = readFileSync4(join6(dir, "SKILL.md"), "utf8");
    writeFileSync3(join6(target, "SKILL.md"), slug === meta.slug ? skillMd : renameSkillMd(skillMd, slug));
    if (existsSync2(join6(dir, "grounded-case.json"))) {
      copyFileSync2(join6(dir, "grounded-case.json"), join6(target, "grounded-case.json"));
    }
  } catch (err) {
    return { ok: false, mode: "solo", meta, error: `delivery failed: ${String(err)}` };
  }
  const updated = {
    ...meta,
    status: "approved",
    decidedAt,
    deliveredTo: target
  };
  writeCandidateMeta(dir, updated);
  return { ok: true, mode: "solo", meta: updated, deliveredTo: target };
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
    const dir = join7(candidatesDir(home), slug);
    try {
      console.log(readFileSync5(join7(dir, "SKILL.md"), "utf8"));
      console.log("--- grounded-case.json ---");
      console.log(readFileSync5(join7(dir, "grounded-case.json"), "utf8"));
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
    if (result2.mode === "team") {
      if (result2.prUrl) {
        console.log(`Approved "${slug}" and opened a PR to the team skill base: ${result2.prUrl}`);
      } else {
        console.log(`Approved "${slug}" and pushed branch ${result2.branch} to the team skill base.`);
        if (result2.manualUrl) console.log(`Open the PR here: ${result2.manualUrl}`);
      }
    } else {
      console.log(`Approved "${slug}" and installed it at ${result2.deliveredTo}.`);
    }
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
