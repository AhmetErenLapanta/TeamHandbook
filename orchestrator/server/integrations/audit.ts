import type { OrchestratorContext } from "../app.js";
import type { Principal } from "../auth.js";

/** One row of the orchestrator's event log, in the shape the log's `recordEvent` takes. */
export type Audit = (actor: Principal, kind: string, fields: { repoId?: string | null; subject?: string | null; detail: string }) => Promise<void>;

export class NoEventLog extends Error {
  constructor() {
    super("this orchestrator keeps no event log, and its MCP server runs no call the log does not record");
  }
}

/**
 * Records what an integration did. A call through the orchestrator's MCP server is refused when it
 * cannot be recorded: that server is reached from outside the browser, and a change it made
 * that the log would not show is one an admin cannot account for afterwards.
 */
export async function auditRequired(ctx: Pick<OrchestratorContext, "audit">, actor: Principal, kind: string, fields: { repoId?: string | null; subject?: string | null; detail: string }): Promise<void> {
  if (!ctx.audit) throw new NoEventLog();
  await ctx.audit(actor, kind, fields);
}

/** Records a settings change on the Integrations page, where a log exists. */
export async function auditChange(ctx: Pick<OrchestratorContext, "audit">, actor: Principal, kind: string, fields: { repoId?: string | null; subject?: string | null; detail: string }): Promise<void> {
  if (ctx.audit) await ctx.audit(actor, kind, fields);
}
