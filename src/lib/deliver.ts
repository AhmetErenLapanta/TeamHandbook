import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
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
  meta?: CandidateMeta;
  deliveredTo?: string;
  error?: string;
}

export function approveAndDeliver(
  home: string = handbookHome(),
  slug: string,
  fallbackCwd: string = process.cwd(),
  decidedAt: string = new Date().toISOString(),
): DeliverResult {
  if (!isSafeSlug(slug)) return { ok: false, error: `invalid candidate name "${slug}"` };
  const dir = join(candidatesDir(home), slug);
  const meta = readCandidateMeta(dir);
  if (!meta) return { ok: false, error: `no candidate named "${slug}"` };
  if (meta.status !== "pending") {
    return { ok: false, meta, error: `candidate "${slug}" is already ${meta.status}` };
  }
  const skillsDir = resolveDeliveryDir(meta, fallbackCwd);
  let target = join(skillsDir, slug);
  for (let i = 2; existsSync(target); i++) {
    target = join(skillsDir, `${slug}-${i}`);
  }
  try {
    mkdirSync(target, { recursive: true });
    copyFileSync(join(dir, "SKILL.md"), join(target, "SKILL.md"));
    if (existsSync(join(dir, "grounded-case.json"))) {
      copyFileSync(join(dir, "grounded-case.json"), join(target, "grounded-case.json"));
    }
  } catch (err) {
    return { ok: false, meta, error: `delivery failed: ${String(err)}` };
  }
  const updated: CandidateMeta = {
    ...meta,
    status: "approved",
    decidedAt,
    deliveredTo: target,
  };
  writeCandidateMeta(dir, updated);
  return { ok: true, meta: updated, deliveredTo: target };
}
