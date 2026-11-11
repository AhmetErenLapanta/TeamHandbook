import type { OrchestratorContext } from "../app.js";
import { manages } from "../auth.js";
import type { Principal } from "../auth.js";

/**
 * An integration an admin turned on: what it was set up with, and who did it and when. Kept
 * as one setting per integration; a secret it needs (a webhook address) is sealed in the
 * vault under its own name and never sits here.
 */
export interface Enabled<T> {
  config: T;
  enabledBy: string;
  enabledAt: string;
}

const KEY = (id: string) => `integration.${id}`;

export async function readEnabled<T>(ctx: Pick<OrchestratorContext, "store" | "tenant">, id: string): Promise<Enabled<T> | null> {
  const raw = await ctx.store.getSetting(ctx.tenant, KEY(id));
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as Enabled<T>;
  } catch {
    return null;
  }
}

/** Saves the integration's settings; whoever first turned it on stays its `enabledBy` until it is turned off. */
export async function saveEnabled<T>(ctx: Pick<OrchestratorContext, "store" | "tenant">, id: string, config: T, user: Principal, now = new Date()): Promise<Enabled<T>> {
  const current = await readEnabled<T>(ctx, id);
  const record = { config, enabledBy: current?.enabledBy ?? user.name, enabledAt: current?.enabledAt ?? now.toISOString() };
  await ctx.store.setSetting(ctx.tenant, KEY(id), JSON.stringify(record));
  return record;
}

export async function removeEnabled(ctx: Pick<OrchestratorContext, "store" | "tenant">, id: string): Promise<void> {
  await ctx.store.deleteSetting(ctx.tenant, KEY(id));
}

/** Who changes the organization's integrations: those who manage it, owners and admins. */
export function managesIntegrations(user: Principal): boolean {
  return manages(user);
}
