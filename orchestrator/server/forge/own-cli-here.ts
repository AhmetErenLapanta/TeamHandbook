import type { OrchestratorContext } from "../app.js";
import { onePersonRefusal } from "../tasks/profile.js";

/**
 * Whether the person's own gh or glab is used now, asked at each use. An orchestrator only this
 * machine reaches turns it on when it starts (`ownForgeCli`), but the machine's own sign-in is one
 * person's: once a second account, or a service account, is here, nothing more goes out with it,
 * so one member's task is never pushed or opened as another's. A token or the organization's
 * connection is the way then.
 */
export async function ownCliHere(ctx: Pick<OrchestratorContext, "ownForgeCli" | "store" | "tenant">, env: Record<string, string | undefined> = process.env): Promise<boolean> {
  return Boolean(ctx.ownForgeCli) && (await onePersonRefusal(ctx, env)) === null;
}
