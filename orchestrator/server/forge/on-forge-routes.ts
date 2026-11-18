import { Hono } from "hono";
import type { OrchestratorContext } from "../app.js";
import { canEditTeam } from "../auth.js";
import type { OrchestratorEnv } from "../auth.js";
import { route } from "../route-scopes.js";
import { seesRequest } from "./request-access.js";
import { MachineRequestRefused, openKeptChange } from "./machine-request.js";
import { OnForgeRefused, openRequestOnForge, readOnce, requestOnForge } from "./pushed.js";
import { onMachineForge } from "./unconnected.js";

const ID = /^[a-z0-9][a-z0-9-]{0,62}$/;

/**
 * A request of a repository read by path, on the GitLab or GitHub its clone's origin is: whether a
 * press opens it there, and the press itself. Nothing reaches the forge without that press.
 */
export function onForgeRoutes(ctx: OrchestratorContext): Hono<OrchestratorEnv> {
  const app = new Hono<OrchestratorEnv>();

  const visible = async (id: string, number: number, user: OrchestratorEnv["Variables"]["user"]) => {
    const repo = ID.test(id) && Number.isInteger(number) && number > 0 ? await ctx.store.getRepo(ctx.tenant, id) : null;
    const request = repo ? await ctx.store.getRequest(ctx.tenant, id, number) : null;
    return repo && request && (await seesRequest(ctx, user, repo, number, request)) ? { repo, request } : null;
  };

  route(app, "GET /api/repos/:id/requests/:number/on-forge", async (c) => {
    const seen = await visible(c.req.param("id") ?? "", Number(c.req.param("number")), c.get("user"));
    if (!seen) return c.json({ error: "unknown request" }, 404);
    return c.json(await requestOnForge(ctx, seen.repo, seen.request.number, c.get("user")));
  });

  route(app, "POST /api/repos/:id/requests/:number/on-forge", async (c) => {
    const user = c.get("user");
    const seen = await visible(c.req.param("id") ?? "", Number(c.req.param("number")), user);
    if (!seen) return c.json({ error: "unknown request" }, 404);
    if (!canEditTeam(user, seen.repo.team)) return c.json({ error: `only someone who changes ${seen.repo.name} opens its request on its forge` }, 403);
    try {
      return c.json(await openRequestOnForge(ctx, seen.repo, seen.request, user));
    } catch (err) {
      if (!(err instanceof OnForgeRefused)) throw err;
      return c.json({ error: err.message, code: err.code, ...(err.createUrl ? { createUrl: err.createUrl } : {}) }, err.status);
    }
  });

  // A change kept on a machine that its starter's press opened on a forge, read once for its starter's page.
  route(app, "GET /api/tasks/:id/targets/:position/on-forge", async (c) => {
    const user = c.get("user");
    const position = Number(c.req.param("position"));
    const task = await ctx.store.getTask(ctx.tenant, c.req.param("id") ?? "");
    const target = task && Number.isInteger(position) && position >= 0 ? task.targets?.[position] : undefined;
    if (!task || !target || (task.createdBy !== user.email && task.createdBy !== user.id)) return c.json({ error: "unknown change" }, 404);
    const opened = await onMachineForge(ctx, target, user);
    if (!opened) return c.json({ error: "this change was not opened on a forge" }, 404);
    return c.json({ onForge: await readOnce(opened) });
  });

  route(app, "POST /api/tasks/:id/targets/:position/on-forge", async (c) => {
    const position = Number(c.req.param("position"));
    if (!Number.isInteger(position) || position < 0) return c.json({ error: "unknown change" }, 404);
    try {
      return c.json({ target: await openKeptChange(ctx, c.get("user"), c.req.param("id") ?? "", position) });
    } catch (err) {
      if (!(err instanceof MachineRequestRefused)) throw err;
      return c.json({ error: err.message, code: err.code }, err.status);
    }
  });

  return app;
}
