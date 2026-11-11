import type { TaskRecord } from "./api";
import { stateOf } from "./task-state";
import type { StateSource } from "./task-state";

/** What a task wants of the person who started it, most pressing first. */
export type Attention = "approval" | "answer" | "limited" | "follow-up" | "review" | "failed";

export const ATTENTION: Record<Attention, { label: string; tone: string; title: (task: string) => string }> = {
  approval: { label: "needs your approval", tone: "warn", title: (t) => `${t} needs your approval` },
  answer: { label: "asks you a question", tone: "warn", title: (t) => `${t} asks you a question` },
  limited: { label: "at the usage limit", tone: "warn", title: (t) => `${t} paused at a usage limit` },
  "follow-up": { label: "follow-up suggested", tone: "warn", title: (t) => `A teammate suggests a follow-up on ${t}` },
  // The same words as the task's status badge, so one state has one name on every screen.
  review: { label: "needs review", tone: "warn", title: (t) => `${t} needs review` },
  failed: { label: "failed", tone: "error", title: (t) => `${t} failed` },
};

const ORDER: Attention[] = ["approval", "answer", "limited", "follow-up", "review", "failed"];

/** What a person decided about a task's work: undid its changes, kept them, or closed its request. */
export type Decision = "undone" | "kept" | "closed";

/** What a decision is read from: a task as the task list has it, or one of Activity's recent tasks. */
export type Decided = Pick<TaskRecord, "status"> & Partial<Pick<TaskRecord, "phase" | "result">> & { changes?: TaskRecord["changes"] | { undone: boolean; kept: boolean }; request?: { status: string } | null; requests?: { status: string }[] };

/**
 * A person's decision on a task that ended for review, read from the task's changes and request
 * where the page has them and from its phase where it does not: the server reads an undo and a
 * closed request as a failed phase, which is the person's choice and not the agent failing.
 */
export function decisionOf(task: Decided): Decision | null {
  if (task.status !== "needs-review") return null;
  const inPlace = task.result === "changes";
  if (task.changes?.undone || (inPlace && task.phase === "failed")) return "undone";
  if (task.changes?.kept || (inPlace && task.phase === "merged")) return "kept";
  if (inPlace) return null;
  if (task.request?.status === "closed" || (task.requests?.length && task.requests.every((r) => r.status === "closed")) || task.phase === "failed") return "closed";
  return null;
}

/** The task's call on its person, if any: what the agent asked first, then where the task ended. A decision already made calls on nobody. */
export function attentionOf(task: Decided & Pick<TaskRecord, "attention"> & Partial<Pick<TaskRecord, "suggestions" | "question">> & Pick<StateSource, "state" | "requests">): Attention | null {
  if (task.attention) return task.attention;
  // A run that waits on a plan, a permission or a question while it works: the orchestrator's own state says so, with no separate flag.
  if (task.status === "running" && stateOf(task) === "needs-you") return "approval";
  // A run that stopped to ask something calls for its answer, not for a retry.
  if (task.status === "failed" && task.question && !task.question.answer) return "answer";
  // The orchestrator marks no task for a teammate's follow-up: one its starter can answer is the call.
  if (task.suggestions?.some((s) => s.canAnswer)) return "follow-up";
  if (decisionOf(task)) return null;
  if (task.phase === "review" || (!task.phase && task.status === "needs-review")) return "review";
  if (task.phase === "failed" || task.status === "failed") return "failed";
  return null;
}

export function byAttention(a: Attention, b: Attention): number {
  return ORDER.indexOf(a) - ORDER.indexOf(b);
}

/**
 * The calls worth a notification since the last look: a task that newly wants its person. The
 * first look notifies of nothing, a call already seen is not made again, and a task the person
 * has open on screen is not called at all.
 */
export function newCalls(before: Map<string, Attention | null> | null, tasks: (Decided & Pick<TaskRecord, "id" | "attention">)[], seen: Set<string>, onScreen: string | null): { id: string; attention: Attention }[] {
  if (!before) return [];
  const calls: { id: string; attention: Attention }[] = [];
  for (const task of tasks) {
    const now = attentionOf(task);
    if (!now || before.get(task.id) === now || seen.has(`${task.id}:${now}`) || task.id === onScreen) continue;
    calls.push({ id: task.id, attention: now });
  }
  return calls;
}

export type TaskFilter = "all" | "mine" | "needs-you";

/**
 * The task list as its reader works it: their own tasks that call on them first, most pressing
 * first, then the rest in the order they came. A call is unread until its task was opened.
 */
export function taskRows<T extends Decided & Pick<TaskRecord, "id" | "attention" | "createdBy">>(tasks: T[], email: string, seen: Set<string>, filter: TaskFilter): { task: T; call: Attention | null; unread: boolean }[] {
  const rows = tasks.map((task) => {
    const call = task.createdBy === email ? attentionOf(task) : null;
    return { task, call, unread: call !== null && !seen.has(`${task.id}:${call}`) };
  });
  const kept = rows.filter((r) => filter === "all" || (filter === "mine" ? r.task.createdBy === email : r.call !== null));
  return kept
    .map((row, at) => ({ row, at }))
    .sort((a, b) => (a.row.call && b.row.call ? byAttention(a.row.call, b.row.call) : a.row.call ? -1 : b.row.call ? 1 : 0) || a.at - b.at)
    .map(({ row }) => row);
}
