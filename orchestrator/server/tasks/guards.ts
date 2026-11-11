import type { OrchestratorContext } from "../app.js";
import type { Principal } from "../auth.js";
import { canEditTeam, manages } from "../auth.js";
import type { RepoRecord, Store } from "../store.js";
import { checkBeforeMerge } from "./pushed-check.js";
import type { TaskCursor, TaskFilter, TaskRecord } from "./types.js";

/**
 * Why this account may not merge this request, or null. A request a task opened is the
 * agent's work; an account that is not a person and started that task would otherwise
 * approve its own agent's change, so it never merges it. A person who started a task
 * reviews and merges as before. Asked just before a merge, it also has a task's request that
 * holds no checked head, or a head pushed since its last check, checked now, so the merge that follows takes only a head that passed.
 */
export async function taskMergeRefusal(ctx: OrchestratorContext, repo: RepoRecord, number: number, user: Principal): Promise<string | null> {
  const [opened] = (await ctx.store.taskPage(ctx.tenant, { repoId: repo.id, requestNumber: number }, null, 1)).tasks;
  if (user.id.startsWith("service:") && opened && (opened.createdBy === user.email || opened.createdBy === user.id)) return "a request a task opened is merged by a person, not by the account that started the task";
  if (opened && (opened.status === "queued" || opened.status === "running")) return "its task is going on from it; merge it once that run ends";
  if (opened) await checkBeforeMerge(ctx, repo, number);
  return null;
}

/**
 * Whether this person starts tasks on a team. Every member of the organization does, on each of
 * its teams, except one the team's editors keep to its owners: there only its owners and the
 * organization's owners and admins start. With the organization's restricted teams not read,
 * only those start anywhere.
 */
export function canStartOnTeam(user: Principal, team: string): boolean {
  return user.role !== "viewer" && seesTeamTasks(user, team);
}

/** Whether this person reads a team's work, its board and items: whoever starts tasks there, and a viewer wherever a member would. A task's own page is `seesTask`'s. */
export function seesTeamTasks(user: Principal, team: string): boolean {
  if (canEditTeam(user, team)) return true;
  return user.restrictedTeams !== undefined && !user.restrictedTeams.includes(team);
}

/**
 * Whether this person reads a task: its title, outcome and log. Starting is open to every member,
 * but a task's page is not: what an agent did on a team's repository is read by that team's
 * owners, the organization's owners and admins, and the person who started it. Anyone else is
 * told no such task exists.
 */
export function seesTask(user: Principal, task: Pick<TaskRecord, "team" | "createdBy">): boolean {
  return canEditTeam(user, task.team) || task.createdBy === user.email || task.createdBy === user.id;
}

/**
 * Whether this person reads a task: whoever sees it, and a teammate it was shared with. A share
 * opens reading alone, the page, its log, its live view and its changes; every action on the task
 * stays with `seesTask` and its own rule, so a person it was shared with changes, answers, stops
 * and passes on nothing.
 */
export function readsTask(user: Principal, task: Pick<TaskRecord, "team" | "createdBy" | "sharedWith">): boolean {
  return seesTask(user, task) || (task.sharedWith?.includes(user.id) ?? false);
}

/** The tasks `readsTask` lets this person read, as a store filter, so a page of them is full. */
export function visibleTasks(user: Principal): TaskFilter {
  return manages(user) ? {} : { visibleTo: { teams: user.ownedTeams, creators: [user.email, user.id], sharedWith: user.id } };
}

/** Every task the filter takes, read a page at a time; for filters that take few, such as one person's unfinished tasks. */
export async function everyTask(store: Store, tenant: string, filter: TaskFilter): Promise<TaskRecord[]> {
  const tasks: TaskRecord[] = [];
  for (let after: TaskCursor | null = null; ; ) {
    const page = await store.taskPage(tenant, filter, after, 200);
    tasks.push(...page.tasks);
    if (!page.next) return tasks;
    after = page.next;
  }
}
