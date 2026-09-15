import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { handbookHome } from "./session-state.js";
import { writeFileAtomic } from "./fs-atomic.js";
import { candidatesDir, parseSkillFrontmatter } from "./skill-index.js";
import { detectSecret } from "./secrets.js";
import { copySkillPayload, listSkillFiles } from "./skill-files.js";
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
  deliveredMode?: "solo" | "personal" | "team";
  // how this candidate came to exist and what it is — drives the review wording
  origin?: "harvest" | "manual" | "recurrence";
  kind?: "procedure" | "correction" | "error-fix" | "discovery";
  // default answer to "keep it, or share it?" — derived from scope + team config
  suggestedTarget?: "personal" | "project" | "team";
  // how many sessions this lesson was taught in before the one that produced it —
  // the "you have said this twice" evidence, absent when it is the first time
  taughtBefore?: number;
}

const STATUSES: CandidateStatus[] = ["pending", "approved", "rejected"];

export function isSafeSlug(slug: string): boolean {
  return /^[a-z0-9][a-z0-9-]*$/.test(slug);
}

export function candidateMetaFile(dir: string): string {
  return join(dir, "candidate.json");
}

export function writeCandidateMeta(dir: string, meta: CandidateMeta): void {
  // atomic: a torn candidate.json would make readCandidateMeta fall back to a
  // synthesized "pending" meta, resurrecting an already-decided candidate
  writeFileAtomic(candidateMetaFile(dir), JSON.stringify(meta, null, 2) + "\n");
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
      // the slug is the directory, and createdAt is normalized here rather than
      // trusted: it is sorted on, so one hand-edited or older-schema file without
      // it would take down every command that lists the queue
      return {
        ...parsed,
        slug: basename(dir),
        createdAt: typeof parsed.createdAt === "string" ? parsed.createdAt : "",
      };
    }
  } catch {
    // fall through to synthesis from the artifact files
  }
  return synthesizeMeta(dir);
}

export interface IntakeResult {
  ok: boolean;
  slug?: string;
  dir?: string;
  /** how many files were taken in, so the caller can say the extras came along */
  fileCount?: number;
  error?: string;
  /** set when the secret sieve is what refused the skill: the pattern, and where */
  secret?: { pattern: string; file: string };
}

/**
 * Take a skill somebody wrote by hand into the review queue.
 *
 * Until this existed, a hand-written skill had no route to a team at all: the queue was
 * reachable only by re-living the lesson and hoping the harvest caught it. From here the
 * existing chain takes over unchanged - /handbook:review, approveAndDeliver, and for the
 * team answer publishCandidate. No candidate.json is written on purpose, so the meta is
 * synthesized from the frontmatter by readCandidateMeta, and the review flow sees an
 * ordinary pending candidate.
 *
 * The secret sieve has to be re-established here, and this is the load-bearing part of
 * the function. The harvest reaches the queue through pipeline.ts, which runs
 * signalSecret over every captured field before a candidate is ever written. A directory
 * copied straight into candidatesDir() never passes that point, so this is the second
 * door into the pending queue and it needs its own lock: no captured secret reaches the
 * queue, a candidate, or a PR.
 *
 * It refuses rather than redacts. Redaction is the right answer for a transcript slice,
 * where the lesson survives losing a token. It is the wrong answer for a skill: a blanked
 * out reference file or a pruned script still installs, still reads as complete to the
 * teammate who receives it, and fails only when they run it. A skill that never arrives
 * is better than a skill that arrives hollow, so the whole intake stops and names the
 * file, which is the one thing that lets the author fix it.
 *
 * Every file that would be copied is screened first, and the screened list is the list
 * that gets copied. Screening file by file as they are copied would leave the files that
 * sort earlier sitting in the queue when a later one trips the sieve.
 */
export function intakeSkill(sourceDir: string, home: string = handbookHome()): IntakeResult {
  const slug = basename(sourceDir);
  if (!isSafeSlug(slug)) {
    return { ok: false, error: `"${slug}" cannot be a skill name (lowercase letters, digits and dashes)` };
  }
  let skillMd: string;
  try {
    skillMd = readFileSync(join(sourceDir, "SKILL.md"), "utf8");
  } catch {
    return { ok: false, error: `no readable SKILL.md in ${sourceDir}` };
  }
  if (!parseSkillFrontmatter(skillMd)) {
    return { ok: false, error: `the SKILL.md in ${sourceDir} has no name and description frontmatter` };
  }
  const dir = join(candidatesDir(home), slug);
  if (existsSync(dir)) {
    // Overwriting would silently discard a decision already made about that slug: an
    // approved candidate keeps its meta here, and rewriting it would offer a delivered
    // skill for review a second time. A decided one is named as decided, because
    // "waiting in the review queue" would send the user to look for something
    // /handbook:review will not show them.
    const existing = readCandidateMeta(dir);
    const decided = existing && existing.status !== "pending" ? existing.status : null;
    return {
      ok: false,
      error: decided
        ? `"${slug}" was already ${decided} here; nothing was changed`
        : `"${slug}" is already waiting in the review queue`,
    };
  }
  const { files, skipped } = listSkillFiles(sourceDir);
  if (skipped.length > 0) {
    // A symlink cannot be screened for what it will resolve to at copy time, and
    // dropping it quietly is the pruning this card exists to stop. Neither is allowed,
    // so the skill is refused with the entry named.
    return {
      ok: false,
      error: `${slug} contains "${skipped[0]}", which is not a regular file; nothing was queued`,
    };
  }
  if (files.length === 0) {
    return { ok: false, error: `${slug} has no files to queue` };
  }
  for (const file of files) {
    let content: string;
    try {
      content = readFileSync(join(sourceDir, file), "utf8");
    } catch {
      // unreadable means unscreened, and unscreened must not ship
      return { ok: false, error: `cannot read "${file}" in ${sourceDir}; nothing was queued` };
    }
    const pattern = detectSecret(content);
    if (pattern) {
      return {
        ok: false,
        secret: { pattern, file },
        error:
          `"${file}" looks like it contains a secret (${pattern}), so ${slug} was not queued. ` +
          `Skills are reviewed and shared as they are, and a redacted one would install and then ` +
          `fail; take the credential out of the skill and try again.`,
      };
    }
  }
  copySkillPayload(sourceDir, dir, skillMd, files);
  return { ok: true, slug, dir, fileCount: files.length };
}

/**
 * Amend a candidate only while it is still pending. The harvest runs in a background
 * process, so between reading the queue and writing to it the user may have approved
 * the very candidate a fresh notice told them to review — and a blind write would
 * reinstate the meta as read: pending again, with the delivery it was approved to
 * erased. Re-read at the last moment, the same guard decideCandidate uses.
 */
export function patchPendingCandidate(
  home: string,
  slug: string,
  patch: Partial<CandidateMeta>,
): boolean {
  const dir = join(candidatesDir(home), slug);
  const current = readCandidateMeta(dir);
  if (!current || current.status !== "pending") return false;
  writeCandidateMeta(dir, { ...current, ...patch });
  return true;
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
  // newest first — the most recently captured lesson is the most relevant to review
  return filtered.sort(
    (a, b) => b.createdAt.localeCompare(a.createdAt) || a.slug.localeCompare(b.slug),
  );
}

function relativeAge(iso: string, now: number): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "unknown age";
  const mins = Math.max(0, Math.round((now - then) / 60000));
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function originProject(meta: CandidateMeta): string {
  if (!meta.cwd) return "unknown project";
  return meta.cwd.split("/").filter(Boolean).pop() ?? meta.cwd;
}

export interface DecideResult {
  ok: boolean;
  meta?: CandidateMeta;
  error?: string;
  /** true only when a mute was requested AND actually recorded */
  muted?: boolean;
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
  let muted = false;
  if (status === "rejected" && options.mute && meta.fingerprint) {
    muteFingerprint(meta.fingerprint, home);
    muted = true;
  }
  return { ok: true, meta: updated, muted };
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

export function formatCandidateList(metas: CandidateMeta[], now: number = Date.now()): string {
  if (metas.length === 0) return "No pending candidates.";
  const lines = [`Pending candidates (${metas.length}), newest first:`, ""];
  metas.forEach((meta, i) => {
    const gate = meta.gate ? `gate ${meta.gate.total}/10` : "gate n/a";
    const kind = meta.kind ? `[${meta.kind}]  ` : "";
    lines.push(
      `  ${i + 1}. ${meta.slug}  ${kind}[${meta.scope}]  ${gate}  ·  ${relativeAge(meta.createdAt, now)}  ·  from ${originProject(meta)}`,
    );
    lines.push(`     ${meta.description}`);
  });
  return lines.join("\n");
}
