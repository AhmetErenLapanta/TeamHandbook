import { Hono } from "hono";
import type { OrchestratorContext } from "./app.js";
import { canEditTeam, manages } from "./auth.js";
import type { OrchestratorEnv, Principal } from "./auth.js";
import { recordEvent } from "./events.js";
import { route } from "./route-scopes.js";
import { readsTask, seesTask } from "./tasks/guards.js";
import type { TaskRecord, TaskShare } from "./tasks/types.js";
import { normalizeEmail, principalOf } from "./accounts.js";
import { suspended } from "./scim.js";

const NOT_YOURS = { error: "unknown task" };

/**
 * Whether this caller names people to read the task: whoever started it or edits its team, signed
 * in. Someone it was shared with reads it too, but passes it on to nobody, so a share never widens
 * past the people its team trusts.
 */
export function sharesTask(user: Principal, task: Pick<TaskRecord, "team" | "createdBy">): boolean {
  return !user.key && user.role !== "viewer" && (canEditTeam(user, task.team) || task.createdBy === user.email || task.createdBy === user.id);
}

/** Who takes a share away: whoever gave it, the team's owners, and the organization's owners and admins. */
function unshares(user: Principal, task: TaskRecord, share: Pick<TaskShare, "sharedBy">): boolean {
  return !user.key && (share.sharedBy === user.id || canEditTeam(user, task.team) || manages(user));
}

/**
 * A task shown to one teammate who would not see it otherwise: someone in the same organization,
 * named by whoever can read the task, and given reading only. Nothing about a task reaches anyone
 * outside the organization this way, and nothing anyone does to the task is widened by it: stopping,
 * keeping, undoing and answering stay with the team's own rules.
 */
export function taskShareRoutes(ctx: OrchestratorContext): Hono<OrchestratorEnv> {
  const app = new Hono<OrchestratorEnv>();
  const store = ctx.store;
  const taskOf = (id: string) => store.getTask(ctx.tenant, id);
  const viewOf = async (share: TaskShare) => {
    const person = await store.getUser(ctx.tenant, share.userId);
    return { userId: share.userId, name: person?.name ?? share.userId, email: person?.email ?? null, sharedBy: share.sharedBy, at: share.at };
  };

  route(app, "GET /api/tasks/:id/shares", async (c) => {
    const task = await taskOf(c.req.param("id") ?? "");
    if (!task || !seesTask(c.get("user"), task)) return c.json(NOT_YOURS, 404);
    return c.json({ shares: await Promise.all((await store.listTaskShares(ctx.tenant, task.id)).map(viewOf)) });
  });

  route(app, "POST /api/tasks/:id/shares", async (c) => {
    const user = c.get("user");
    const task = await taskOf(c.req.param("id") ?? "");
    if (!task || !seesTask(user, task)) return c.json(NOT_YOURS, 404);
    if (!sharesTask(user, task)) return c.json({ error: "only whoever started the task or edits its team shares it" }, 403);
    const { email } = (await c.req.json().catch(() => ({}))) as { email?: unknown };
    let address: string;
    try {
      address = normalizeEmail(email);
    } catch {
      return c.json({ error: "enter the address of a member of this organization" }, 400);
    }
    const person = await store.getUserByEmail(ctx.tenant, address);
    // A member the directory turned off is as good as gone: nothing reaches them through a share.
    if (!person || (await suspended(store, ctx.tenant, person.id))) return c.json({ error: `${address} is not in this organization`, code: "not-a-member" }, 409);
    if (readsTask(await principalOf(store, person), task)) return c.json({ error: `${person.name} reads this task already`, code: "already-reads" }, 409);
    const share: TaskShare = { tenant: ctx.tenant, taskId: task.id, userId: person.id, sharedBy: user.id, at: new Date().toISOString() };
    await store.addTaskShare(share);
    await recordEvent(ctx, user, "task.shared", { subject: `task:${task.id}`, detail: `shared "${task.title}" with ${person.email} to read` });
    return c.json({ share: await viewOf(share) }, 201);
  });

  route(app, "DELETE /api/tasks/:id/shares/:userId", async (c) => {
    const user = c.get("user");
    const task = await taskOf(c.req.param("id") ?? "");
    if (!task || !seesTask(user, task)) return c.json(NOT_YOURS, 404);
    const share = (await store.listTaskShares(ctx.tenant, task.id)).find((s) => s.userId === c.req.param("userId"));
    if (!share || !unshares(user, task, share)) return c.json({ error: "no share of yours on this task" }, 404);
    await store.removeTaskShare(ctx.tenant, task.id, share.userId);
    await recordEvent(ctx, user, "task.unshared", { subject: `task:${task.id}`, detail: `stopped sharing "${task.title}" with ${(await viewOf(share)).email ?? share.userId}` });
    return c.body(null, 204);
  });

  return app;
}
