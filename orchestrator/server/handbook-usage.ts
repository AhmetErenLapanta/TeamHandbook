import { Hono } from "hono";
import type { OrchestratorContext } from "./app.js";
import type { OrchestratorEnv, Principal } from "./auth.js";
import { route } from "./route-scopes.js";
import { everyTask } from "./tasks/guards.js";
import type { TaskRecord } from "./tasks/types.js";
import { UNKNOWN_SOURCE } from "./tasks/handbook-use.js";

/*
 * What a person's own tasks used of their handbooks: each skill and MCP server their agents
 * called, by the source the orchestrator's reading gave it, with how many tasks and when last.
 * Only what is recorded counts as used: a hook, a rule or CLAUDE.md is loaded, never "used".
 */

export interface HandbookUse {
  source: string;
  name: string;
  tasks: number;
  lastAt: string;
}

export interface HandbookUsage {
  days: number;
  skills: HandbookUse[];
  mcpServers: HandbookUse[];
}

const USAGE_DAYS = 30;
const MAX_DAYS = 90;
const DAY_MS = 86_400_000;

/** A task's uses, once each: its record of what it used, else the skill names an older task kept without a source. */
function usesOf(task: TaskRecord): { skills: { source: string; name: string }[]; mcpServers: { source: string; name: string }[] } {
  if (task.used) return task.used;
  return { skills: (task.usedSkills ?? []).map((name) => ({ source: UNKNOWN_SOURCE.source, name })), mcpServers: [] };
}

function tally(into: Map<string, HandbookUse>, uses: { source: string; name: string }[], at: string) {
  for (const { source, name } of uses) {
    const key = `${source}\u0000${name}`;
    const held = into.get(key);
    if (!held) into.set(key, { source, name, tasks: 1, lastAt: at });
    else {
      held.tasks += 1;
      if (at > held.lastAt) held.lastAt = at;
    }
  }
}

const newestFirst = (uses: Map<string, HandbookUse>) => [...uses.values()].sort((a, b) => b.lastAt.localeCompare(a.lastAt) || a.name.localeCompare(b.name));

export async function handbookUsage(ctx: OrchestratorContext, user: Principal, days: number, now = Date.now()): Promise<HandbookUsage> {
  const since = new Date(now - days * DAY_MS).toISOString();
  return usageOf(await everyTask(ctx.store, ctx.tenant, { createdBy: [user.email, user.id], since }), days);
}

/** The uses of tasks already read, each skill and server once per task with the newest start it was used in. */
export function usageOf(tasks: readonly TaskRecord[], days: number): HandbookUsage {
  const skills = new Map<string, HandbookUse>();
  const mcpServers = new Map<string, HandbookUse>();
  for (const task of tasks) {
    const at = task.startedAt ?? task.createdAt;
    const uses = usesOf(task);
    tally(skills, uses.skills, at);
    tally(mcpServers, uses.mcpServers, at);
  }
  return { days, skills: newestFirst(skills), mcpServers: newestFirst(mcpServers) };
}

/** What the handbook list says of one item: the tasks of the window that used it and the newest of them. */
export interface ItemUse {
  tasks: number;
  lastAt: string | null;
}

type Item = { name: string; used?: ItemUse };

/** Sources read for their use in the window, where an item no task used says zero, so the list can say it was not used. */
export function withNoUse<S extends { skills: Item[]; mcpServers: Item[] }>(sources: readonly S[]): S[] {
  const zero = (items: Item[]) => items.map((item) => (item.used ? item : { ...item, used: { tasks: 0, lastAt: null } }));
  return sources.map((s) => ({ ...s, skills: zero(s.skills), mcpServers: zero(s.mcpServers) }));
}

export function handbookUsageRoutes(ctx: OrchestratorContext): Hono<OrchestratorEnv> {
  const app = new Hono<OrchestratorEnv>();
  route(app, "GET /api/handbook/usage", async (c) => {
    const given = c.req.query("days");
    const days = given === undefined ? USAGE_DAYS : Number(given);
    if (!Number.isInteger(days) || days < 1 || days > MAX_DAYS) return c.json({ error: `days is a whole number from 1 to ${MAX_DAYS}`, code: "bad-days" }, 400);
    return c.json(await handbookUsage(ctx, c.get("user"), days));
  });
  return app;
}
