import { Hono } from "hono";
import type { OrchestratorContext } from "./app.js";
import { manages } from "./auth.js";
import type { OrchestratorEnv } from "./auth.js";
import { ownCliHere } from "./forge/own-cli-here.js";
import { route } from "./route-scopes.js";
import type { TaskRunner } from "./tasks/runner.js";

/**
 * The one step that puts the handbook plugin in a person's Claude Code, taken when they press
 * Install. Only the person whose orchestrator it is and that nobody else reaches: the plugin
 * lands in their own Claude Code, so a team's server never installs anything on its own.
 */
export function handbookPluginRoutes(ctx: OrchestratorContext, runner: TaskRunner): Hono<OrchestratorEnv> {
  const app = new Hono<OrchestratorEnv>();
  route(app, "POST /api/handbook/plugin", async (c) => {
    if (!manages(c.get("user")) || !(await ownCliHere(ctx))) return c.json({ error: "your Claude Code is reached only by an orchestrator on your own machine that you alone use; type the two commands in Claude Code yourself" }, 409);
    return c.json(await runner.installHandbookPlugin());
  });
  return app;
}
