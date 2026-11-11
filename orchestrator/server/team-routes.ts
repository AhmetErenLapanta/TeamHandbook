import { Hono } from "hono";
import type { OrchestratorContext } from "./app.js";
import { maskUrl, mirrorDir } from "./app.js";
import { canEditTeam } from "./auth.js";
import type { OrchestratorEnv, Principal } from "./auth.js";
import { readInventory } from "./inventory.js";
import type { Inventory } from "./inventory.js";
import { shownProjects } from "./projects.js";
import { route } from "./route-scopes.js";
import type { RepoRecord } from "./store.js";
import { everyTask, visibleTasks } from "./tasks/guards.js";

/*
 * What the Team page reads of the team's repositories in one answer each: what stops teammates,
 * in the setup panel's own words, and what the team shares, by name, with how many tasks were
 * started with it.
 */

export interface TeamProblem {
  repoId: string;
  repoName: string;
  team: string;
  title: string;
  detail: string | null;
  next: string | null;
  /** A scaffold refresh clears it; null when only a person does. */
  fix: "refresh" | null;
}

export interface TeamShared {
  skills: { name: string; slug: string; repoId: string; repoName: string; tasks: number | null }[];
  /** A team's MCP server is loaded into every task rather than picked, so how many tasks used it is not known. */
  mcpServers: { name: string; repoId: string; repoName: string; tasks: null }[];
}

const SHARED_DAYS = 30;
const MAX_DAYS = 90;
const inventories = new Map<string, { head: string; read: Inventory | null }>();

/** The team repositories a person reads here: a code repository shares nothing, and neither does one never read. */
async function teamRepos(ctx: OrchestratorContext, user: Principal): Promise<RepoRecord[]> {
  return (await shownProjects(ctx, user, await ctx.store.listRepos(ctx.tenant))).filter((r) => !ctx.tasks?.codeTarget(r) && (r.head || r.error));
}

/** A repository's inventory at its head, read once for each commit it is at; null when its files do not read. */
async function inventoryOf(ctx: OrchestratorContext, repo: RepoRecord): Promise<Inventory | null> {
  const mirror = mirrorDir(ctx, repo.id);
  const kept = inventories.get(mirror);
  if (kept?.head === repo.head) return kept.read;
  const read = await readInventory(mirror, repo.head!).catch(() => null);
  inventories.set(mirror, { head: repo.head!, read });
  return read;
}

/** What stops teammates in the repositories this person edits: a sync that failed, files that do not read, and the setup panel's problems. */
export async function teamProblems(ctx: OrchestratorContext, user: Principal): Promise<TeamProblem[]> {
  const problems: TeamProblem[] = [];
  for (const repo of (await teamRepos(ctx, user)).filter((r) => canEditTeam(user, r.team))) {
    const at = { repoId: repo.id, repoName: repo.name, team: repo.team };
    if (repo.error) {
      problems.push({ ...at, title: "The last sync failed", detail: maskUrl(repo.error), next: null, fix: null });
      continue;
    }
    const read = await inventoryOf(ctx, repo);
    if (!read) {
      problems.push({ ...at, title: "The orchestrator does not read this repository's files", detail: null, next: null, fix: null });
      continue;
    }
    for (const f of read.setup.filter((f) => f.level === "problem")) problems.push({ ...at, title: f.title, detail: f.detail ?? null, next: f.next ?? null, fix: f.refresh ? "refresh" : null });
  }
  return problems;
}

/** The skills and MCP servers the team repositories this person reads share, and how many of their tasks in the window were started with each skill. */
export async function teamShared(ctx: OrchestratorContext, user: Principal, days: number, now = Date.now()): Promise<TeamShared> {
  const since = new Date(now - days * 86_400_000).toISOString();
  const tasks = await everyTask(ctx.store, ctx.tenant, { ...visibleTasks(user), since });
  const started = new Map<string, number>();
  for (const task of tasks) for (const name of new Set([...(task.skills ?? []), ...(task.tools?.skills ?? []).map((s) => s.name)])) started.set(name, (started.get(name) ?? 0) + 1);
  const shared: TeamShared = { skills: [], mcpServers: [] };
  for (const repo of (await teamRepos(ctx, user)).filter((r) => r.head)) {
    const read = await inventoryOf(ctx, repo);
    if (!read) continue;
    const at = { repoId: repo.id, repoName: repo.name };
    for (const skill of read.skills) shared.skills.push({ name: skill.name, slug: skill.slug, ...at, tasks: started.get(skill.slug) ?? started.get(skill.name) ?? 0 });
    for (const server of read.mcpServers) shared.mcpServers.push({ name: server.name, ...at, tasks: null });
  }
  return shared;
}

export function teamRoutes(ctx: OrchestratorContext): Hono<OrchestratorEnv> {
  const app = new Hono<OrchestratorEnv>();
  route(app, "GET /api/team/setup", async (c) => c.json({ problems: await teamProblems(ctx, c.get("user")) }));
  route(app, "GET /api/team/shared", async (c) => {
    const given = c.req.query("days");
    const days = given === undefined ? SHARED_DAYS : Number(given);
    if (!Number.isInteger(days) || days < 1 || days > MAX_DAYS) return c.json({ error: `days is a whole number from 1 to ${MAX_DAYS}`, code: "bad-days" }, 400);
    return c.json(await teamShared(ctx, c.get("user"), days));
  });
  return app;
}
