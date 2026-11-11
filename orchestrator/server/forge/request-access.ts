import type { OrchestratorContext } from "../app.js";
import type { Principal } from "../auth.js";
import type { RepoRecord, RequestReader } from "../store.js";
import { seesTask, seesTeamTasks } from "../tasks/guards.js";
import type { RequestRecord } from "./types.js";

/**
 * Whether this person reads a request. One a task opened, on any repository the task changes, is
 * read as that task is: its description is the agent's report and its diff the agent's work, which
 * the task's page keeps to its team's owners, the organization's owners and admins and its starter.
 * One no task opened, a person's own from the editing screen or a teammate's on the forge, is read
 * by whoever reads its team's tasks and by whoever opened it. Anyone else is told no such request
 * exists.
 */
export async function seesRequest(ctx: Pick<OrchestratorContext, "store" | "tenant">, user: Principal, repo: Pick<RepoRecord, "id" | "team">, number: number, request: Pick<RequestRecord, "createdBy"> | null): Promise<boolean> {
  const [task] = (await ctx.store.taskPage(ctx.tenant, { repoId: repo.id, requestNumber: number }, null, 1)).tasks;
  if (task) return seesTask(user, task);
  return seesTeamTasks(user, repo.team) || (request !== null && (request.createdBy === user.email || request.createdBy === user.id));
}

/** `seesRequest` as a store filter, for a person who is not an owner or an admin, so a page of requests is full. */
export function requestReader(user: Principal, repos: readonly Pick<RepoRecord, "id" | "team">[]): RequestReader {
  return { repoIds: repos.filter((r) => seesTeamTasks(user, r.team)).map((r) => r.id), taskTeams: user.ownedTeams, people: [user.email, user.id] };
}
