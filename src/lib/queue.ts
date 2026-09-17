import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { handbookHome } from "./session-state.js";
import { writeFileAtomic } from "./fs-atomic.js";
import { candidatesDir, parseSkillFrontmatter } from "./skill-index.js";
import type { SkillSummary } from "./skill-index.js";
import { detectSecret } from "./secrets.js";
import { copySkillPayload, listSkillFiles } from "./skill-files.js";
import type { SkillArtifact } from "./distill.js";
import type { GateVerdict } from "./score.js";

// "archived" is a queue state, not a verdict: the developer never looked at these.
// It exists so a queue that grew past reading can be shrunk to the handful still
// worth a decision, and it is reversible by design - see the archive manifest below.
export type CandidateStatus = "pending" | "approved" | "rejected" | "archived";

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
  // written together when a candidate is archived and both removed on restore, so a
  // restored meta matches its pre-archive snapshot field for field
  archivedAt?: string;
  archiveReason?: string;
}

// Every status readCandidateMeta will accept. Leaving one out does not hide the
// candidates carrying it - the parse below rejects the file, synthesizeMeta rebuilds
// it as "pending", and gate/taughtBefore/sessionId/suggestedTarget are lost with it.
// So writing an unlisted status resurrects a candidate stripped of its evidence
// instead of quieting it, which is the one failure archiving must not have.
const STATUSES: CandidateStatus[] = ["pending", "approved", "rejected", "archived"];

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

export type SkillRefusal =
  | "unsafe-name"
  | "no-skill-md"
  | "no-frontmatter"
  | "irregular-entry"
  | "no-files"
  | "unreadable"
  | "secret";

export interface SkillAudit {
  shareable: boolean;
  reason?: SkillRefusal;
  /** the entry, file or pattern name the refusal is about, so the author knows what to fix */
  detail?: string;
  /** only on a clean audit: the text read, and the exact file list that was screened */
  skillMd?: string;
  files?: string[];
  /** the frontmatter this directory parsed as, which a listing shows instead of re-reading it */
  summary?: SkillSummary;
  secret?: { pattern: string; file: string };
}

/**
 * Everything that can be decided about a skill directory by reading it, and nothing
 * that depends on the queue.
 *
 * It exists because there are now two callers and they must not drift: intakeSkill
 * enforces this, and the inventory screen previews it. A screen that decided
 * shareability with its own copy of the rules would eventually offer a skill the
 * enforcing path refuses - or, far worse, stop offering one it would have accepted and
 * then grow a shortcut past the sieve to "fix" that. The sieve runs here, once, and the
 * list it cleared is the list the caller copies.
 */
export function auditSkillDir(sourceDir: string): SkillAudit {
  const name = basename(sourceDir);
  if (!isSafeSlug(name)) return { shareable: false, reason: "unsafe-name", detail: name };
  let skillMd: string;
  try {
    skillMd = readFileSync(join(sourceDir, "SKILL.md"), "utf8");
  } catch {
    return { shareable: false, reason: "no-skill-md" };
  }
  const summary = parseSkillFrontmatter(skillMd);
  if (!summary) return { shareable: false, reason: "no-frontmatter" };
  const { files, skipped } = listSkillFiles(sourceDir);
  if (skipped.length > 0) {
    // A symlink cannot be screened for what it will resolve to at copy time, and
    // dropping it quietly is the pruning this guard exists to stop. Neither is allowed, so the
    // skill is refused with the entry named.
    return { shareable: false, reason: "irregular-entry", detail: skipped[0] };
  }
  if (files.length === 0) return { shareable: false, reason: "no-files" };
  for (const file of files) {
    let content: string;
    try {
      content = readFileSync(join(sourceDir, file), "utf8");
    } catch {
      // unreadable means unscreened, and unscreened must not ship
      return { shareable: false, reason: "unreadable", detail: file };
    }
    const pattern = detectSecret(content);
    if (pattern) {
      return { shareable: false, reason: "secret", detail: pattern, secret: { pattern, file } };
    }
  }
  return { shareable: true, skillMd, files, summary };
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
  const dir = join(candidatesDir(home), slug);
  // Ahead of the audit because it is the cheapest refusal and, on a machine with a full
  // queue, by far the commonest: a batch of twenty skills should not read every file of
  // the fifteen that are already waiting to find that out.
  if (isSafeSlug(slug) && existsSync(dir)) {
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
  const audit = auditSkillDir(sourceDir);
  if (!audit.shareable) {
    return {
      ok: false,
      ...(audit.secret ? { secret: audit.secret } : {}),
      error: intakeRefusal(sourceDir, slug, audit),
    };
  }
  copySkillPayload(sourceDir, dir, audit.skillMd!, audit.files!);
  return { ok: true, slug, dir, fileCount: audit.files!.length };
}

function intakeRefusal(sourceDir: string, slug: string, audit: SkillAudit): string {
  switch (audit.reason) {
    case "unsafe-name":
      return `"${slug}" cannot be a skill name (lowercase letters, digits and dashes)`;
    case "no-skill-md":
      return `no readable SKILL.md in ${sourceDir}`;
    case "no-frontmatter":
      return `the SKILL.md in ${sourceDir} has no name and description frontmatter`;
    case "irregular-entry":
      return `${slug} contains "${audit.detail}", which is not a regular file; nothing was queued`;
    case "no-files":
      return `${slug} has no files to queue`;
    case "unreadable":
      return `cannot read "${audit.detail}" in ${sourceDir}; nothing was queued`;
    default:
      return (
        `"${audit.secret?.file}" looks like it contains a secret (${audit.detail}), so ${slug} was ` +
        `not queued. Skills are reviewed and shared as they are, and a redacted one would install ` +
        `and then fail; take the credential out of the skill and try again.`
      );
  }
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

/**
 * A queue that grew past reading is not a review queue. Archiving moves a candidate
 * out of the pending list without deciding it: the directory stays where it is, the
 * artifact is untouched, and only the status line changes. It is deliberately NOT a
 * rejection - it records no verdict and never mutes the fingerprint, because nobody
 * looked at these and silencing a lesson the developer never saw is not reversible
 * in the way the archive is.
 */
export interface ArchiveEntry {
  slug: string;
  // what the candidate must go back to on restore. Only "pending" can reach here
  // today, but the entry carries it rather than assuming it.
  previousStatus: CandidateStatus;
  archivedAt: string;
  reason: string;
}

export interface ArchiveManifest {
  sweptAt: string;
  reason: string;
  entries: ArchiveEntry[];
}

export interface ArchiveResult {
  ok: boolean;
  entry?: ArchiveEntry;
  error?: string;
}

export function archiveCandidate(
  home: string,
  slug: string,
  reason: string,
  archivedAt: string = new Date().toISOString(),
): ArchiveResult {
  if (!isSafeSlug(slug)) return { ok: false, error: `invalid candidate name "${slug}"` };
  const dir = join(candidatesDir(home), slug);
  const meta = readCandidateMeta(dir);
  if (!meta) return { ok: false, error: `no candidate named "${slug}"` };
  // Pending only, and that includes already-archived: archiving twice would record
  // "archived" as the status to restore to, and the candidate could never come back.
  // An approved candidate has already been installed somewhere; hiding it here would
  // leave the queue disagreeing with the skill on disk.
  if (meta.status !== "pending") {
    return { ok: false, error: `candidate "${slug}" is ${meta.status}, not pending` };
  }
  // no decidedAt: archiving is not a decision the developer made, and the restored
  // meta has to match the pre-archive snapshot exactly
  writeCandidateMeta(dir, { ...meta, status: "archived", archivedAt, archiveReason: reason });
  return { ok: true, entry: { slug, previousStatus: meta.status, archivedAt, reason } };
}

export function archivesDir(home: string = handbookHome()): string {
  return join(home, "archives");
}

/**
 * Every archiving run writes one of these. It is not a log: it is the undo. Putting
 * 151 candidates back by hand is not an option a person would take, so without a
 * manifest "the archive is reversible" would be a claim nobody could act on - and
 * that reversibility is the whole reason archiving needs no approval.
 */
export function writeArchiveManifest(home: string, manifest: ArchiveManifest): string {
  const dir = archivesDir(home);
  mkdirSync(dir, { recursive: true });
  // the timestamp is the file name, so manifests sort chronologically by name
  const file = join(dir, `${manifest.sweptAt.replace(/[:.]/g, "-")}.json`);
  writeFileAtomic(file, JSON.stringify(manifest, null, 2) + "\n");
  return file;
}

export function readArchiveManifest(file: string): ArchiveManifest | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
  const m = parsed as Partial<ArchiveManifest>;
  if (typeof m?.sweptAt !== "string" || !Array.isArray(m.entries)) return null;
  const entries = m.entries.filter(
    (e): e is ArchiveEntry =>
      typeof e?.slug === "string" && STATUSES.includes(e?.previousStatus as CandidateStatus),
  );
  return { sweptAt: m.sweptAt, reason: typeof m.reason === "string" ? m.reason : "", entries };
}

/** Manifest files, oldest first; the last one is the most recent run. */
export function listArchiveManifests(home: string = handbookHome()): string[] {
  try {
    return readdirSync(archivesDir(home))
      .filter((f) => f.endsWith(".json"))
      .sort()
      .map((f) => join(archivesDir(home), f));
  } catch {
    return [];
  }
}

export interface RestoreResult {
  restored: string[];
  skipped: { slug: string; reason: string }[];
}

/** Put a manifest's candidates back exactly as they were before it ran. */
export function restoreArchived(home: string, manifest: ArchiveManifest): RestoreResult {
  const result: RestoreResult = { restored: [], skipped: [] };
  for (const entry of manifest.entries) {
    if (!isSafeSlug(entry.slug)) {
      result.skipped.push({ slug: entry.slug, reason: "invalid candidate name" });
      continue;
    }
    const dir = join(candidatesDir(home), entry.slug);
    const meta = readCandidateMeta(dir);
    if (!meta) {
      result.skipped.push({ slug: entry.slug, reason: "no longer in the queue" });
      continue;
    }
    if (meta.status !== "archived") {
      result.skipped.push({ slug: entry.slug, reason: `already ${meta.status}` });
      continue;
    }
    // drop the keys rather than blanking them: a restored candidate has to be
    // indistinguishable from one that was never archived
    const { archivedAt: _archivedAt, archiveReason: _archiveReason, ...rest } = meta;
    writeCandidateMeta(dir, { ...rest, status: entry.previousStatus });
    result.restored.push(entry.slug);
  }
  return result;
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

export function formatCandidateList(
  metas: CandidateMeta[],
  now: number = Date.now(),
  label = "Pending",
): string {
  if (metas.length === 0) return `No ${label.toLowerCase()} candidates.`;
  const lines = [`${label} candidates (${metas.length}), newest first:`, ""];
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
