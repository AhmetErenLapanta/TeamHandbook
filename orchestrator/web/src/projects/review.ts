import type { RepoRecord, TaskRecord } from "../api";
import type { Project } from "../projects-read";

/** Tasks whose changes in a folder without Git wait for the person: ended for review, neither undone nor kept. */
export function changesToReview<T extends Pick<TaskRecord, "status" | "result" | "changes">>(tasks: T[]): T[] {
  return tasks.filter((t) => t.result === "changes" && t.status === "needs-review" && !t.changes?.undone && !t.changes?.kept);
}

/** The newest task of each project, from a list read newest first. */
export function lastTaskByProject<T extends Pick<TaskRecord, "repoId">>(tasks: T[]): Map<string, T> {
  const last = new Map<string, T>();
  for (const t of tasks) if (!last.has(t.repoId)) last.set(t.repoId, t);
  return last;
}

/** A project that opens requests: one with Git, or one on a forge, whose facts are not read here. */
export function opensRequests(repo: RepoRecord): boolean {
  return (repo as Project).facts?.git !== "none";
}
