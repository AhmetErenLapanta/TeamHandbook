import { createHash, randomBytes } from "node:crypto";
import type { OrchestratorContext } from "./app.js";
import { principalOf } from "./accounts.js";
import type { Principal } from "./auth.js";
import { servicePrincipal } from "./keys.js";
import type { Scopes } from "./keys.js";
import { suspended } from "./scim.js";
import type { TaskRecord } from "./tasks/types.js";

/**
 * The credential a task's agent calls the orchestrator with, for delegating work to child tasks
 * and reading their state. Made when the task starts and ended with it; only its SHA-256 is kept,
 * in a settings row of the organization, so every node checks it and a copy of the database opens
 * nothing. It speaks for whoever started the task, read fresh on each call and capped at starting
 * and reading tasks and opening requests: an agent never manages members, settings or keys.
 * It carries a prefix of its own, so no route that takes API keys mistakes it for one.
 */
export const TASK_TOKEN_PREFIX = "th_tt_";
const SETTING = "task.token.";
/** How long a token outlives a task that never revokes it, such as one on a node that stopped. */
export const TASK_TOKEN_HOURS = 24;

/** What a task's agent reaches through the orchestrator, whatever its starter reaches. */
export const TASK_TOKEN_SCOPES: Scopes = { repositories: "read", requests: "write", tasks: "write", usage: "none", members: "none", settings: "none", keys: "none" };

interface Held {
  taskId: string;
  expiresAt: string;
}

const digest = (token: string) => createHash("sha256").update(token).digest("hex");

export async function mintTaskToken(ctx: Pick<OrchestratorContext, "store" | "tenant">, task: Pick<TaskRecord, "id">, now = new Date()): Promise<{ token: string; revoke: () => Promise<void> }> {
  const token = `${TASK_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
  const key = `${SETTING}${digest(token)}`;
  const held: Held = { taskId: task.id, expiresAt: new Date(now.getTime() + TASK_TOKEN_HOURS * 3_600_000).toISOString() };
  await ctx.store.setSetting(ctx.tenant, key, JSON.stringify(held));
  return { token, revoke: () => ctx.store.deleteSetting(ctx.tenant, key) };
}

/**
 * The task a bearer speaks for and its starter as they are now, or null: a token this
 * organization never made, one revoked or past its time, a task no longer queued or running, or
 * a starter removed or turned off since. The principal carries the token's cap as its grant, so
 * every check that refuses a key refuses the agent too.
 */
export async function verifyTaskToken(ctx: Pick<OrchestratorContext, "store" | "tenant">, bearer: string, now = new Date()): Promise<{ taskId: string; user: Principal } | null> {
  if (!bearer.startsWith(TASK_TOKEN_PREFIX)) return null;
  const key = `${SETTING}${digest(bearer)}`;
  const raw = await ctx.store.getSetting(ctx.tenant, key);
  if (!raw) return null;
  let held: Held;
  try {
    held = JSON.parse(raw) as Held;
  } catch {
    return null;
  }
  if (held.expiresAt <= now.toISOString()) {
    await ctx.store.deleteSetting(ctx.tenant, key);
    return null;
  }
  const task = await ctx.store.getTask(ctx.tenant, held.taskId);
  if (!task || (task.status !== "queued" && task.status !== "running")) return null;
  const starter = await starterOf(ctx, task.createdBy);
  if (!starter) return null;
  return { taskId: task.id, user: { ...starter, key: { id: `task:${task.id}`, owner: { kind: starter.id.startsWith("service:") ? "service" : "user", id: starter.id.replace(/^service:/, "") }, scopes: TASK_TOKEN_SCOPES, expiresAt: held.expiresAt } } };
}

/** Whoever started a task, by the id or address it recorded, while they still belong to the organization and are not turned off. */
async function starterOf(ctx: Pick<OrchestratorContext, "store" | "tenant">, createdBy: string): Promise<Principal | null> {
  if (createdBy.startsWith("service:")) {
    const account = await ctx.store.getServiceAccount(ctx.tenant, createdBy.slice("service:".length));
    return account ? servicePrincipal(ctx.store, account) : null;
  }
  const user = (await ctx.store.getUser(ctx.tenant, createdBy)) ?? (await ctx.store.getUserByEmail(ctx.tenant, createdBy));
  if (!user || (await suspended(ctx.store, ctx.tenant, user.id))) return null;
  return principalOf(ctx.store, user);
}
