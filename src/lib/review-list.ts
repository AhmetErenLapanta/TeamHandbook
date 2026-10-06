import { lessonHarvestEnabled } from "./harvest.js";
import { archiveCandidate, formatCandidateList, listCandidates, writeArchiveManifest } from "./queue.js";
import type { ArchiveEntry, CandidateMeta } from "./queue.js";
import { handbookHome } from "./session-state.js";

// The first screen of /handbook:review, once the per-session lesson harvest is off.
//
// Switching the harvest off stops new lessons; it does nothing to the ones already queued,
// and a queue that filled before the switch opens with them - so the drafts the product now
// makes, mined from a repository's history, would sit behind a backlog nothing asks for any
// more. With the harvest off those lessons are folded into one line with two ways out, and
// the drafts are what the screen lists. With it on, they are the live queue and the screen
// is what it always was.

/** A lesson the per-session harvest proposed. With the harvest off nothing writes one any
 * more, so every one still waiting predates the switch. Only the harvest's own: a capture
 * the person asked for with /handbook:learn stays on the screen, because folding something
 * they requested into "archive all?" would decide it for them. */
export function isOlderLesson(meta: CandidateMeta): boolean {
  return meta.origin === "harvest";
}

export interface ReviewQueue {
  /** what the first screen lists: newest first, or drafts mined from history first when
   * `draftsFirst` says the harvest is off */
  listed: CandidateMeta[];
  /** harvested lessons from before the harvest was switched off, folded into one line */
  olderLessons: CandidateMeta[];
  draftsFirst: boolean;
}

export function reviewQueue(home: string = handbookHome()): ReviewQueue {
  const pending = listCandidates(home, "pending");
  if (lessonHarvestEnabled(home)) return { listed: pending, olderLessons: [], draftsFirst: false };
  const rest = pending.filter((meta) => !isOlderLesson(meta));
  return {
    listed: [...rest.filter((meta) => meta.origin === "mine"), ...rest.filter((meta) => meta.origin !== "mine")],
    olderLessons: pending.filter(isOlderLesson),
    draftsFirst: true,
  };
}

/** The first screen. One line stands for every older lesson, and it names both ways out and
 * says the first one is reversible, since "archive all" is otherwise the kind of button
 * nobody presses without knowing whether it deletes. */
export function formatReviewQueue(queue: ReviewQueue, now: number = Date.now()): string {
  const { listed, olderLessons } = queue;
  // The header names the order only when it is not plain recency, which it stops being
  // the moment a draft sits above something newer than itself.
  const mixed = queue.draftsFirst && listed.some((m) => m.origin === "mine") && listed.some((m) => m.origin !== "mine");
  const list = formatCandidateList(listed, now, "Pending", mixed ? "repository drafts first, then newest first" : undefined);
  if (!olderLessons.length) return list;
  const n = olderLessons.length;
  const line =
    `${n} older lesson ${n === 1 ? "candidate" : "candidates"} from before the harvest was switched off ` +
    `${n === 1 ? "is" : "are"} not listed: archive ${n === 1 ? "it" : "them all"} with "review.js archive-lessons" ` +
    `(reversible, nothing is deleted) or show ${n === 1 ? "it" : "them"} with "review.js list --lessons".`;
  return listed.length ? `${list}\n\n${line}` : line;
}

/**
 * What `approve --all` or `reject --all` says when the screen lists nothing only because it
 * folded the older lessons. The verb reaches what the screen lists and no further, so it
 * has nothing to do here - but a bare usage line would leave the person reading the folded
 * line wondering why "all" meant none. Null when the empty screen has nothing folded either.
 */
export function foldedAllRefusal(queue: ReviewQueue, verb: "approve" | "reject"): string | null {
  if (queue.listed.length || !queue.olderLessons.length) return null;
  const n = queue.olderLessons.length;
  return (
    `nothing on the review screen to ${verb}: ${n} older lesson ${n === 1 ? "candidate is" : "candidates are"} ` +
    `folded, and --all reaches only what the screen lists. Show them with "review.js list --lessons" and name ` +
    `the ones to ${verb}, or archive them with "review.js archive-lessons".`
  );
}

const LESSON_ARCHIVE_REASON = "lesson harvest switched off; archived unread from the review screen";

export interface LessonArchive {
  archived: string[];
  skipped: Array<{ slug: string; reason: string }>;
  manifestPath?: string;
}

/**
 * Archive every older lesson in one step, with the same manifest a sweep writes.
 *
 * Archived is a queue state, not a verdict: each candidate.json stays where it is with its
 * status changed, nothing is rejected and no fingerprint is muted, and the manifest is the
 * undo. One step is enough consent for exactly that reason - it hides, it does not decide.
 */
export function archiveOlderLessons(
  home: string = handbookHome(),
  now: () => string = () => new Date().toISOString(),
): LessonArchive {
  const at = now();
  const result: LessonArchive = { archived: [], skipped: [] };
  const entries: ArchiveEntry[] = [];
  for (const meta of reviewQueue(home).olderLessons) {
    const done = archiveCandidate(home, meta.slug, LESSON_ARCHIVE_REASON, at);
    if (done.ok && done.entry) {
      entries.push(done.entry);
      result.archived.push(meta.slug);
    } else {
      result.skipped.push({ slug: meta.slug, reason: done.error ?? "could not be archived" });
    }
  }
  // Written only when something moved, so a run that archived nothing leaves no undo file
  // for "restore" to pick up as the most recent one.
  if (entries.length) {
    result.manifestPath = writeArchiveManifest(home, { sweptAt: at, reason: LESSON_ARCHIVE_REASON, entries });
  }
  return result;
}

export function formatLessonArchive(result: LessonArchive): string {
  if (!result.archived.length && !result.skipped.length) {
    return "No older lesson candidates are waiting, so nothing was archived.";
  }
  const n = result.archived.length;
  const lines = [`Archived ${n} older lesson ${n === 1 ? "candidate" : "candidates"} - archived, not deleted.`];
  if (result.manifestPath) {
    // The manifest path as it is, not shortened: restore opens it as typed, and a shell
    // does not expand "~" inside the quotes it is pasted in.
    lines.push(
      "  list them:          review.js list --archived",
      `  put them all back:  review.js restore "${result.manifestPath}"`,
    );
  }
  if (result.skipped.length) {
    lines.push("", "Left pending:", ...result.skipped.map((s) => `  ${s.slug} - ${s.reason}`));
  }
  return lines.join("\n");
}
