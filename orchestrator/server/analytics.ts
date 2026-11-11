import { Hono } from "hono";
import type { PeopleOutcomes, PersonOutcomes } from "../shared/activity.js";
import type { OrchestratorContext } from "./app.js";
import { mirrorDir } from "./app.js";
import { manages } from "./auth.js";
import type { OrchestratorEnv, Principal } from "./auth.js";
import type { RequestRecord } from "./forge/types.js";
import { gitAsyncMaybe } from "./git.js";
import { everyTask, seesTask, seesTeamTasks, visibleTasks } from "./tasks/guards.js";
import type { TaskRecord } from "./tasks/types.js";

export const ANALYTICS_DAYS = 30;
const MAX_DAYS = 365;

export interface RequestStats {
  opened: number;
  merged: number;
  closed: number;
  open: number;
  /** Merged and later reverted on the default branch by a revert that names the request's commit. */
  reverted: number;
  /** Of the requests decided, the share merged; null while none is decided. */
  mergeRate: number | null;
  /** Hours from opening to merge, over the merged ones; null when none merged with a known time. */
  hoursToMerge: { median: number; p90: number } | null;
}

export interface RequestAnalytics {
  days: number;
  since: string;
  /** Requests opened from the orchestrator's screens, and those a task's agent opened, apart. */
  orchestrator: RequestStats;
  agent: RequestStats;
  byTeam: { team: string; orchestrator: RequestStats; agent: RequestStats }[];
  byRepo: { repoId: string; team: string; orchestrator: RequestStats; agent: RequestStats }[];
  /**
   * The counts are a floor: only requests the orchestrator opened are counted, a merge on a hosted
   * forge is known once someone refreshes it, and a revert is counted only when its message
   * names the request's commit or a merge of it, so a squashed or hand-written revert is missed.
   */
  lowerBound: true;
}

const hours = (from: string, to: string) => (Date.parse(to) - Date.parse(from)) / 3_600_000;

function quantile(sorted: number[], q: number): number {
  const at = Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1);
  return Math.round(sorted[Math.max(0, at)]! * 10) / 10;
}

export function requestStats(requests: readonly RequestRecord[], reverted: ReadonlySet<string>): RequestStats {
  const merged = requests.filter((r) => r.status === "merged");
  const closed = requests.filter((r) => r.status === "closed").length;
  const waits = merged.flatMap((r) => (r.mergedAt ? [hours(r.createdAt, r.mergedAt)] : [])).filter((h) => h >= 0).sort((a, b) => a - b);
  return {
    opened: requests.length,
    merged: merged.length,
    closed,
    open: requests.filter((r) => r.status === "open").length,
    reverted: merged.filter((r) => reverted.has(`${r.repoId}\0${r.headSha}`)).length,
    mergeRate: merged.length + closed ? Math.round((merged.length / (merged.length + closed)) * 1000) / 1000 : null,
    hoursToMerge: waits.length ? { median: quantile(waits, 0.5), p90: quantile(waits, 0.9) } : null,
  };
}

/**
 * The commits the default branch reverted since `since`, each with its parents: a revert names
 * the commit it undid, which for a merged request is its head or the merge commit over it.
 */
async function revertedCommits(mirror: string, head: string, since: string): Promise<Set<string>> {
  const log = (await gitAsyncMaybe(["log", "--format=%B%x00", `--since=${since}`, "--grep=This reverts commit", head], mirror)) ?? "";
  const named = [...log.matchAll(/This reverts commit ([0-9a-f]{40})/g)].map((m) => m[1]!);
  const reverted = new Set<string>();
  for (const sha of named) {
    reverted.add(sha);
    const parents = (await gitAsyncMaybe(["rev-list", "--parents", "-n1", sha], mirror))?.trim().split(" ").slice(1) ?? [];
    for (const parent of parents) reverted.add(parent);
  }
  return reverted;
}

/**
 * `viewer` keeps the counts to what that person reads in the request list: a request a task opened
 * as that task, any other by its team's readers and its opener. Left out, as for an owner or an
 * admin, every request counts.
 */
export async function requestAnalytics(ctx: OrchestratorContext, days: number, now = new Date(), viewer?: Principal): Promise<RequestAnalytics> {
  const since = new Date(now.getTime() - days * 86_400_000).toISOString();
  const repos = await ctx.store.listRepos(ctx.tenant);
  const teamOf = new Map(repos.map((r) => [r.id, r.team]));
  // The tasks that opened a request in the window, whenever each started: one started before it
  // that opened its request inside is still the agent's, and so is each request a task over
  // several repositories opened in one of them.
  const byAgent = new Map<string, TaskRecord>();
  for (const t of await everyTask(ctx.store, ctx.tenant, { requestOpenedSince: since })) {
    if (t.requestNumber !== null) byAgent.set(`${t.repoId}\0${t.requestNumber}`, t);
    for (const g of t.targets ?? []) if (g.requestNumber !== null) byAgent.set(`${g.repoId}\0${g.requestNumber}`, t);
  }
  const openerOf = (r: RequestRecord) => byAgent.get(`${r.repoId}\0${r.number}`);
  const isAgent = (r: RequestRecord) => openerOf(r) !== undefined;
  const reads = (r: RequestRecord) => {
    if (!viewer) return true;
    const task = openerOf(r);
    if (task) return seesTask(viewer, task);
    return (teamOf.has(r.repoId) && seesTeamTasks(viewer, teamOf.get(r.repoId)!)) || r.createdBy === viewer.email || r.createdBy === viewer.id;
  };
  const requests = (await ctx.store.listRequests(ctx.tenant)).filter((r) => r.createdAt >= since && reads(r));

  const reverted = new Set<string>();
  for (const repo of repos) {
    if (!repo.head || !requests.some((r) => r.repoId === repo.id && r.status === "merged")) continue;
    for (const sha of await revertedCommits(mirrorDir(ctx, repo.id), repo.head, since)) reverted.add(`${repo.id}\0${sha}`);
  }
  const split = (list: RequestRecord[]) => ({ orchestrator: requestStats(list.filter((r) => !isAgent(r)), reverted), agent: requestStats(list.filter(isAgent), reverted) });

  // A request whose repository was disconnected keeps its history under the team it had; the
  // orchestrator no longer knows that team, so it is counted under the repository's id alone.
  const team = (r: RequestRecord) => teamOf.get(r.repoId) ?? `(disconnected) ${r.repoId}`;
  const teams = [...new Set(requests.map(team))].sort();
  const repoIds = [...new Set(requests.map((r) => r.repoId))].sort();
  return {
    days,
    since,
    ...split(requests),
    byTeam: teams.map((t) => ({ team: t, ...split(requests.filter((r) => team(r) === t)) })),
    byRepo: repoIds.map((id) => ({ repoId: id, team: team({ repoId: id } as RequestRecord), ...split(requests.filter((r) => r.repoId === id)) })),
    lowerBound: true,
  };
}

/**
 * Each person's tasks started in the window and how they ended: merged, kept, closed, undone or
 * failed, counted over the tasks the reader sees, so a team's owner sees their team's people
 * and a member themselves; the people with the most tasks first.
 */
export async function peopleOutcomes(ctx: OrchestratorContext, user: Principal, days: number, now = new Date()): Promise<PeopleOutcomes> {
  const since = new Date(now.getTime() - days * 86_400_000).toISOString();
  const tasks = await everyTask(ctx.store, ctx.tenant, { ...visibleTasks(user), since });
  const requests = new Map((await ctx.store.listRequests(ctx.tenant)).map((r) => [`${r.repoId}#${r.number}`, r.status]));
  const names = new Map((await ctx.store.listUsers(ctx.tenant)).map((u) => [u.email, u.name ?? null]));
  const people = new Map<string, PersonOutcomes>();
  for (const task of tasks) {
    const person = people.get(task.createdBy) ?? { email: task.createdBy, name: names.get(task.createdBy) ?? null, tasks: 0, merged: 0, closed: 0, kept: 0, undone: 0, failed: 0, usd: 0, unknownCost: 0 };
    person.tasks++;
    const request = task.requestNumber !== null ? requests.get(`${task.repoId}#${task.requestNumber}`) : undefined;
    if (request === "merged") person.merged++;
    else if (request === "closed") person.closed++;
    if (task.changes?.kept) person.kept++;
    else if (task.changes?.undone) person.undone++;
    if (task.status === "failed") person.failed++;
    if (task.cost.usd === null) person.unknownCost++;
    else person.usd += task.cost.usd;
    people.set(task.createdBy, person);
  }
  return { days, since, people: [...people.values()].sort((a, b) => b.tasks - a.tasks || a.email.localeCompare(b.email)) };
}

/** How the requests the orchestrator opened fared, for anyone signed in, counted over the requests the list shows them. */
export function analyticsRoutes(ctx: OrchestratorContext): Hono<OrchestratorEnv> {
  const app = new Hono<OrchestratorEnv>();
  const daysOf = (given: string | undefined) => {
    const days = given === undefined ? ANALYTICS_DAYS : Number(given);
    return Number.isInteger(days) && days >= 1 && days <= MAX_DAYS ? days : null;
  };
  app.get("/api/analytics/requests", async (c) => {
    const days = daysOf(c.req.query("days"));
    if (days === null) return c.json({ error: `days is a whole number from 1 to ${MAX_DAYS}` }, 400);
    const user = c.get("user");
    return c.json(await requestAnalytics(ctx, days, new Date(), manages(user) ? undefined : user));
  });
  app.get("/api/analytics/people", async (c) => {
    const days = daysOf(c.req.query("days"));
    if (days === null) return c.json({ error: `days is a whole number from 1 to ${MAX_DAYS}` }, 400);
    return c.json(await peopleOutcomes(ctx, c.get("user"), days));
  });
  return app;
}
