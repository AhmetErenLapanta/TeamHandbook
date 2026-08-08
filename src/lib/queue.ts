import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { handbookHome } from "./session-state.js";
import { writeFileAtomic } from "./fs-atomic.js";
import { candidatesDir, parseSkillFrontmatter } from "./skill-index.js";
import type { SkillArtifact } from "./distill.js";
import type { GateVerdict } from "./score.js";

export type CandidateStatus = "pending" | "approved" | "rejected";

export interface CandidateMeta {
  slug: string;
  status: CandidateStatus;
  createdAt: string;
  scope: string;
  description: string;
  fingerprint: string;
  sessionId: string;
  cwd?: string;
  gate: { total: number; scores: Record<string, number>; rationale?: string } | null;
  decidedAt?: string;
  deliveredTo?: string;
}

const STATUSES: CandidateStatus[] = ["pending", "approved", "rejected"];

export function isSafeSlug(slug: string): boolean {
  return /^[a-z0-9][a-z0-9-]*$/.test(slug);
}

export function candidateMetaFile(dir: string): string {
  return join(dir, "candidate.json");
}

export function writeCandidateMeta(dir: string, meta: CandidateMeta): void {
  writeFileSync(candidateMetaFile(dir), JSON.stringify(meta, null, 2) + "\n");
}

export function candidateMetaFromArtifact(
  slug: string,
  artifact: SkillArtifact,
  verdict: GateVerdict,
  createdAt: string,
): CandidateMeta {
  return {
    slug,
    status: "pending",
    createdAt,
    scope: artifact.scope,
    description: parseSkillFrontmatter(artifact.skillMd)?.description ?? "",
    fingerprint: artifact.groundedCase.fingerprint,
    sessionId: verdict.signal.sessionId,
    cwd: verdict.signal.cwd,
    gate: verdict.result
      ? {
          total: verdict.result.total,
          scores: verdict.result.scores,
          ...(verdict.result.rationale ? { rationale: verdict.result.rationale } : {}),
        }
      : null,
  };
}

function synthesizeMeta(dir: string): CandidateMeta | null {
  let md: string;
  try {
    md = readFileSync(join(dir, "SKILL.md"), "utf8");
  } catch {
    return null;
  }
  const summary = parseSkillFrontmatter(md);
  if (!summary) return null;
  let grounded: { fingerprint?: unknown; capturedAt?: unknown; gate?: unknown } = {};
  try {
    grounded = JSON.parse(readFileSync(join(dir, "grounded-case.json"), "utf8"));
  } catch {
    // a candidate without its grounded case is still reviewable
  }
  const gate = grounded.gate as CandidateMeta["gate"] | undefined;
  return {
    slug: basename(dir),
    status: "pending",
    createdAt: typeof grounded.capturedAt === "string" ? grounded.capturedAt : "",
    scope: summary.scope ?? "team",
    description: summary.description,
    fingerprint: typeof grounded.fingerprint === "string" ? grounded.fingerprint : "",
    sessionId: "",
    gate: gate && typeof gate.total === "number" ? gate : null,
  };
}

export function readCandidateMeta(dir: string): CandidateMeta | null {
  try {
    const parsed = JSON.parse(readFileSync(candidateMetaFile(dir), "utf8"));
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      STATUSES.includes(parsed.status) &&
      typeof parsed.description === "string" &&
      typeof parsed.scope === "string"
    ) {
      return { ...parsed, slug: basename(dir) };
    }
  } catch {
    // fall through to synthesis from the artifact files
  }
  return synthesizeMeta(dir);
}

export function listCandidates(
  home: string = handbookHome(),
  status?: CandidateStatus,
): CandidateMeta[] {
  const base = candidatesDir(home);
  let entries: { name: string; isDirectory(): boolean }[];
  try {
    entries = readdirSync(base, { withFileTypes: true });
  } catch {
    return [];
  }
  const metas = entries
    .filter((e) => e.isDirectory())
    .map((e) => readCandidateMeta(join(base, e.name)))
    .filter((m): m is CandidateMeta => m !== null);
  const filtered = status ? metas.filter((m) => m.status === status) : metas;
  return filtered.sort(
    (a, b) => a.createdAt.localeCompare(b.createdAt) || a.slug.localeCompare(b.slug),
  );
}

export interface DecideResult {
  ok: boolean;
  meta?: CandidateMeta;
  error?: string;
}

export function decideCandidate(
  home: string,
  slug: string,
  status: "approved" | "rejected",
  decidedAt: string = new Date().toISOString(),
  options: { mute?: boolean } = {},
): DecideResult {
  if (!isSafeSlug(slug)) return { ok: false, error: `invalid candidate name "${slug}"` };
  const dir = join(candidatesDir(home), slug);
  const meta = readCandidateMeta(dir);
  if (!meta) return { ok: false, error: `no candidate named "${slug}"` };
  if (meta.status !== "pending") {
    return { ok: false, meta, error: `candidate "${slug}" is already ${meta.status}` };
  }
  const updated: CandidateMeta = { ...meta, status, decidedAt };
  writeCandidateMeta(dir, updated);
  if (status === "rejected" && options.mute && meta.fingerprint) {
    muteFingerprint(meta.fingerprint, home);
  }
  return { ok: true, meta: updated };
}

// A plain rejection does NOT suppress future recurrences — changing your mind (or
// misclicking) must stay possible. Only an explicit "don't suggest this again"
// adds the fingerprint here, and the sieve then drops automatic recurrences.
export function mutedFile(home: string = handbookHome()): string {
  return join(home, "muted.json");
}

export function loadMutedFingerprints(home: string = handbookHome()): Set<string> {
  try {
    const parsed = JSON.parse(readFileSync(mutedFile(home), "utf8"));
    if (Array.isArray(parsed)) return new Set(parsed.filter((f) => typeof f === "string"));
  } catch {
    // nothing muted yet
  }
  return new Set();
}

export function muteFingerprint(fingerprint: string, home: string = handbookHome()): void {
  const muted = loadMutedFingerprints(home);
  muted.add(fingerprint);
  writeFileAtomic(mutedFile(home), JSON.stringify([...muted].sort(), null, 2) + "\n");
}

export function formatCandidateList(metas: CandidateMeta[]): string {
  if (metas.length === 0) return "No pending candidates.";
  const lines = [`Pending candidates (${metas.length}):`, ""];
  metas.forEach((meta, i) => {
    const gate = meta.gate ? `gate ${meta.gate.total}/10` : "gate n/a";
    lines.push(`  ${i + 1}. ${meta.slug}  [${meta.scope}]  ${gate}`);
    lines.push(`     ${meta.description}`);
  });
  return lines.join("\n");
}
