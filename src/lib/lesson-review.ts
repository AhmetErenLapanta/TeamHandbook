import { readFileSync } from "node:fs";
import { join } from "node:path";
import { approveAndDeliver, deliverPersonal } from "./deliver.js";
import type { DeliverResult, DeliveryOptions } from "./deliver.js";
import type { HostIdentity } from "./identity.js";
import { decideCandidate, isSafeSlug, listCandidates, secretInSkillDir } from "./queue.js";
import type { CandidateMeta, DecideResult } from "./queue.js";
import { detectSecret } from "./secrets.js";
import { candidatesDir } from "./skill-index.js";

// What the orchestrator's "Lessons to review" list does with the plugin's whole pending queue: the
// same queue /handbook:review reads, decided with the same functions, so nothing here is a second
// writer. Every function takes the queue's home and defaults none of it.

export interface PendingLesson {
  slug: string;
  description: string;
  origin: NonNullable<CandidateMeta["origin"]>;
  sessionId: string;
  createdAt: string;
  firstLine: string;
}

const FIRST_LINE_CHARS = 200;

// A candidate with a demo mark belongs to the demo's scratch repository alone, so it is not offered here.
const reviewable = (home: string) => listCandidates(home, "pending").filter((m) => !m.demo);

function firstLineOf(skillMd: string): string {
  const body = skillMd.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
  const line = body.split("\n").map((l) => l.replace(/^#+\s*/, "").trim()).find((l) => l !== "") ?? "";
  if (detectSecret(line)) return "(withheld: it looks like it holds a credential)";
  return line.length > FIRST_LINE_CHARS ? `${line.slice(0, FIRST_LINE_CHARS).trimEnd()}...` : line;
}

function skillMdOf(home: string, slug: string): string | null {
  try {
    return readFileSync(join(candidatesDir(home), slug, "SKILL.md"), "utf8");
  } catch {
    return null;
  }
}

/** One page of the pending queue, newest first, with the total so the list can say how many more there are. */
export function pendingLessons(home: string, offset: number, limit: number): { total: number; items: PendingLesson[] } {
  const all = reviewable(home);
  const items = all.slice(offset, offset + limit).map((m) => ({
    slug: m.slug,
    description: m.description,
    origin: m.origin ?? "harvest",
    sessionId: m.sessionId,
    createdAt: m.createdAt,
    firstLine: firstLineOf(skillMdOf(home, m.slug) ?? ""),
  }));
  return { total: all.length, items };
}

export function pendingLesson(home: string, slug: string): { meta: CandidateMeta; skillMd: string; quote: string | null } | null {
  const meta = isSafeSlug(slug) ? reviewable(home).find((m) => m.slug === slug) : undefined;
  const skillMd = meta ? skillMdOf(home, slug) : null;
  if (!meta || skillMd === null) return null;
  let quote: string | null = null;
  try {
    const grounded = JSON.parse(readFileSync(join(candidatesDir(home), slug, "grounded-case.json"), "utf8")) as { quote?: unknown };
    quote = typeof grounded.quote === "string" ? grounded.quote : null;
  } catch {
    quote = null;
  }
  return { meta, skillMd, quote };
}

/** Keeps a pending lesson as files in `skillsDir`: the person's own skills or a folder's. */
export function keepLessonInto(home: string, slug: string, skillsDir: string, decidedAt: string, host: HostIdentity): DeliverResult {
  const meta = isSafeSlug(slug) ? reviewable(home).find((m) => m.slug === slug) : undefined;
  if (!meta) return { ok: false, error: `no pending lesson named "${slug}"` };
  const dir = join(candidatesDir(home), slug);
  const secret = secretInSkillDir(dir);
  if (secret) return { ok: false, error: `lesson "${slug}" holds what looks like a credential (${secret.pattern} in ${secret.file}), so it is not kept; edit it with /handbook:review` };
  return deliverPersonal(dir, meta, decidedAt, skillsDir, { host });
}

/** Sends a pending lesson to the team as /handbook:review does: a refusal that asks for the commit wording writes nothing. */
export function keepLessonForTeam(home: string, slug: string, decidedAt: string, options: DeliveryOptions): DeliverResult {
  const meta = isSafeSlug(slug) ? reviewable(home).find((m) => m.slug === slug) : undefined;
  if (!meta) return { ok: false, error: `no pending lesson named "${slug}"` };
  return approveAndDeliver(home, slug, home, decidedAt, undefined, undefined, undefined, "team", undefined, options);
}

export function rejectLesson(home: string, slug: string, decidedAt: string, never: boolean): DecideResult {
  if (!isSafeSlug(slug) || !reviewable(home).some((m) => m.slug === slug)) return { ok: false, error: `no pending lesson named "${slug}"` };
  return decideCandidate(home, slug, "rejected", decidedAt, { mute: never });
}
