import type { OrchestratorContext } from "./app.js";
import { OrchestratorError } from "./errors.js";
import { PLANS } from "./identities.js";
import type { Plan } from "./identities.js";

const PLAN_NAMES: Record<Plan, string> = { free: "Free", pro: "Pro" };

/** The organization's plan on a cloud orchestrator; a self-hosted orchestrator, and an organization with no record, is on Free. */
export async function orgPlan(ctx: Pick<OrchestratorContext, "store" | "tenant">): Promise<Plan> {
  return (await ctx.store.getOrg(ctx.tenant))?.plan ?? "free";
}

/**
 * The plan a screen marks what it opens by: the organization's on a cloud orchestrator, null on
 * any other, where plans do not apply and every feature is open.
 */
export async function shownPlan(ctx: Pick<OrchestratorContext, "store" | "tenant" | "mode">): Promise<Plan | null> {
  return ctx.mode === "cloud" ? orgPlan(ctx) : null;
}

/**
 * Refuses a feature the organization's plan does not open, with a 402 that names the feature
 * and the plan it needs, so the screen says why. A self-hosted orchestrator opens every feature:
 * plans belong to the cloud service, and the orchestrator a team runs itself keeps all it has.
 */
export async function requirePlan(ctx: Pick<OrchestratorContext, "store" | "tenant" | "mode">, needed: Plan, feature: string): Promise<void> {
  if (ctx.mode !== "cloud") return;
  const plan = await orgPlan(ctx);
  if (PLANS.indexOf(plan) >= PLANS.indexOf(needed)) return;
  throw new OrchestratorError("plan-required", `${feature} is part of the ${PLAN_NAMES[needed]} plan; this organization is on ${PLAN_NAMES[plan]}`, 402);
}
