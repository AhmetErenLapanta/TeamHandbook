import type { OrchestratorContext } from "../app.js";
import { manages } from "../auth.js";
import type { Principal } from "../auth.js";
import { localMode } from "../mode.js";
import { ownCliHere } from "../forge/own-cli-here.js";

/**
 * How many MCP servers the person's own Claude Code has, which the tasks they start use as they
 * are: a count, never a name, command, address or value. Only on one person's own orchestrator
 * and only to its owner signed in, never to an API key. Null when the runner's probe has not read
 * yet, and a read is begun.
 */
export function claudeCodeServers(ctx: Pick<OrchestratorContext, "tasks">, user: Principal): number | null {
  if (!localMode() || user.key || !manages(user) || !ctx.tasks) return null;
  const setup = ctx.tasks.lastPersonalSetup();
  void ctx.tasks.personalSetup();
  return setup ? setup.mcpServers.length : null;
}

/** How many of the latest tasks are read for the servers they found asking to sign in. */
const LATEST_TASKS = 20;

/**
 * The server of the person's own Claude Code a sign-in is asked for, when it is one Claude Code
 * itself named: one the probe read, or one a task of theirs found asking to sign in. Only on one
 * person's own orchestrator, only for its owner signed in as a person, never an API key; null for
 * anything else, so the answer does not tell a stranger what the person's Claude Code has.
 */
export async function claudeMcpName(ctx: Pick<OrchestratorContext, "tasks" | "store" | "tenant" | "ownForgeCli">, user: Principal, raw: string): Promise<string | null> {
  const tasks = ctx.tasks;
  if (!tasks || !(await claudeOwner(ctx, user))) return null;
  if (!/^[^\p{C}]{1,200}$/u.test(raw)) return null;
  const known = new Set(tasks.lastPersonalSetup()?.mcpServers.map((s) => s.name) ?? []);
  if (!known.has(raw)) for (const name of await asksToSignIn(ctx)) known.add(name);
  return known.has(raw) ? raw : null;
}

/** The servers the latest tasks found asking to sign in, by the name Claude Code showed them under. */
export async function asksToSignIn(ctx: Pick<OrchestratorContext, "store" | "tenant">): Promise<Set<string>> {
  const names = new Set<string>();
  for (const task of (await ctx.store.listTasks(ctx.tenant)).slice(0, LATEST_TASKS)) for (const name of task.mcpNeedsSignIn ?? []) names.add(name);
  return names;
}

/**
 * Whether this person can change the MCP servers of their own Claude Code from the page: the owner
 * of an orchestrator only they reach, signed in as a person, on a machine where it is the one
 * person's. The same gate for every route that signs in, adds or removes one.
 */
export async function claudeOwner(ctx: Pick<OrchestratorContext, "tasks" | "store" | "tenant" | "ownForgeCli">, user: Principal): Promise<boolean> {
  return localMode() && !user.key && manages(user) && Boolean(ctx.tasks) && (await ownCliHere(ctx));
}
