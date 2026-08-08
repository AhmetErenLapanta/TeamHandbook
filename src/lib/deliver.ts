import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { loadTeamConfig, runGit } from "./init.js";
import type { GitRunner, TeamConfig } from "./init.js";
import { publishCandidate, runForge } from "./publish.js";
import type { ForgeRunner } from "./publish.js";
import { handbookHome } from "./session-state.js";
import { candidatesDir } from "./skill-index.js";
import { isSafeSlug, readCandidateMeta, writeCandidateMeta } from "./queue.js";
import type { CandidateMeta } from "./queue.js";

export function soloSkillsDir(projectCwd: string): string {
  return join(projectCwd, ".claude", "skills");
}

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
  mode?: "solo" | "team";
  meta?: CandidateMeta;
  deliveredTo?: string;
  branch?: string;
  prUrl?: string;
  manualUrl?: string;
  error?: string;
}

export function approveAndDeliver(
  home: string = handbookHome(),
  slug: string,
  fallbackCwd: string = process.cwd(),
  decidedAt: string = new Date().toISOString(),
  team: TeamConfig | null = loadTeamConfig(home),
  git: GitRunner = runGit,
  forge: ForgeRunner = runForge,
): DeliverResult {
  if (!isSafeSlug(slug)) return { ok: false, error: `invalid candidate name "${slug}"` };
  const dir = join(candidatesDir(home), slug);
  const meta = readCandidateMeta(dir);
  if (!meta) return { ok: false, error: `no candidate named "${slug}"` };
  if (meta.status !== "pending") {
    return { ok: false, meta, error: `candidate "${slug}" is already ${meta.status}` };
  }
  if (team) return deliverToTeam(dir, meta, team, decidedAt, git, forge);
  return deliverSolo(dir, meta, fallbackCwd, decidedAt);
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
  const updated: CandidateMeta = { ...meta, status: "approved", decidedAt, deliveredTo };
  writeCandidateMeta(dir, updated);
  return {
    ok: true,
    mode: "team",
    meta: updated,
    deliveredTo,
    branch: published.branch,
    prUrl: published.prUrl,
    manualUrl: published.manualUrl,
  };
}

function deliverSolo(
  dir: string,
  meta: CandidateMeta,
  fallbackCwd: string,
  decidedAt: string,
): DeliverResult {
  const skillsDir = resolveDeliveryDir(meta, fallbackCwd);
  let target = join(skillsDir, meta.slug);
  for (let i = 2; existsSync(target); i++) {
    target = join(skillsDir, `${meta.slug}-${i}`);
  }
  try {
    mkdirSync(target, { recursive: true });
    copyFileSync(join(dir, "SKILL.md"), join(target, "SKILL.md"));
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
  };
  writeCandidateMeta(dir, updated);
  return { ok: true, mode: "solo", meta: updated, deliveredTo: target };
}
