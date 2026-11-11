import type { RequestStatus } from "../forge/types.js";
import type { TaskRecord } from "./types.js";

/** Where a task stands as a board shows it: its agent's stage, then its request's as the forge has it. */
export type TaskPhase = "planned" | "working" | "tests" | "request" | "review" | "merged" | "failed";

/**
 * A task's phase, derived at every read and never stored. Review and merged come from the
 * request's own status, which a merge, a close or a forge refresh writes; a closed request, a
 * cancel and a failure all read as failed, and `status` and the request's status say which. A
 * task over several repositories is as far as its least advanced repository: one that failed
 * fails it, and it is merged only when every request is. A task that changed a folder in place has
 * no request: its person keeping the changes merges it, and undoing them fails it.
 */
export function taskPhase(task: Pick<TaskRecord, "status" | "stage" | "repoId" | "requestNumber" | "targets" | "result" | "changes">, requestStatus: (repoId: string, number: number) => RequestStatus | null): TaskPhase {
  if (task.status === "failed" || task.status === "cancelled") return "failed";
  // Changes made in a folder without git are settled by their person: kept reads as merged, undone as a closed request does.
  if (task.status === "needs-review" && task.result === "changes") return task.changes?.kept ? "merged" : task.changes?.undone ? "failed" : "review";
  if (task.status === "queued") return "planned";
  const targets = task.targets ?? null;
  if (targets) {
    if (targets.some((t) => t.status === "failed")) return "failed";
    if (task.status === "running") {
      const current = targets.find((t) => t.status === "working" || t.status === "tests");
      return current?.status === "tests" ? "tests" : current || targets.length ? "working" : "planned";
    }
    const opened = targets.flatMap((t) => (t.requestNumber !== null ? [requestStatus(t.repoId, t.requestNumber)] : []));
    if (opened.includes("closed")) return "failed";
    return opened.length && opened.every((s) => s === "merged") ? "merged" : "review";
  }
  if (task.status === "running") return task.stage ?? "working";
  const request = task.requestNumber !== null ? requestStatus(task.repoId, task.requestNumber) : null;
  return request === "merged" ? "merged" : request === "closed" ? "failed" : "review";
}
