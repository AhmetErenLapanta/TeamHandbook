// src/cli/review.ts
import { readFileSync as readFileSync7 } from "node:fs";
import { join as join9 } from "node:path";

// src/lib/deliver.ts
import { copyFileSync as copyFileSync2, existsSync as existsSync3, mkdirSync as mkdirSync3, readFileSync as readFileSync4, writeFileSync as writeFileSync4 } from "node:fs";
import { homedir as homedir2 } from "node:os";
import { basename as basename2, join as join6 } from "node:path";

// src/lib/init.ts
import { execFileSync } from "node:child_process";

// src/lib/session-state.ts
import { homedir } from "node:os";
import { join } from "node:path";

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

// src/lib/session-state.ts
var EDIT_ATTACH_WINDOW_MS = 15 * 60 * 1e3;
function handbookHome() {
  return process.env.TEAMHANDBOOK_HOME ?? join(homedir(), ".teamhandbook");
}
var SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1e3;
var SESSION_ORPHAN_MS = 3 * 60 * 60 * 1e3;

// src/lib/config.ts
import { existsSync, readFileSync } from "node:fs";
import { join as join2 } from "node:path";
function configFile(home = handbookHome()) {
  return join2(home, "config.json");
}
function readConfigFile(home = handbookHome()) {
  try {
    const parsed = JSON.parse(readFileSync(configFile(home), "utf8"));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}
function configIsBroken(home = handbookHome()) {
  const file = configFile(home);
  if (!existsSync(file)) return false;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    return !(typeof parsed === "object" && parsed !== null && !Array.isArray(parsed));
  } catch {
    return true;
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
  if (/[\x00-\x1f\x7f]/.test(s)) return null;
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
function runGit(args, cwd) {
  try {
    return execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });
  } catch (err) {
    const stderr = err?.stderr;
    if (typeof stderr === "string" && stderr.trim()) {
      const tail = stderr.trim().split("\n").slice(-3).join(" | ");
      throw new Error(`git ${args[0]} failed: ${tail}`);
    }
    throw err;
  }
}

// src/lib/publish.ts
import { execFileSync as execFileSync2 } from "node:child_process";
import { copyFileSync, existsSync as existsSync2, mkdirSync as mkdirSync2, mkdtempSync, readFileSync as readFileSync2, rmSync as rmSync2, writeFileSync as writeFileSync2 } from "node:fs";
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
  if (grounded && grounded.task) {
    lines.push(
      "",
      "## Grounded case",
      "",
      "This skill was distilled from a real completed task. The case below ships with it as",
      "the evidence to review it against \u2014 nothing re-runs it automatically.",
      "",
      `- goal: ${grounded.task.goal}`,
      ...grounded.task.steps.map((s, i) => `- step ${i + 1}: ${s}`),
      `- verified by: ${grounded.task.verification ?? "(not recorded)"}`,
      `- files touched: ${grounded.edits.join(", ") || "(none)"}`,
      `- expect: ${grounded.expect}`
    );
  } else if (grounded) {
    lines.push(
      "",
      "## Grounded case",
      "",
      "This skill was distilled from a real error-to-fix session. The case below ships with",
      "it as the evidence to review it against \u2014 nothing re-runs it automatically.",
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
    const out = host && host.includes("github") ? forge("gh", ["pr", "create", "--head", branch, "--title", title, "--body", body], repoDir) : forge(
      "glab",
      ["mr", "create", "--source-branch", branch, "--title", title, "--description", body, "--yes"],
      repoDir
    );
    return { url: extractUrl(out) };
  } catch (err) {
    const e = err;
    const tool = host && host.includes("github") ? "gh" : "glab";
    let reason;
    if (e?.code === "ENOENT") reason = `the ${tool} CLI is not installed`;
    else {
      const stderr = typeof e?.stderr === "string" ? e.stderr.trim() : "";
      reason = (stderr ? stderr.split("\n").at(-1) : String(e?.message ?? err)).slice(0, 160);
    }
    return { url: null, error: reason };
  }
}
function publishCandidate(candidateDir, meta, team, git = runGit, forge = runForge) {
  try {
    assertSafeGitUrl(team.repoUrl);
  } catch (err) {
    return { ok: false, error: String(err instanceof Error ? err.message : err) };
  }
  let candidateSkillMd;
  try {
    candidateSkillMd = readFileSync2(join4(candidateDir, "SKILL.md"), "utf8");
  } catch {
    return { ok: false, error: `candidate SKILL.md is missing or unreadable in ${candidateDir}` };
  }
  const readIdentity = (key) => {
    try {
      return git(["config", key], process.cwd());
    } catch {
      return "";
    }
  };
  const email = readIdentity("user.email");
  const name = readIdentity("user.name");
  const unset = (v) => typeof v === "string" && v.trim() === "";
  if (unset(email) || unset(name)) {
    return {
      ok: false,
      error: 'git user.name/user.email is not set \u2014 the PR would have a junk author. Run `git config --global user.name "Your Name"` and `git config --global user.email you@example.com`, then approve again.'
    };
  }
  const identityArgs = typeof name === "string" && name.trim() !== "" && typeof email === "string" && email.trim() !== "" ? ["-c", `user.name=${name.trim()}`, "-c", `user.email=${email.trim()}`] : [];
  const workdir = mkdtempSync(join4(tmpdir(), "handbook-publish-"));
  const repoDir = join4(workdir, "repo");
  try {
    try {
      git(["clone", "--depth", "1", "--", team.repoUrl, repoDir], workdir);
    } catch (err) {
      return { ok: false, error: `git clone failed (is the team repo reachable?): ${String(err)}` };
    }
    let remoteBranches = /* @__PURE__ */ new Set();
    try {
      const out = git(["ls-remote", "--heads", "origin"], repoDir);
      remoteBranches = new Set(
        String(out ?? "").split("\n").map((line) => line.split("	")[1] ?? "").filter(Boolean).map((ref) => ref.replace("refs/heads/", ""))
      );
    } catch {
    }
    const slug = uniqueSlug(
      meta.slug,
      (s) => existsSync2(join4(repoDir, "skills", s)) || remoteBranches.has(`handbook/${s}`)
    );
    const branch = `handbook/${slug}`;
    const skillDir = `skills/${slug}`;
    const title = buildPrTitle(slug);
    try {
      git(["checkout", "-b", branch], repoDir);
      mkdirSync2(join4(repoDir, skillDir), { recursive: true });
      writeFileSync2(
        join4(repoDir, skillDir, "SKILL.md"),
        slug === meta.slug ? candidateSkillMd : renameSkillMd(candidateSkillMd, slug)
      );
      if (existsSync2(join4(candidateDir, "grounded-case.json"))) {
        copyFileSync(
          join4(candidateDir, "grounded-case.json"),
          join4(repoDir, skillDir, "grounded-case.json")
        );
      }
      git(["add", "-A"], repoDir);
      git([...identityArgs, "commit", "-m", title], repoDir);
      git(["push", "-u", "origin", branch], repoDir);
    } catch (err) {
      return { ok: false, error: `git push failed (branch ${branch}): ${String(err)}` };
    }
    const body = buildPrBody(meta, readGroundedCase(candidateDir));
    const pr = openPr(team.repoUrl, branch, title, body, repoDir, forge);
    if (pr.url) return { ok: true, branch, skillDir, prUrl: pr.url };
    return {
      ok: true,
      branch,
      skillDir,
      manualUrl: manualPrUrl(team.repoUrl, branch) ?? void 0,
      ...pr.error ? { prError: pr.error } : {}
    };
  } finally {
    rmSync2(workdir, { recursive: true, force: true });
  }
}

// src/lib/queue.ts
import { readdirSync, readFileSync as readFileSync3 } from "node:fs";
import { basename, join as join5 } from "node:path";
var STATUSES = ["pending", "approved", "rejected"];
function isSafeSlug(slug) {
  return /^[a-z0-9][a-z0-9-]*$/.test(slug);
}
function candidateMetaFile(dir) {
  return join5(dir, "candidate.json");
}
function writeCandidateMeta(dir, meta) {
  writeFileAtomic(candidateMetaFile(dir), JSON.stringify(meta, null, 2) + "\n");
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
    entries = readdirSync(base, { withFileTypes: true });
  } catch {
    return [];
  }
  const metas = entries.filter((e) => e.isDirectory()).map((e) => readCandidateMeta(join5(base, e.name))).filter((m) => m !== null);
  const filtered = status ? metas.filter((m) => m.status === status) : metas;
  return filtered.sort(
    (a, b) => b.createdAt.localeCompare(a.createdAt) || a.slug.localeCompare(b.slug)
  );
}
function relativeAge(iso, now) {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "unknown age";
  const mins = Math.max(0, Math.round((now - then) / 6e4));
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}
function originProject(meta) {
  if (!meta.cwd) return "unknown project";
  return meta.cwd.split("/").filter(Boolean).pop() ?? meta.cwd;
}
function decideCandidate(home, slug, status, decidedAt = (/* @__PURE__ */ new Date()).toISOString(), options = {}) {
  if (!isSafeSlug(slug)) return { ok: false, error: `invalid candidate name "${slug}"` };
  const dir = join5(candidatesDir(home), slug);
  const meta = readCandidateMeta(dir);
  if (!meta) return { ok: false, error: `no candidate named "${slug}"` };
  if (meta.status !== "pending") {
    return { ok: false, meta, error: `candidate "${slug}" is already ${meta.status}` };
  }
  const updated = { ...meta, status, decidedAt };
  writeCandidateMeta(dir, updated);
  let muted = false;
  if (status === "rejected" && options.mute && meta.fingerprint) {
    muteFingerprint(meta.fingerprint, home);
    muted = true;
  }
  return { ok: true, meta: updated, muted };
}
function mutedFile(home = handbookHome()) {
  return join5(home, "muted.json");
}
function loadMutedFingerprints(home = handbookHome()) {
  try {
    const parsed = JSON.parse(readFileSync3(mutedFile(home), "utf8"));
    if (Array.isArray(parsed)) return new Set(parsed.filter((f) => typeof f === "string"));
  } catch {
  }
  return /* @__PURE__ */ new Set();
}
function muteFingerprint(fingerprint, home = handbookHome()) {
  const muted = loadMutedFingerprints(home);
  muted.add(fingerprint);
  writeFileAtomic(mutedFile(home), JSON.stringify([...muted].sort(), null, 2) + "\n");
}
function formatCandidateList(metas, now = Date.now()) {
  if (metas.length === 0) return "No pending candidates.";
  const lines = [`Pending candidates (${metas.length}), newest first:`, ""];
  metas.forEach((meta, i) => {
    const gate = meta.gate ? `gate ${meta.gate.total}/10` : "gate n/a";
    const kind = meta.kind ? `[${meta.kind}]  ` : "";
    lines.push(
      `  ${i + 1}. ${meta.slug}  ${kind}[${meta.scope}]  ${gate}  \xB7  ${relativeAge(meta.createdAt, now)}  \xB7  from ${originProject(meta)}`
    );
    lines.push(`     ${meta.description}`);
  });
  return lines.join("\n");
}

// src/lib/deliver.ts
function soloSkillsDir(projectCwd) {
  return join6(projectCwd, ".claude", "skills");
}
function personalSkillsDir() {
  return join6(homedir2(), ".claude", "skills");
}
function resolveDeliveryDir(meta, fallbackCwd, dirExists = existsSync3) {
  const origin = meta.cwd && dirExists(meta.cwd) ? meta.cwd : fallbackCwd;
  return soloSkillsDir(origin);
}
function approveAndDeliver(home = handbookHome(), slug, fallbackCwd = process.cwd(), decidedAt = (/* @__PURE__ */ new Date()).toISOString(), team = loadTeamConfig(home), git = runGit, forge = runForge, target, personalDir = personalSkillsDir()) {
  if (!isSafeSlug(slug)) return { ok: false, error: `invalid candidate name "${slug}"` };
  const dir = join6(candidatesDir(home), slug);
  const meta = readCandidateMeta(dir);
  if (!meta) return { ok: false, error: `no candidate named "${slug}"` };
  if (meta.status !== "pending") {
    return { ok: false, meta, error: `candidate "${slug}" is already ${meta.status}` };
  }
  const resolved = target ?? meta.suggestedTarget ?? (team ? "team" : "project");
  if (resolved === "team") {
    if (!team) {
      return {
        ok: false,
        meta,
        error: "no team configured \u2014 run /handbook:init or /handbook:join first, or approve with --to personal"
      };
    }
    return deliverToTeam(dir, meta, team, decidedAt, git, forge);
  }
  if (resolved === "personal") return deliverPersonal(dir, meta, decidedAt, personalDir);
  return deliverSolo(dir, meta, fallbackCwd, decidedAt);
}
function deliverPersonal(dir, meta, decidedAt, skillsDir = personalSkillsDir()) {
  const slug = uniqueSlug(meta.slug, (s) => existsSync3(join6(skillsDir, s)));
  const target = join6(skillsDir, slug);
  try {
    const skillMd = readFileSync4(join6(dir, "SKILL.md"), "utf8");
    mkdirSync3(target, { recursive: true });
    writeFileSync4(join6(target, "SKILL.md"), slug === meta.slug ? skillMd : renameSkillMd(skillMd, slug));
    if (existsSync3(join6(dir, "grounded-case.json"))) {
      copyFileSync2(join6(dir, "grounded-case.json"), join6(target, "grounded-case.json"));
    }
  } catch (err) {
    return { ok: false, mode: "personal", meta, error: `delivery failed: ${String(err)}` };
  }
  const updated = {
    ...meta,
    status: "approved",
    decidedAt,
    deliveredTo: target,
    deliveredMode: "personal"
  };
  writeCandidateMeta(dir, updated);
  return { ok: true, mode: "personal", meta: updated, deliveredTo: target };
}
function deliverToTeam(dir, meta, team, decidedAt, git, forge) {
  const published = publishCandidate(dir, meta, team, git, forge);
  if (!published.ok) return { ok: false, mode: "team", meta, error: published.error };
  const deliveredTo = published.prUrl ?? `${team.repoUrl} (branch ${published.branch})`;
  const updated = { ...meta, status: "approved", decidedAt, deliveredTo, deliveredMode: "team" };
  writeCandidateMeta(dir, updated);
  return {
    ok: true,
    mode: "team",
    meta: updated,
    deliveredTo,
    branch: published.branch,
    prUrl: published.prUrl,
    manualUrl: published.manualUrl,
    ...published.prError ? { prError: published.prError } : {}
  };
}
function deliverSolo(dir, meta, fallbackCwd, decidedAt) {
  const originGone = !!meta.cwd && !existsSync3(meta.cwd);
  const noOrigin = !meta.cwd;
  const skillsDir = resolveDeliveryDir(meta, fallbackCwd);
  const warning = originGone || noOrigin ? `origin project ${meta.cwd ? `"${meta.cwd}" no longer exists` : "was not recorded"}; installed into the current project instead (${skillsDir})` : void 0;
  const installedProject = meta.cwd && existsSync3(meta.cwd) ? meta.cwd : fallbackCwd;
  const originProject2 = installedProject !== fallbackCwd ? basename2(installedProject) : void 0;
  const slug = uniqueSlug(meta.slug, (s) => existsSync3(join6(skillsDir, s)));
  const target = join6(skillsDir, slug);
  try {
    const skillMd = readFileSync4(join6(dir, "SKILL.md"), "utf8");
    mkdirSync3(target, { recursive: true });
    writeFileSync4(join6(target, "SKILL.md"), slug === meta.slug ? skillMd : renameSkillMd(skillMd, slug));
    if (existsSync3(join6(dir, "grounded-case.json"))) {
      copyFileSync2(join6(dir, "grounded-case.json"), join6(target, "grounded-case.json"));
    }
  } catch (err) {
    return { ok: false, mode: "solo", meta, error: `delivery failed: ${String(err)}` };
  }
  const updated = {
    ...meta,
    status: "approved",
    decidedAt,
    deliveredTo: target,
    deliveredMode: "solo"
  };
  writeCandidateMeta(dir, updated);
  return {
    ok: true,
    mode: "solo",
    meta: updated,
    deliveredTo: target,
    ...warning ? { warning } : {},
    ...originProject2 ? { originProject: originProject2 } : {}
  };
}

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

// src/lib/notify.ts
import { existsSync as existsSync4, readFileSync as readFileSync5, readdirSync as readdirSync2 } from "node:fs";
import { join as join7 } from "node:path";
var DIGEST_INTERVAL_MS = 7 * 24 * 60 * 60 * 1e3;
function pendingHarvestCount(home = handbookHome()) {
  let entries;
  try {
    entries = readdirSync2(join7(home, "pending"));
  } catch {
    return 0;
  }
  let total = 0;
  for (const entry of entries) {
    if (!entry.includes(".json")) continue;
    try {
      const parsed = JSON.parse(readFileSync5(join7(home, "pending", entry), "utf8"));
      if (parsed && typeof parsed === "object" && typeof parsed.sessionId === "string") total += 1;
    } catch {
    }
  }
  return total;
}

// src/lib/status.ts
import { readFileSync as readFileSync6 } from "node:fs";

// src/lib/pipeline.ts
import { basename as basename3, join as join8 } from "node:path";
var STALE_CLAIM_MS = 10 * 60 * 1e3;
function pipelineLogFile(home = handbookHome()) {
  return join8(home, "pipeline.log");
}
var LOG_ROTATE_BYTES = 512 * 1024;

// src/lib/status.ts
function lastPipelineRun(home = handbookHome()) {
  let raw;
  try {
    raw = readFileSync6(pipelineLogFile(home), "utf8");
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

// src/cli/review.ts
function usage() {
  console.error(
    "usage: review.js <list|show <slug>|approve <slug...>|reject <slug...>> [--all] [--never] [--to personal|project|team]"
  );
  process.exit(2);
}
function showCandidate(home, slug) {
  const dir = join9(candidatesDir(home), slug);
  let skillMd;
  try {
    skillMd = readFileSync7(join9(dir, "SKILL.md"), "utf8");
  } catch {
    console.error(`error: no candidate named "${slug}"`);
    process.exit(1);
  }
  const meta = readCandidateMeta(dir);
  const gate = meta?.gate;
  const threshold = meta?.origin === "harvest" ? loadHarvestConfig(home).minScore : loadScoreConfig(home).threshold;
  const kind = meta?.kind ? `  [${meta.kind}]` : "";
  console.log(`candidate: ${slug}${kind}  [scope: ${meta?.scope ?? "?"}]  [status: ${meta?.status ?? "?"}]`);
  console.log(`location:  ${dir}`);
  if (gate) {
    const scores = Object.entries(gate.scores).map(([k, v]) => `${k} ${v}`).join(", ");
    const dissent = gate.total < threshold ? `  \u2014 below the ${threshold}/10 bar` : "";
    console.log(`score:     ${gate.total}/10  (${scores})${dissent}`);
    if (gate.rationale) console.log(`rationale: ${gate.rationale}`);
  } else {
    console.log("score:     n/a");
  }
  if (meta?.suggestedTarget) {
    const where = meta.suggestedTarget === "personal" ? "keep for yourself (~/.claude/skills)" : meta.suggestedTarget === "project" ? "this project's .claude/skills" : "share with the team (PR)";
    console.log(`suggested: ${where}`);
  }
  if (meta?.taughtBefore) {
    console.log(`repeated:  you have told Claude this in ${meta.taughtBefore + 1} sessions`);
  }
  console.log("");
  console.log(skillMd.trimEnd());
  console.log("");
  console.log("\u2500\u2500 grounded case \u2500\u2500");
  try {
    const grounded = JSON.parse(readFileSync7(join9(dir, "grounded-case.json"), "utf8"));
    if (grounded.quote) {
      console.log(`you said:  "${grounded.quote}"`);
    }
    if (grounded.task) {
      console.log(`goal:      ${grounded.task.goal}`);
      (grounded.task.steps ?? []).forEach((s, i) => console.log(`  step ${i + 1}:  ${s}`));
      if (grounded.task.verification) console.log(`verified:  ${grounded.task.verification}`);
    } else if (grounded.command || grounded.error) {
      console.log(`failed:    ${grounded.command}`);
      console.log(`error:     ${String(grounded.error ?? "").split("\n").join("\n           ")}`);
      if (grounded.resolvedCommand) console.log(`resolved:  ${grounded.resolvedCommand}`);
      if (Array.isArray(grounded.edits) && grounded.edits.length) {
        console.log(`edits:     ${grounded.edits.join(", ")}`);
      }
    } else if (!grounded.quote) {
      console.log("(no command/error recorded \u2014 this lesson came from the conversation)");
    }
    if (grounded.expect) console.log(`expect:    ${grounded.expect}`);
  } catch {
    console.log("(this candidate has no grounded case)");
  }
}
function approveOne(home, slug, to) {
  const result = approveAndDeliver(home, slug, void 0, void 0, void 0, void 0, void 0, to);
  if (!result.ok) {
    console.error(`error (${slug}): ${result.error}`);
    return;
  }
  if (result.mode === "team") {
    if (result.prUrl) {
      console.log(`Approved "${slug}" and opened a PR to the team skill base: ${result.prUrl}`);
    } else {
      console.log(`Approved "${slug}" and pushed branch ${result.branch} to the team skill base.`);
      if (result.prError) console.log(`Auto-PR skipped (${result.prError}) \u2014 install/authenticate gh or glab to open PRs automatically.`);
      if (result.manualUrl) console.log(`Open the PR here: ${result.manualUrl}`);
    }
  } else if (result.mode === "personal") {
    console.log(
      `Kept "${slug}" for you at ${result.deliveredTo}. Claude will load it in every project from your next session.`
    );
  } else {
    if (result.warning) console.log(`Note: ${result.warning}`);
    const loads = result.originProject ? `Claude will load it in ${result.originProject} (where it was captured) next session` : "Claude will load it next session";
    console.log(
      `Approved "${slug}" and installed it at ${result.deliveredTo}. ${loads}. Commit this directory so the skill travels with the repo.`
    );
  }
}
function rejectOne(home, slug, never) {
  const result = decideCandidate(home, slug, "rejected", void 0, { mute: never });
  if (!result.ok) {
    console.error(`error (${slug}): ${result.error}`);
    return;
  }
  if (never && result.muted) {
    console.log(`Rejected "${slug}" and muted its fingerprint \u2014 this learning will not be suggested again.`);
  } else if (never) {
    console.log(`Rejected "${slug}", but it has no recorded fingerprint, so it could not be muted.`);
  } else {
    console.log(
      `Rejected "${slug}". If the same learning recurs it may be suggested again; use "reject ${slug} --never" to silence it permanently.`
    );
  }
}
function main() {
  const args = process.argv.slice(2);
  const never = args.includes("--never");
  const all = args.includes("--all");
  const inlineTo = args.find((a) => a.startsWith("--to="));
  const toIndex = args.indexOf("--to");
  const toRaw = inlineTo ? inlineTo.slice("--to=".length) : toIndex !== -1 ? args[toIndex + 1] : void 0;
  const to = toRaw === "personal" || toRaw === "project" || toRaw === "team" ? toRaw : void 0;
  if ((toIndex !== -1 || inlineTo) && !to) usage();
  const positional = args.filter((a, i) => !a.startsWith("--") && (toIndex === -1 || i !== toIndex + 1));
  const [cmd = "list", ...slugArgs] = positional;
  const home = handbookHome();
  if (cmd === "list") {
    const pending = listCandidates(home, "pending");
    console.log(formatCandidateList(pending));
    if (pending.length === 0) {
      const scoring = pendingHarvestCount(home);
      if (scoring > 0) {
        console.log(`(${scoring} session(s) are still being harvested in the background \u2014 try again in a minute.)`);
      } else {
        const reject = lastPipelineRun(home)?.outcomes?.filter((o) => o.outcome === "reject").at(-1);
        if (reject) {
          const score = reject.total !== void 0 ? `${reject.total}/10` : "n/a";
          const why = reject.duplicateOf ? `duplicate of "${reject.duplicateOf}"` : reject.rationale ?? "below the bar";
          console.log(
            `(The most recent capture was scored but didn't clear the gate: ${score} \u2014 ${why}. Nothing is waiting for you.)`
          );
        }
      }
    }
    return;
  }
  if (cmd !== "approve" && cmd !== "reject") {
    if (cmd === "show" && slugArgs[0] && isSafeSlug(slugArgs[0])) {
      showCandidate(home, slugArgs[0]);
      return;
    }
    usage();
  }
  const slugs = all ? listCandidates(home, "pending").map((c) => c.slug) : slugArgs;
  if (slugs.length === 0 || slugs.some((s) => !isSafeSlug(s))) usage();
  for (const slug of slugs) {
    if (cmd === "approve") approveOne(home, slug, to);
    else rejectOne(home, slug, never);
  }
}
main();
