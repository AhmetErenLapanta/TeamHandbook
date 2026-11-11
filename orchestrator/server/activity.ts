import { Hono } from "hono";
import type { Context } from "hono";
import type { ActivitySummary, Leaderboard, MarkedStep, Onboarding, SkippedStep, UsageReport } from "../shared/activity.js";
import { MARKED_STEPS, SKIPPABLE_STEPS, USAGE_WINDOWS } from "../shared/activity.js";
import { csvLines } from "../shared/csv.js";
import type { OrchestratorContext } from "./app.js";
import { inConfiguration } from "./app.js";
import { AccountError } from "./accounts.js";
import type { OrchestratorEnv, Principal } from "./auth.js";
import { canEditTeam, manages } from "./auth.js";
import { recordEvent } from "./events.js";
import { localRepoPath } from "./forge/local.js";
import { readTracker } from "./integrations/tracker.js";
import { journey } from "./journey.js";
import type { Journey } from "../shared/journey.js";
import { seesLeaderboard } from "./privacy.js";
import { visibleTasks } from "./tasks/guards.js";
import { taskPhase } from "./tasks/phase.js";
import type { TaskRecord } from "./tasks/types.js";
import type { RepoRecord, Store } from "./store.js";
import type { DailyUsage } from "./usage.js";
import type { UsageCount } from "../shared/activity.js";

const DAY = 86_400_000;
const REPO_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** The hour bucket a usage count is filed under, `days` ago. */
export function hourDaysAgo(days: number, now = Date.now()): string {
  return new Date(now - days * DAY).toISOString().slice(0, 13);
}

/** Every day of the window, oldest first and ending today, with the days nothing was used at zero. */
export function dailySeries(rows: DailyUsage[], days: number, now = Date.now()): { day: string; count: number }[] {
  const totals = new Map<string, number>();
  for (const row of rows) totals.set(row.day, (totals.get(row.day) ?? 0) + row.count);
  return Array.from({ length: days }, (_, i) => {
    const day = new Date(now - (days - 1 - i) * DAY).toISOString().slice(0, 10);
    return { day, count: totals.get(day) ?? 0 };
  });
}

export function usageReport(rows: DailyUsage[], repos: RepoRecord[], days: number, now = Date.now()): UsageReport {
  const byRepo = new Map(repos.map((r) => [r.id, r]));
  const teams = new Map<string, number>();
  const skills = new Map<string, UsageReport["bySkill"][number]>();
  for (const row of rows) {
    const repo = byRepo.get(row.repoId);
    const team = repo?.team ?? row.repoId;
    teams.set(team, (teams.get(team) ?? 0) + row.count);
    const key = `${row.repoId}/${row.skill}`;
    const seen = skills.get(key) ?? { repoId: row.repoId, repo: repo?.name ?? row.repoId, team, skill: row.skill, count: 0 };
    seen.count += row.count;
    skills.set(key, seen);
  }
  const ranked = <T extends { count: number }>(list: T[], name: (t: T) => string) => list.sort((a, b) => b.count - a.count || name(a).localeCompare(name(b)));
  const series = dailySeries(rows, days, now);
  return {
    days,
    series,
    total: series.reduce((n, d) => n + d.count, 0),
    byTeam: ranked([...teams].map(([team, count]) => ({ team, count })), (t) => t.team),
    bySkill: ranked([...skills.values()], (s) => `${s.team}/${s.skill}`),
  };
}

/** The overview's most used skills, from the teams this person sees. */
function topSeen(usage: readonly UsageCount[], repos: readonly RepoRecord[], seen: Breakdown): UsageCount[] {
  const teamOf = new Map(repos.map((r) => [r.id, r.team]));
  return usage.filter((u) => seesTeam(seen, teamOf.get(u.repoId) ?? u.repoId)).slice(0, 3);
}

export function usageCsv(rows: DailyUsage[], repos: RepoRecord[]): string {
  const byRepo = new Map(repos.map((r) => [r.id, r]));
  return csvLines(["day", "team", "repository", "skill", "count"], rows.map((row) => [row.day, byRepo.get(row.repoId)?.team ?? "", byRepo.get(row.repoId)?.name ?? row.repoId, row.skill, row.count]));
}

/**
 * Whose rows a person sees broken down by team and skill: everyone's ("all"), only the teams
 * they can change, or nobody's, which leaves them the organization's totals.
 */
export type Breakdown = "all" | Set<string> | null;

export function breakdownFor(user: Principal, seesAll: boolean, repos: readonly RepoRecord[]): Breakdown {
  if (seesAll || manages(user)) return "all";
  const own = new Set(repos.map((r) => r.team).filter((team) => canEditTeam(user, team)));
  return own.size ? own : null;
}

/** Whether a team's rows are among those this person sees. */
export function seesTeam(seen: Breakdown, team: string): boolean {
  return seen === "all" || (seen !== null && seen.has(team));
}

/** Whose usage this person sees, under the organization's privacy setting: the one rule every usage read applies. */
export async function usageBreakdown(ctx: OrchestratorContext, user: Principal, repos: readonly RepoRecord[]): Promise<Breakdown> {
  return breakdownFor(user, await seesLeaderboard(ctx.store, ctx.tenant, user), repos);
}

/** The report as this person reads it: the totals stay, the breakdown keeps only the teams they see. */
export function scopedReport(report: UsageReport, seen: Breakdown): UsageReport {
  if (seen === "all") return report;
  if (!seen) return { ...report, byTeam: [], bySkill: [] };
  return { ...report, byTeam: report.byTeam.filter((t) => seen.has(t.team)), bySkill: report.bySkill.filter((s) => seen.has(s.team)), scope: { teams: [...seen].sort() } };
}

const DISMISSED = "onboarding.dismissed";
const MARKED = "onboarding.marked";
const SKIPPED = "onboarding.skipped";

interface OnboardingStore { getSetting(tenant: string, key: string): Promise<string | null>; setSetting(tenant: string, key: string, value: string): Promise<void> }

export async function readOnboarding(store: OnboardingStore, tenant: string): Promise<Onboarding> {
  const marked = JSON.parse((await store.getSetting(tenant, MARKED)) ?? "[]") as unknown;
  const skipped = JSON.parse((await store.getSetting(tenant, SKIPPED)) ?? "[]") as unknown;
  return {
    dismissed: (await store.getSetting(tenant, DISMISSED)) === "yes",
    marked: Array.isArray(marked) ? MARKED_STEPS.filter((s) => marked.includes(s)) : [],
    skipped: Array.isArray(skipped) ? SKIPPABLE_STEPS.filter((s) => skipped.includes(s)) : [],
  };
}

/**
 * Hides or shows the guide and marks steps for the whole organization. Only an owner or an
 * admin changes it, signed in rather than through a key, since it changes what everyone sees.
 */
export async function changeOnboarding(store: OnboardingStore, tenant: string, actor: Principal, input: { dismissed?: unknown; marked?: unknown; skipped?: unknown }): Promise<Onboarding> {
  if (actor.key || !manages(actor)) throw new AccountError("only an owner or an admin signed in to the orchestrator changes the getting-started guide", 403);
  if (input.dismissed !== undefined && typeof input.dismissed !== "boolean") throw new AccountError("dismissed is true or false");
  if (input.marked !== undefined && (!Array.isArray(input.marked) || input.marked.some((s) => !(MARKED_STEPS as readonly unknown[]).includes(s)))) {
    throw new AccountError(`a step marked by hand is one of ${MARKED_STEPS.join(", ")}`);
  }
  if (input.skipped !== undefined && (!Array.isArray(input.skipped) || input.skipped.some((s) => !(SKIPPABLE_STEPS as readonly unknown[]).includes(s)))) {
    throw new AccountError(`a step left for later is one of ${SKIPPABLE_STEPS.join(", ")}`);
  }
  if (input.dismissed !== undefined) await store.setSetting(tenant, DISMISSED, input.dismissed ? "yes" : "no");
  if (input.skipped !== undefined) await store.setSetting(tenant, SKIPPED, JSON.stringify([...new Set(input.skipped as SkippedStep[])]));
  if (input.marked !== undefined) await store.setSetting(tenant, MARKED, JSON.stringify([...new Set(input.marked as MarkedStep[])]));
  return readOnboarding(store, tenant);
}

/**
 * Reads behind the Activity pages, mounted behind the orchestrator's sign-in.
 */
/**
 * One of Activity's recent tasks with what the task list reads a person's decision from: its phase,
 * whether its changes were undone or kept, and the status of each request it opened.
 */
export async function recentTask(store: Pick<Store, "getRequest">, tenant: string, t: TaskRecord): Promise<ActivitySummary["tasks"]["recent"][number]> {
  const opened = [...(t.requestNumber !== null ? [{ repoId: t.repoId, number: t.requestNumber }] : []), ...(t.targets ?? []).flatMap((x) => (x.requestNumber !== null ? [{ repoId: x.repoId, number: x.requestNumber }] : []))];
  const read = new Map((await Promise.all(opened.map((p) => store.getRequest(tenant, p.repoId, p.number)))).filter((r) => r !== null).map((r) => [`${r.repoId}#${r.number}`, r.status]));
  const own = t.requestNumber !== null ? read.get(`${t.repoId}#${t.requestNumber}`) : undefined;
  return {
    id: t.id, title: t.title, team: t.team, status: t.status, createdAt: t.createdAt,
    phase: taskPhase(t, (repoId, number) => read.get(`${repoId}#${number}`) ?? null),
    result: t.result ?? null,
    changes: t.changes ? { undone: Boolean(t.changes.undone), kept: Boolean(t.changes.kept) } : null,
    request: own ? { status: own } : null,
    requests: (t.targets ?? []).flatMap((x) => {
      const status = x.requestNumber !== null ? read.get(`${x.repoId}#${x.requestNumber}`) : undefined;
      return status ? [{ status }] : [];
    }),
  };
}

export function activityRoutes(ctx: OrchestratorContext): Hono<OrchestratorEnv> {
  const app = new Hono<OrchestratorEnv>();

  // One read for the overview: what the getting-started steps check and what the tiles show,
  // answered from the store so the page does not open every repository to draw itself.
  app.get("/api/activity/summary", async (c) => {
    const [repos, requests, members, usage, tasks] = await Promise.all([
      ctx.store.listRepos(ctx.tenant),
      ctx.store.requestPage(ctx.tenant, {}, null, 1),
      ctx.store.countUsers(ctx.tenant),
      ctx.store.usage(ctx.tenant, hourDaysAgo(30)),
      ctx.store.taskSpendRows(ctx.tenant, {}),
    ]);
    const recent = (await ctx.store.taskPage(ctx.tenant, visibleTasks(c.get("user")), null, 3)).tasks;
    // A repository read by path opens its requests on the orchestrator's own copy; one on a forge needs forge access to open them there.
    const hosted = repos.filter((r) => inConfiguration(ctx, r.id) && localRepoPath(r.url) === null);
    const connected = (await Promise.all(hosted.map((r) => ctx.store.getForgeConfig(ctx.tenant, r.id)))).filter(Boolean).length;
    return c.json<ActivitySummary>({
      repos: repos.filter((r) => inConfiguration(ctx, r.id)).length,
      requests: requests.counts,
      members,
      usage: { days: 30, total: usage.reduce((n, u) => n + u.count, 0), top: topSeen(usage, repos, await seen(c, repos)) },
      tasks: { total: tasks.reduce((n, r) => n + r.tasks, 0), recent: await Promise.all(recent.map((t) => recentTask(ctx.store, ctx.tenant, t))) },
      forges: { hosted: hosted.length, connected },
      tracker: (await readTracker(ctx)) !== null,
    });
  });

  // Which team and skill are used most is shown to owners and admins, and to members once
  // the organization's privacy setting shows them the leaderboard; otherwise members see totals.
  // A team's owner sees their own teams' rows, filtered here rather than in the browser.
  const seen = (c: Context<OrchestratorEnv>, repos: readonly RepoRecord[]) => usageBreakdown(ctx, c.get("user"), repos);
  // One repository's daily use is its team's numbers, so it is read only by whoever sees that team broken down.
  const repoRefused = (c: Context<OrchestratorEnv>, repoId: string | undefined, repos: readonly RepoRecord[], shown: Breakdown) =>
    repoId !== undefined && !seesTeam(shown, repos.find((r) => r.id === repoId)?.team ?? repoId)
      ? c.json({ error: "Skill use for one repository is shown to its team's owners, and to owners and admins." }, 403)
      : null;
  const readWindow = (c: Context<OrchestratorEnv>): { days: number; repoId: string | undefined } | Response => {
    const days = Number(c.req.query("days") ?? 30);
    if (!(USAGE_WINDOWS as readonly number[]).includes(days)) return c.json({ error: `days is one of ${USAGE_WINDOWS.join(", ")}` }, 400);
    const repoId = c.req.query("repo");
    if (repoId !== undefined && !REPO_ID.test(repoId)) return c.json({ error: "unknown repository" }, 400);
    return { days, repoId };
  };
  const daily = async (days: number, repoId: string | undefined) => {
    const [rows, repos] = await Promise.all([ctx.store.usageDaily(ctx.tenant, `${new Date(Date.now() - (days - 1) * DAY).toISOString().slice(0, 10)}T00`, repoId), ctx.store.listRepos(ctx.tenant)]);
    return { rows, repos };
  };

  app.get("/api/activity/usage", async (c) => {
    const asked = readWindow(c);
    if (asked instanceof Response) return asked;
    const { rows, repos } = await daily(asked.days, asked.repoId);
    const shown = await seen(c, repos);
    return repoRefused(c, asked.repoId, repos, shown) ?? c.json<UsageReport>(scopedReport(usageReport(rows, repos, asked.days), shown));
  });

  app.get("/api/activity/usage/export", async (c) => {
    const asked = readWindow(c);
    if (asked instanceof Response) return asked;
    const format = c.req.query("format") ?? "csv";
    if (format !== "csv" && format !== "json") return c.json({ error: "format is csv or json" }, 400);
    const { rows: all, repos } = await daily(asked.days, asked.repoId);
    const shown = await seen(c, repos);
    if (!shown) return c.json({ error: "An owner or an admin exports skill use; a team's owner exports their own teams'." }, 403);
    const teamOf = new Map(repos.map((r) => [r.id, r.team]));
    const rows = shown === "all" ? all : all.filter((r) => shown.has(teamOf.get(r.repoId) ?? r.repoId));
    const name = `skill-use-${asked.days}d-${new Date().toISOString().slice(0, 10)}.${format}`;
    c.header("content-disposition", `attachment; filename="${name}"`);
    if (format === "json") {
      const byRepo = new Map(repos.map((r) => [r.id, r]));
      return c.json({ days: asked.days, rows: rows.map((r) => ({ day: r.day, team: byRepo.get(r.repoId)?.team ?? null, repository: byRepo.get(r.repoId)?.name ?? r.repoId, skill: r.skill, count: r.count })) });
    }
    c.header("content-type", "text/csv; charset=utf-8");
    return c.body(usageCsv(rows, repos));
  });

  app.get("/api/activity/leaderboard", async (c) => {
    const asked = readWindow(c);
    if (asked instanceof Response) return asked;
    const { rows, repos } = await daily(asked.days, undefined);
    const shown = await seen(c, repos);
    if (!shown) return c.json({ error: "The leaderboard is shown to owners and admins; an owner can show it to members under Settings, Privacy." }, 403);
    const report = scopedReport(usageReport(rows, repos, asked.days), shown);
    const skillCount = new Map<string, number>();
    for (const s of report.bySkill) skillCount.set(s.team, (skillCount.get(s.team) ?? 0) + 1);
    return c.json<Leaderboard>({
      days: asked.days,
      teams: report.byTeam.map((t) => ({ ...t, skills: skillCount.get(t.team) ?? 0 })),
      skills: report.bySkill.slice(0, 50),
      ...(report.scope ? { scope: report.scope } : {}),
    });
  });

  app.get("/api/activity/journey", async (c) => {
    try {
      return c.json<Journey>(await journey(ctx, c.get("user")));
    } catch (err) {
      if (err instanceof AccountError) return c.json({ error: err.message }, err.status);
      throw err;
    }
  });

  app.get("/api/activity/onboarding", async (c) => c.json<Onboarding>(await readOnboarding(ctx.store, ctx.tenant)));

  app.put("/api/activity/onboarding", async (c) => {
    try {
      const before = await readOnboarding(ctx.store, ctx.tenant);
      const after = await changeOnboarding(ctx.store, ctx.tenant, c.get("user"), await c.req.json().catch(() => ({})));
      const changes = [
        ...(before.dismissed !== after.dismissed ? [after.dismissed ? "hid the guide" : "showed the guide"] : []),
        ...after.marked.filter((s) => !before.marked.includes(s)).map((s) => `marked ${s} done`),
        ...before.marked.filter((s) => !after.marked.includes(s)).map((s) => `unmarked ${s}`),
        ...after.skipped.filter((s) => !before.skipped.includes(s)).map((s) => `skipped ${s}`),
        ...before.skipped.filter((s) => !after.skipped.includes(s)).map((s) => `took up ${s} again`),
      ];
      if (changes.length) await recordEvent(ctx, c.get("user"), "onboarding.changed", { subject: "onboarding", detail: changes.join("; ") });
      return c.json<Onboarding>(after);
    } catch (err) {
      if (err instanceof AccountError) return c.json({ error: err.message }, err.status);
      throw err;
    }
  });

  return app;
}
