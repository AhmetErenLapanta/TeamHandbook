import type { RequestRecord } from "../forge/types.js";
import type { TaskRecord } from "./types.js";

/**
 * Where a task stands, as every screen says it: one word for the task and the change it made, so no list shows a task
 * and its request as two things in two states.
 */
export type TaskState =
  | "waiting"
  | "working"
  | "usage-limit"
  | "waiting-machine"
  | "needs-you"
  | "kept"
  | "in-review"
  | "merged"
  | "undone"
  | "failed"
  | "stopped";

/** The request a task's change opened on GitLab or GitHub, linked by the forge's own number. */
export interface TaskForge {
  kind: string;
  number: number;
  url: string;
}

type RequestOf = (repoId: string, number: number) => RequestRecord | undefined;

/** Every request the task opened on a forge, its own first and then each repository's. */
function forgeRequests(task: Pick<TaskRecord, "repoId" | "requestNumber" | "targets">, requestOf: RequestOf): RequestRecord[] {
  const pairs = [[task.repoId, task.requestNumber] as const, ...(task.targets ?? []).map((t) => [t.repoId, t.requestNumber] as const)];
  return pairs.flatMap(([repoId, number]) => {
    const request = number === null ? undefined : requestOf(repoId, number);
    return request && request.provider !== "local" ? [request] : [];
  });
}

export function taskForge(task: Pick<TaskRecord, "repoId" | "requestNumber" | "targets">, requestOf: RequestOf): TaskForge | null {
  const first = forgeRequests(task, requestOf)[0];
  return first ? { kind: first.provider, number: first.number, url: first.url } : null;
}

/**
 * The one state of a task: a question it asks or a change only its person can settle reads as needing them, and a
 * change on a forge reads by its request there. `waitingFor` is why a queued task waits beyond its turn; `asking` that a
 * running one waits on an approval.
 */
export function taskState(task: TaskRecord, requestOf: RequestOf, waitingFor: string | null, asking = false): TaskState {
  if (task.question && !task.question.answer && task.status !== "queued" && task.status !== "running") return "needs-you";
  if (task.status === "running") return asking ? "needs-you" : "working";
  if (task.status === "queued") return waitingFor === "limit" ? "usage-limit" : waitingFor ? "waiting-machine" : "waiting";
  if (task.status === "cancelled" || task.status === "interrupted") return "stopped";
  if (task.status === "failed") return "failed";
  if (task.changes?.undone) return "undone";
  if (task.changes?.kept) return "kept";
  if (task.result === "changes") return "needs-you";
  const forge = forgeRequests(task, requestOf);
  if (forge.some((r) => r.status === "open")) return "in-review";
  if (forge.length) return forge.some((r) => r.status === "merged") ? "merged" : "undone";
  // A request kept on this machine settles by Keep, which merges it there, or by Undo, which closes it.
  const local = task.requestNumber === null ? undefined : requestOf(task.repoId, task.requestNumber);
  if (local?.status === "merged") return "kept";
  if (local?.status === "closed") return "undone";
  return "needs-you";
}
