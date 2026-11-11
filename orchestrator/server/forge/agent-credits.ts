import { Hono } from "hono";
import { AGENTS } from "../ai-requests.js";
import type { OrchestratorContext } from "../app.js";
import { canEditTeam } from "../auth.js";
import type { OrchestratorEnv } from "../auth.js";
import { recordEvent } from "../events.js";
import { route } from "../route-scopes.js";

/**
 * A task's commits carry only lines the orchestrator writes, but its request's description quotes
 * the agent's report, and a forge that squashes with the description writes that into history:
 * a "Co-authored-by: Claude" or "Generated with Claude Code" line there credits the agent in the
 * team's log. A team that does not want that turns this on for a repository, and the description
 * the orchestrator opens a request with leaves those lines out. Off unless turned on; lines
 * inside a fenced block are the report's quoted text and stay.
 */
const settingKey = (repoId: string) => `forge.agentCredits.${repoId}`;

export function withoutAgentCredits(text: string): string {
  let fenced = false;
  const kept: string[] = [];
  for (const line of text.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    if (!fenced && AGENTS.some((agent) => agent.pattern.test(line))) continue;
    kept.push(line);
  }
  return kept.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd();
}

export async function removesAgentCredits(ctx: Pick<OrchestratorContext, "store" | "tenant">, repoId: string): Promise<boolean> {
  return (await ctx.store.getSetting(ctx.tenant, settingKey(repoId))) === "remove";
}

/** The repository's choice, read by anyone who reads the repository and changed by whoever can change its team. */
export function agentCreditRoutes(ctx: OrchestratorContext): Hono<OrchestratorEnv> {
  const app = new Hono<OrchestratorEnv>();
  const ID = /^[a-z0-9][a-z0-9-]{0,62}$/;

  route(app, "GET /api/repos/:id/agent-credits", async (c) => {
    const id = c.req.param("id") ?? "";
    const repo = ID.test(id) ? await ctx.store.getRepo(ctx.tenant, id) : null;
    if (!repo) return c.json({ error: "unknown repository" }, 404);
    return c.json({ remove: await removesAgentCredits(ctx, repo.id) });
  });

  route(app, "PUT /api/repos/:id/agent-credits", async (c) => {
    const id = c.req.param("id") ?? "";
    const repo = ID.test(id) ? await ctx.store.getRepo(ctx.tenant, id) : null;
    if (!repo) return c.json({ error: "unknown repository" }, 404);
    const user = c.get("user");
    if (user.key || !canEditTeam(user, repo.team)) return c.json({ error: "only someone who can change this team's repositories, signed in, changes this" }, 403);
    const body = (await c.req.json().catch(() => ({}))) as { remove?: unknown };
    if (typeof body.remove !== "boolean") return c.json({ error: "say whether to remove the agent's credit lines: remove true or false" }, 400);
    if (body.remove) await ctx.store.setSetting(ctx.tenant, settingKey(repo.id), "remove");
    else await ctx.store.deleteSetting(ctx.tenant, settingKey(repo.id));
    await recordEvent(ctx, user, "repo.agent-credits", { repoId: repo.id, subject: `repo:${repo.id}`, detail: body.remove ? `the descriptions of ${repo.name}'s requests leave out the agent's credit lines` : `the descriptions of ${repo.name}'s requests keep the agent's credit lines` });
    return c.json({ remove: body.remove });
  });

  return app;
}
