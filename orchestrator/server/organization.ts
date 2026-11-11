import { Hono } from "hono";
import type { OrchestratorContext } from "./app.js";
import type { OrchestratorEnv } from "./auth.js";
import { OrchestratorError } from "./errors.js";
import { recordEvent } from "./events.js";
import { detectSecret } from "./plugin.js";

/** The setting that holds the name an org is shown by; absent, it is shown by its tenant. */
export const ORG_NAME_SETTING = "org.name";
export const ORG_NAME_MAX = 80;

export interface OrganizationView {
  tenant: string;
  name: string;
}

export async function orgName(store: OrchestratorContext["store"], tenant: string): Promise<string> {
  return (await store.getSetting(tenant, ORG_NAME_SETTING)) ?? tenant;
}

/** The name as given, trimmed, or the reason it is refused: it is shown to every member and in every page title. */
export function checkedName(value: unknown): string {
  const name = typeof value === "string" ? value.trim() : "";
  if (!name) throw new OrchestratorError("org-name", "name the organization to continue");
  if (name.length > ORG_NAME_MAX || /\p{C}/u.test(name)) throw new OrchestratorError("org-name", `an organization's name is at most ${ORG_NAME_MAX} characters with no control character`);
  if (detectSecret(name)) throw new OrchestratorError("org-name", "that name looks like it contains a secret");
  return name;
}

/**
 * The org's name as people see it, which its owners change from the screen. The tenant stays:
 * it keys the org's data, its addresses and its sessions, and organizations are added and
 * removed in the configuration file, where the operator who runs the orchestrator keeps them.
 */
export function organizationRoutes(ctx: OrchestratorContext): Hono<OrchestratorEnv> {
  const app = new Hono<OrchestratorEnv>();

  app.get("/api/org", async (c) => c.json({ tenant: ctx.tenant, name: await orgName(ctx.store, ctx.tenant) } satisfies OrganizationView));

  app.put("/api/org", async (c) => {
    const user = c.get("user");
    if (user.role !== "owner") throw new OrchestratorError("forbidden", "only an owner renames the organization", 403);
    const name = checkedName(((await c.req.json().catch(() => ({}))) as { name?: unknown }).name);
    const was = await orgName(ctx.store, ctx.tenant);
    if (name === was) return c.json({ tenant: ctx.tenant, name } satisfies OrganizationView);
    await ctx.store.setSetting(ctx.tenant, ORG_NAME_SETTING, name);
    await recordEvent(ctx, user, "org.renamed", { subject: `org:${ctx.tenant}`, detail: `renamed the organization from "${was}" to "${name}"` });
    return c.json({ tenant: ctx.tenant, name } satisfies OrganizationView);
  });

  return app;
}
