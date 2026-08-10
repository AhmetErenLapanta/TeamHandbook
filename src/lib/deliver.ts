import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { loadTeamConfig, runGit } from "./init.js";
import type { GitRunner, TeamConfig } from "./init.js";
import { renameSkillMd, uniqueSlug } from "./distill.js";
import { publishCandidate, runForge } from "./publish.js";
import type { ForgeRunner } from "./publish.js";
import { handbookHome } from "./session-state.js";
import { candidatesDir } from "./skill-index.js";
import { isSafeSlug, readCandidateMeta, writeCandidateMeta } from "./queue.js";
import type { CandidateMeta } from "./queue.js";

export function soloSkillsDir(projectCwd: string): string {
  return join(projectCwd, ".claude", "skills");
}

/** User-level skills: Claude Code loads these in every project. The "keep it for
 * yourself" home for general lessons. */
export function personalSkillsDir(): string {
  return join(homedir(), ".claude", "skills");
}

export type DeliveryTarget = "personal" | "project" | "team";

export function resolveDeliveryDir(
  meta: CandidateMeta,
  fallbackCwd: string,
  dirExists: (path: string) => boolean = existsSync,
): string {
  const origin = meta.cwd && dirExists(meta.cwd) ? meta.cwd : fallbackCwd;
  return soloSkillsDir(origin);
}

export interface DeliverResult {
  ok: boolean;
  mode?: "solo" | "personal" | "team";
  meta?: CandidateMeta;
  deliveredTo?: string;
  branch?: string;
  prUrl?: string;
  manualUrl?: string;
  error?: string;
  // set when solo delivery could not use the origin project and fell back to cwd
  warning?: string;
  // set when solo delivery landed in a DIFFERENT project than the current one (the
  // skill was captured elsewhere) — so the "loads next session" claim can name where
  originProject?: string;
  // why a team PR could not be auto-opened (the branch is pushed; link is manual)
  prError?: string;
}

export function approveAndDeliver(
  home: string = handbookHome(),
  slug: string,
  fallbackCwd: string = process.cwd(),
  decidedAt: string = new Date().toISOString(),
  team: TeamConfig | null = loadTeamConfig(home),
  git: GitRunner = runGit,
  forge: ForgeRunner = runForge,
  target?: DeliveryTarget,
  personalDir: string = personalSkillsDir(),
): DeliverResult {
  if (!isSafeSlug(slug)) return { ok: false, error: `invalid candidate name "${slug}"` };
  const dir = join(candidatesDir(home), slug);
  const meta = readCandidateMeta(dir);
  if (!meta) return { ok: false, error: `no candidate named "${slug}"` };
  if (meta.status !== "pending") {
    return { ok: false, meta, error: `candidate "${slug}" is already ${meta.status}` };
  }
  // The per-skill decision: an explicit --to wins, then the harvest's suggestion,
  // then the legacy default (team when configured, else the project).
  const resolved: DeliveryTarget = target ?? meta.suggestedTarget ?? (team ? "team" : "project");
  if (resolved === "team") {
    if (!team) {
      return {
        ok: false,
        meta,
        error: "no team configured — run /handbook:init or /handbook:join first, or approve with --to personal",
      };
    }
    return deliverToTeam(dir, meta, team, decidedAt, git, forge);
  }
  if (resolved === "personal") return deliverPersonal(dir, meta, decidedAt, personalDir);
  return deliverSolo(dir, meta, fallbackCwd, decidedAt);
}

/** Install into the user-level skills dir: available in every project, only for
 * this user. No origin-project logic — personal skills follow the person. */
export function deliverPersonal(
  dir: string,
  meta: CandidateMeta,
  decidedAt: string,
  skillsDir: string = personalSkillsDir(),
): DeliverResult {
  const slug = uniqueSlug(meta.slug, (s) => existsSync(join(skillsDir, s)));
  const target = join(skillsDir, slug);
  try {
    const skillMd = readFileSync(join(dir, "SKILL.md"), "utf8");
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "SKILL.md"), slug === meta.slug ? skillMd : renameSkillMd(skillMd, slug));
    if (existsSync(join(dir, "grounded-case.json"))) {
      copyFileSync(join(dir, "grounded-case.json"), join(target, "grounded-case.json"));
    }
  } catch (err) {
    return { ok: false, mode: "personal", meta, error: `delivery failed: ${String(err)}` };
  }
  const updated: CandidateMeta = {
    ...meta,
    status: "approved",
    decidedAt,
    deliveredTo: target,
    deliveredMode: "personal",
  };
  writeCandidateMeta(dir, updated);
  return { ok: true, mode: "personal", meta: updated, deliveredTo: target };
}

function deliverToTeam(
  dir: string,
  meta: CandidateMeta,
  team: TeamConfig,
  decidedAt: string,
  git: GitRunner,
  forge: ForgeRunner,
): DeliverResult {
  const published = publishCandidate(dir, meta, team, git, forge);
  if (!published.ok) return { ok: false, mode: "team", meta, error: published.error };
  const deliveredTo = published.prUrl ?? `${team.repoUrl} (branch ${published.branch})`;
  const updated: CandidateMeta = { ...meta, status: "approved", decidedAt, deliveredTo, deliveredMode: "team" };
  writeCandidateMeta(dir, updated);
  return {
    ok: true,
    mode: "team",
    meta: updated,
    deliveredTo,
    branch: published.branch,
    prUrl: published.prUrl,
    manualUrl: published.manualUrl,
    ...(published.prError ? { prError: published.prError } : {}),
  };
}

function deliverSolo(
  dir: string,
  meta: CandidateMeta,
  fallbackCwd: string,
  decidedAt: string,
): DeliverResult {
  // Surface a fall-back honestly: installing into the wrong project silently is
  // worse than a warning the reviewer can act on.
  const originGone = !!meta.cwd && !existsSync(meta.cwd);
  const noOrigin = !meta.cwd;
  const skillsDir = resolveDeliveryDir(meta, fallbackCwd);
  const warning =
    originGone || noOrigin
      ? `origin project ${meta.cwd ? `"${meta.cwd}" no longer exists` : "was not recorded"}; installed into the current project instead (${skillsDir})`
      : undefined;
  // The skill installs into the project where it was captured. If that is not the
  // project the reviewer is in right now, name it — otherwise "loads next session"
  // is false for the session they will actually open.
  const installedProject = meta.cwd && existsSync(meta.cwd) ? meta.cwd : fallbackCwd;
  const originProject = installedProject !== fallbackCwd ? basename(installedProject) : undefined;
  const slug = uniqueSlug(meta.slug, (s) => existsSync(join(skillsDir, s)));
  const target = join(skillsDir, slug);
  try {
    // read before creating the target: an unreadable candidate must not leave an
    // empty skill dir behind (which would shift every future slug to -2)
    const skillMd = readFileSync(join(dir, "SKILL.md"), "utf8");
    mkdirSync(target, { recursive: true });
    // rewrite the frontmatter name when suffixed so it doesn't shadow the skill it collided with
    writeFileSync(join(target, "SKILL.md"), slug === meta.slug ? skillMd : renameSkillMd(skillMd, slug));
    if (existsSync(join(dir, "grounded-case.json"))) {
      copyFileSync(join(dir, "grounded-case.json"), join(target, "grounded-case.json"));
    }
  } catch (err) {
    return { ok: false, mode: "solo", meta, error: `delivery failed: ${String(err)}` };
  }
  const updated: CandidateMeta = {
    ...meta,
    status: "approved",
    decidedAt,
    deliveredTo: target,
    deliveredMode: "solo",
  };
  writeCandidateMeta(dir, updated);
  return {
    ok: true,
    mode: "solo",
    meta: updated,
    deliveredTo: target,
    ...(warning ? { warning } : {}),
    ...(originProject ? { originProject } : {}),
  };
}
