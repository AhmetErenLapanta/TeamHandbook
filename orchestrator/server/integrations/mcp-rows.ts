import type { OrchestratorContext } from "../app.js";
import { manages } from "../auth.js";
import type { Principal } from "../auth.js";
import { localMode } from "../mode.js";
import { asksToSignIn } from "./claude-code-servers.js";
import { ownServerStates } from "./personal-mcp.js";

/** Where an MCP server a task can use comes from; the words for these are the page's. */
export type McpOrigin = "claude-user" | "claude-project" | "claude-plugin" | "claude-connector" | "orchestrator";

/**
 * One MCP server as the person's list shows it, whichever of their two places holds it: their own
 * Claude Code, or the orchestrator. Names and counts only, never a command, an address or a value.
 */
export interface McpRow {
  name: string;
  /** Both, when the same name is in Claude Code and in the orchestrator's own list: one row, not two. */
  origins: McpOrigin[];
  kind: "stdio" | "http" | "unknown" | null;
  needsSignIn: boolean;
  /** How the page signs it in on a press: Claude Code's own sign-in, or the orchestrator's, or none. */
  signIn: { via: "claude" | "orchestrator" } | null;
  /** The tools a task is allowed to call, for a server the orchestrator holds; null for one only Claude Code has. */
  tools: number | null;
}

const ORIGIN: Record<"user" | "project" | "plugin", McpOrigin> = { user: "claude-user", project: "claude-project", plugin: "claude-plugin" };

/**
 * The person's MCP servers in one list: those their Claude Code has (the setup probe's read, and a
 * connector a task found asking to sign in, which the probe does not read) joined with those they
 * added to the orchestrator by name. Only on one person's own orchestrator, only for its owner
 * signed in as a person; null otherwise. Null too until the probe has read once.
 */
export async function mcpRows(ctx: Pick<OrchestratorContext, "tasks" | "store" | "tenant" | "vault">, user: Principal): Promise<McpRow[] | null> {
  if (!localMode() || user.key || !manages(user) || !ctx.tasks) return null;
  const setup = ctx.tasks.lastPersonalSetup();
  void ctx.tasks.personalSetup();
  if (!setup) return null;
  const asking = await asksToSignIn(ctx);
  const rows = new Map<string, McpRow>();
  const key = (name: string) => name.toLowerCase();
  for (const s of setup.mcpServers) rows.set(key(s.name), { name: s.name, origins: [ORIGIN[s.scope]], kind: s.kind, needsSignIn: asking.has(s.name), signIn: asking.has(s.name) ? { via: "claude" } : null, tools: null });
  for (const name of asking) if (!rows.has(key(name))) rows.set(key(name), { name, origins: ["claude-connector"], kind: null, needsSignIn: true, signIn: { via: "claude" }, tools: null });
  for (const own of await ownServerStates(ctx, user.id)) {
    const row = rows.get(key(own.name));
    const needs = own.held === false;
    if (row) {
      row.origins.push("orchestrator");
      row.tools = own.tools;
      if (needs && !row.needsSignIn) Object.assign(row, { needsSignIn: true, signIn: { via: "orchestrator" } });
    } else {
      rows.set(key(own.name), { name: own.name, origins: ["orchestrator"], kind: own.kind, needsSignIn: needs, signIn: needs ? { via: "orchestrator" } : null, tools: own.tools });
    }
  }
  return [...rows.values()];
}
