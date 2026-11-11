import type { OrchestratorContext } from "../app.js";
import { manages } from "../auth.js";
import type { Principal } from "../auth.js";
import { localMode } from "../mode.js";

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
