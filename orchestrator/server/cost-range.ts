import { Hono } from "hono";
import type { OrchestratorContext } from "./app.js";
import type { OrchestratorEnv, Principal } from "./auth.js";
import { route } from "./route-scopes.js";
import { everyTask, visibleTasks } from "./tasks/guards.js";

/*
 * What tasks like the one about to start have cost: the lower and upper quarter of what this
 * project's finished tasks with this agent cost, from the tasks the reader sees. Too few to say
 * is no range at all, never a made-up one.
 */

export interface CostRange {
  tasks: number;
  lowUsd: number | null;
  highUsd: number | null;
}

/** Tasks needed before a range is given. */
export const COST_RANGE_MINIMUM = 5;
const DAYS = 90;

/** The value a share of the sorted values sits at, taken between its two neighbours. */
function quantile(sorted: number[], share: number): number {
  const at = (sorted.length - 1) * share;
  const below = Math.floor(at);
  const above = Math.ceil(at);
  return sorted[below]! + (sorted[above]! - sorted[below]!) * (at - below);
}

export async function costRange(ctx: OrchestratorContext, user: Principal, repoId: string, agent: string, now = Date.now()): Promise<CostRange> {
  const since = new Date(now - DAYS * 86_400_000).toISOString();
  const tasks = await everyTask(ctx.store, ctx.tenant, { ...visibleTasks(user), repoId, statuses: ["needs-review"], since });
  const costs = tasks.filter((t) => t.agent === agent && t.cost.usd !== null).map((t) => t.cost.usd as number).sort((a, b) => a - b);
  if (costs.length < COST_RANGE_MINIMUM) return { tasks: costs.length, lowUsd: null, highUsd: null };
  const round = (n: number) => Math.round(n * 100) / 100;
  return { tasks: costs.length, lowUsd: round(quantile(costs, 0.25)), highUsd: round(quantile(costs, 0.75)) };
}

export function costRangeRoutes(ctx: OrchestratorContext): Hono<OrchestratorEnv> {
  const app = new Hono<OrchestratorEnv>();
  route(app, "GET /api/tasks/cost-range", async (c) => {
    const repo = c.req.query("repo") ?? "";
    const agent = c.req.query("agent") ?? "";
    if (!repo || !agent || repo.length > 128 || agent.length > 64) return c.json({ error: "name the repository and the agent", code: "bad-range" }, 400);
    return c.json(await costRange(ctx, c.get("user"), repo, agent));
  });
  return app;
}
