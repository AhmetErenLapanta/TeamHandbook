import { Hono } from "hono";
import type { OrchestratorContext } from "./app.js";
import { mirrorDir } from "./app.js";
import { AccountError } from "./accounts.js";
import { manages } from "./auth.js";
import type { OrchestratorEnv, Principal } from "./auth.js";
import { recordEvent } from "./events.js";
import { readTeamRecordAsync } from "./inventory.js";
import { USAGE_WINDOWS } from "../shared/activity.js";

/**
 * What the organization keeps and shows about people. Skill-use reporting is not a switch here:
 * a team reports only once a request asking it to is merged into its repository, and stops the
 * same way, so this page shows where each team stands and sends the change to that request.
 */
export interface PrivacyStore {
  getSetting(tenant: string, key: string): Promise<string | null>;
  setSetting(tenant: string, key: string, value: string): Promise<void>;
  /** Deletes task log lines written before `before`; the number deleted. */
  purgeTaskLog(tenant: string, before: string): Promise<number>;
  /** Deletes skill-use counts filed before `beforeHour`; the number deleted. */
  purgeUsage(tenant: string, beforeHour: string): Promise<number>;
}

export type LeaderboardAudience = "admins" | "members";

export interface Privacy {
  /** Who sees the usage leaderboard: owners and admins only, or every member. */
  leaderboard: LeaderboardAudience;
  /** Days a task's log lines are kept; the task itself and its request stay. */
  taskLogDays: number;
  /** Days skill-use counts are kept; older ones are deleted, not summed. */
  usageDays: number;
}

/**
 * Thirty days of task logs, as long as the request a task opened usually waits for review. A
 * year of skill use, and never less than the longest window a screen or an export reads, so
 * no chart or export is cut short by what this keeps.
 */
export const MIN_USAGE_DAYS = Math.max(...USAGE_WINDOWS);
export const MAX_USAGE_DAYS = 3650;
export const DEFAULT_PRIVACY: Privacy = { leaderboard: "admins", taskLogDays: 30, usageDays: 365 };
export const MAX_TASK_LOG_DAYS = 365;

export async function readPrivacy(store: PrivacyStore, tenant: string): Promise<Privacy> {
  const leaderboard = await store.getSetting(tenant, "privacy.leaderboard");
  const days = Number(await store.getSetting(tenant, "privacy.taskLogDays"));
  const usageDays = Number(await store.getSetting(tenant, "privacy.usageDays"));
  return {
    leaderboard: leaderboard === "members" ? "members" : DEFAULT_PRIVACY.leaderboard,
    taskLogDays: Number.isInteger(days) && days >= 1 && days <= MAX_TASK_LOG_DAYS ? days : DEFAULT_PRIVACY.taskLogDays,
    usageDays: Number.isInteger(usageDays) && usageDays >= MIN_USAGE_DAYS && usageDays <= MAX_USAGE_DAYS ? usageDays : DEFAULT_PRIVACY.usageDays,
  };
}

/** Whether this person sees the usage leaderboard; Activity's leaderboard asks this. */
export async function seesLeaderboard(store: PrivacyStore, tenant: string, user: Principal): Promise<boolean> {
  return manages(user) || (await readPrivacy(store, tenant)).leaderboard === "members";
}

export async function changePrivacy(store: PrivacyStore, tenant: string, actor: Principal, input: { leaderboard?: unknown; taskLogDays?: unknown; usageDays?: unknown }, now = new Date()): Promise<Privacy> {
  if (actor.key || !manages(actor)) throw new AccountError("only an owner or an admin signed in to the orchestrator changes privacy settings", 403);
  if (input.leaderboard !== undefined) {
    if (input.leaderboard !== "admins" && input.leaderboard !== "members") throw new AccountError("the leaderboard is shown to admins or to members");
    await store.setSetting(tenant, "privacy.leaderboard", input.leaderboard);
  }
  if (input.taskLogDays !== undefined) {
    const days = input.taskLogDays;
    if (!Number.isInteger(days) || (days as number) < 1 || (days as number) > MAX_TASK_LOG_DAYS) throw new AccountError(`task logs are kept 1 to ${MAX_TASK_LOG_DAYS} days`);
    await store.setSetting(tenant, "privacy.taskLogDays", String(days));
    await purgeTaskLogs(store, tenant, now);
  }
  if (input.usageDays !== undefined) {
    const days = input.usageDays;
    if (!Number.isInteger(days) || (days as number) < MIN_USAGE_DAYS || (days as number) > MAX_USAGE_DAYS) throw new AccountError(`skill use is kept ${MIN_USAGE_DAYS} to ${MAX_USAGE_DAYS} days`);
    await store.setSetting(tenant, "privacy.usageDays", String(days));
    await purgeUsageCounts(store, tenant, now);
  }
  return readPrivacy(store, tenant);
}

/** Deletes skill-use counts past the organization's retention; run with the task log purge. */
export async function purgeUsageCounts(store: PrivacyStore, tenant: string, now = new Date()): Promise<number> {
  const { usageDays } = await readPrivacy(store, tenant);
  return store.purgeUsage(tenant, new Date(now.getTime() - usageDays * 86_400_000).toISOString().slice(0, 13));
}

/** Deletes task log lines past the organization's retention; run by the hourly cleanup and when the retention shortens. */
export async function purgeTaskLogs(store: PrivacyStore, tenant: string, now = new Date()): Promise<number> {
  const { taskLogDays } = await readPrivacy(store, tenant);
  return store.purgeTaskLog(tenant, new Date(now.getTime() - taskLogDays * 86_400_000).toISOString());
}

export function privacyRoutes(ctx: OrchestratorContext): Hono<OrchestratorEnv> {
  const app = new Hono<OrchestratorEnv>();

  app.get("/api/privacy", async (c) => {
    if (!manages(c.get("user"))) return c.json({ error: "only an owner or an admin sees privacy settings" }, 403);
    const repos = await ctx.store.listRepos(ctx.tenant);
    const usage = await Promise.all(
      repos.map(async (r) => ({
        repoId: r.id,
        name: r.name,
        team: r.team,
        reporting: r.head ? Boolean((await readTeamRecordAsync(mirrorDir(ctx, r.id), r.head).catch(() => null))?.usageEndpoint) : null,
      })),
    );
    return c.json({ privacy: await readPrivacy(ctx.store, ctx.tenant), usage });
  });

  app.put("/api/privacy", async (c) => {
    try {
      const privacy = await changePrivacy(ctx.store, ctx.tenant, c.get("user"), await c.req.json().catch(() => ({})));
      await recordEvent(ctx, c.get("user"), "privacy.changed", { subject: "privacy", detail: `leaderboard shown to ${privacy.leaderboard}; task logs kept ${privacy.taskLogDays} days; skill use kept ${privacy.usageDays} days` });
      return c.json({ privacy });
    } catch (err) {
      if (err instanceof AccountError) return c.json({ error: err.message }, err.status);
      throw err;
    }
  });

  return app;
}
