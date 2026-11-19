import { useEffect, useState } from "react";
import { call } from "../api";
import { skillText } from "../TaskLearned";

export type ReviewTarget = "yours" | "folder" | "team";

/** The most rows asked of the orchestrator at once, and drawn before "Show more". */
export const PAGE = 50;

/** One lesson of the person's pending queue, named by its slug, whether a task or one of their own sessions taught it. */
export interface ReviewRow {
  slug: string;
  source: { kind: "task" | "session"; label: string };
  /** The task that taught it, to link to; none for a lesson from a session, which has no page of its own. */
  taskId: string | null;
  createdAt: string;
  firstLine: string | null;
}

interface PendingItem { slug: string; description: string; origin: string; sessionId: string; createdAt: string; firstLine: string }

export const rowOf = (item: PendingItem): ReviewRow => ({
  slug: item.slug,
  source: item.origin === "task" ? { kind: "task", label: "From a task" } : { kind: "session", label: "From a session" },
  taskId: item.origin === "task" ? item.sessionId : null,
  createdAt: item.createdAt,
  firstLine: item.firstLine || item.description || null,
});

export const toggled = (selected: ReadonlySet<string>, slug: string): Set<string> => {
  const next = new Set(selected);
  if (!next.delete(slug)) next.add(slug);
  return next;
};

/** The slugs that are still in the list, so a selection never carries a lesson that was decided or went away. */
export const stillThere = (selected: ReadonlySet<string>, rows: ReviewRow[]): Set<string> => new Set(rows.filter((r) => selected.has(r.slug)).map((r) => r.slug));

export interface Result { slug: string; ok: boolean; error?: string; proposedMessage?: string }
export interface Settled { results: Result[]; waiting: number }

export const decidedOf = (results: Result[]) => results.filter((r) => r.ok).map((r) => r.slug);

/** What a keep or reject that did not go through says: the first reason, and how many lessons it touched. */
export function refusedSaid(results: Result[]): string | null {
  const failed = results.filter((r) => !r.ok);
  if (!failed.length) return null;
  return `${failed.length === 1 ? "1 lesson was" : `${failed.length} lessons were`} not decided: ${failed[0]!.error ?? "not decided"}`;
}

export interface LessonDetail { slug: string; skillMd: string; quote: string | null }

export const lessonsReview = {
  list: (offset: number) => call<{ total: number; items: PendingItem[] }>("GET", `/api/lessons/review?${new URLSearchParams({ offset: String(offset), limit: String(PAGE) })}`),
  read: (slug: string) => call<{ lesson: LessonDetail }>("GET", `/api/lessons/review/${encodeURIComponent(slug)}`).then((b) => b.lesson),
  /** Keeps any number of lessons at once in the one place picked; a team keep may ask for the commit wording first. */
  keep: (slugs: string[], target: ReviewTarget, message?: string) => call<Settled>("POST", "/api/lessons/review/keep", { slugs, target, ...(message ? { message } : {}) }),
  reject: (slugs: string[], never = false) => call<Settled>("POST", "/api/lessons/review/reject", { slugs, ...(never ? { never: true } : {}) }),
};

export { skillText };

/** The person's waiting lessons, a page at a time, and how many wait in all; a decided lesson leaves the list and the count at once. */
export function useLessonsReview() {
  const [rows, setRows] = useState<ReviewRow[] | null>(null);
  const [total, setTotal] = useState<number | null>(null);
  useEffect(() => {
    lessonsReview.list(0).then((r) => {
      setRows(r.items.map(rowOf));
      setTotal(r.total);
    }, () => setRows(null));
  }, []);
  const more = () => lessonsReview.list(rows?.length ?? 0).then((r) => {
    setRows((now) => [...(now ?? []), ...r.items.map(rowOf)]);
    setTotal(r.total);
  });
  const settled = ({ results, waiting }: Settled) => {
    const out = new Set(decidedOf(results));
    setRows((now) => now && now.filter((r) => !out.has(r.slug)));
    setTotal(waiting);
  };
  return { rows, waiting: total, hasMore: rows !== null && total !== null && rows.length < total, more, settled };
}
