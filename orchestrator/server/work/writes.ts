import type { OrchestratorContext } from "../app.js";
import type { WorkKind } from "../../shared/work.js";

const NAME: Record<WorkKind, string> = { jira: "Jira", gitlab: "GitLab", github: "GitHub", linear: "Linear" };

/**
 * Whether the orchestrator moves issues in the tracker: a card moved on Work and a task's moment
 * read it. Off until an owner or an admin turns it on, so the orchestrator reads a team's tracker
 * and changes nothing there unasked; a task's agent never changes an issue, whatever it says.
 */
export const TRACKER_WRITES = "tracker.task-writes";

export async function writesOn(ctx: Pick<OrchestratorContext, "store" | "tenant">): Promise<boolean> {
  return (await ctx.store.getSetting(ctx.tenant, TRACKER_WRITES)) === "allowed";
}

export async function saveWrites(ctx: Pick<OrchestratorContext, "store" | "tenant">, on: boolean): Promise<void> {
  if (on) await ctx.store.setSetting(ctx.tenant, TRACKER_WRITES, "allowed");
  else await ctx.store.deleteSetting(ctx.tenant, TRACKER_WRITES);
}

/** The one line a board says while changing issues is off, naming where it is turned on. */
export const writesOff = (kind: WorkKind) => `Changing issues in ${NAME[kind]} is off, so a card that moves here changes nothing there. An owner or an admin turns it on under Integrations.`;
