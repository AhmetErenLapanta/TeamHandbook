import type { OrchestratorContext } from "./app.js";
import type { Quotas } from "./identities.js";

/** Each limit an organization's plan carries, by the setting that gives it on a cloud orchestrator. */
const QUOTA_SETTINGS: Record<keyof Quotas, string> = {
  members: "ORCHESTRATOR_QUOTA_MEMBERS",
  tasksPerMonth: "ORCHESTRATOR_QUOTA_TASKS_PER_MONTH",
  concurrentTasks: "ORCHESTRATOR_QUOTA_CONCURRENT_TASKS",
};

const NO_LIMITS: Quotas = { members: null, tasksPerMonth: null, concurrentTasks: null };

/** A limit as its setting gives it: unlimited when left out or "unlimited", undefined when it is no positive whole number. */
function quotaValue(env: NodeJS.ProcessEnv, name: string): number | null | undefined {
  const raw = env[name]?.trim();
  if (!raw || raw === "unlimited") return null;
  return /^[1-9][0-9]{0,8}$/.test(raw) ? Number(raw) : undefined;
}

/**
 * The limits a cloud orchestrator refuses to start with: one given that is neither a positive whole
 * number nor "unlimited". Every organization is on the free plan today and has no limit, so a limit
 * left out is unlimited; the limits are ready in code for the plan that will carry them.
 */
export function quotaSettingsRefused(env: NodeJS.ProcessEnv = process.env): string[] {
  return Object.values(QUOTA_SETTINGS)
    .filter((name) => quotaValue(env, name) === undefined)
    .map((name) => `${name} (a positive whole number or unlimited)`);
}

/** The limits a new organization on a cloud orchestrator starts with, none unless a setting gives one; a self-hosted orchestrator never reads them. */
export function quotaSettings(env: NodeJS.ProcessEnv = process.env): Quotas {
  const limit = (key: keyof Quotas): number | null => {
    const value = quotaValue(env, QUOTA_SETTINGS[key]);
    if (value === undefined) throw new Error(`ORCHESTRATOR_MODE=cloud needs ${QUOTA_SETTINGS[key]} to be a positive whole number or unlimited`);
    return value;
  };
  return { members: limit("members"), tasksPerMonth: limit("tasksPerMonth"), concurrentTasks: limit("concurrentTasks") };
}

/** The organization's limits, none when it has no organization record, as on a self-hosted orchestrator. */
export async function orgQuota(ctx: Pick<OrchestratorContext, "store" | "tenant">): Promise<Quotas> {
  return (await ctx.store.getOrg(ctx.tenant))?.quotas ?? NO_LIMITS;
}
