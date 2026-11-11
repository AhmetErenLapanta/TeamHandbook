import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MiddlewareHandler } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { seed } from "../demo/seed.js";
import { requestStats } from "./analytics.js";
import { createApp, syncRepo } from "./app.js";
import type { OrchestratorContext } from "./app.js";
import type { OrchestratorEnv, Principal } from "./auth.js";
import { localRepoPath } from "./forge/local.js";
import type { RequestRecord } from "./forge/types.js";
import type { TaskRecord } from "./tasks/types.js";
import { git } from "./git.js";
import { openSqliteStore } from "./store.js";

const ADMIN: Principal = { id: "a", name: "Ada Example", email: "ada@example.invalid", role: "admin", ownedTeams: [] };
const MEMBER: Principal = { id: "m", name: "Max Example", email: "max@example.invalid", role: "member", ownedTeams: [], restrictedTeams: [] };

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function as(user: Principal): MiddlewareHandler<OrchestratorEnv> {
  return async (c, next) => {
    c.set("user", user);
    await next();
  };
}

async function seeded(): Promise<{ ctx: OrchestratorContext; root: string }> {
  const root = mkdtempSync(join(tmpdir(), "orchestrator-analytics-"));
  dirs.push(root);
  const { configFile } = seed(join(root, "demo"));
  const config = JSON.parse(readFileSync(configFile, "utf8"));
  const ctx: OrchestratorContext = { store: openSqliteStore(":memory:"), dataDir: join(root, "data"), tenant: config.tenant };
  for (const repo of config.repos) {
    await ctx.store.upsertRepo({ ...repo, tenant: config.tenant });
    await syncRepo(ctx, repo.id);
  }
  return { ctx, root };
}

const post = (app: ReturnType<typeof createApp>, path: string, body: unknown) =>
  app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

const request = (fields: Partial<RequestRecord>): RequestRecord => ({ tenant: "t", repoId: "r", number: 1, provider: "gitlab", url: "", branch: "b", headSha: "a".repeat(40), title: "t", status: "open", createdAt: "2026-10-20T00:00:00.000Z", createdBy: "x", ...fields });

describe("how the orchestrator's requests fared", () => {
  it("given one request merged and then reverted, one closed and one an agent opened, when the analytics are read, then the orchestrator's and the agent's are counted apart, by team and repository", async () => {
    // given
    const { ctx, root } = await seeded();
    const app = createApp(ctx, as(ADMIN));
    const head = (await ctx.store.getRepo(ctx.tenant, "payments-skills"))!.head;
    const open = async (slug: string) => (await (await post(app, "/api/repos/payments-skills/changes", { baseSha: head, message: `chore(skill): remove ${slug}`, change: { kind: "skill.delete", slug } })).json()).request;
    const kept = await open("release-checklist");
    const dropped = await open("add-ledger-migration");
    expect((await post(app, `/api/repos/payments-skills/requests/${kept.number}/merge`, {})).status).toBe(200);
    expect((await post(app, `/api/repos/payments-skills/requests/${dropped.number}/close`, {})).status).toBe(200);
    const bare = localRepoPath((await ctx.store.getRepo(ctx.tenant, "payments-skills"))!.url)!;
    const work = mkdtempSync(join(root, "work-"));
    git(["clone", "--quiet", bare, work], work);
    git(["-c", "user.name=t", "-c", "user.email=t@example.invalid", "revert", "--no-edit", "-m", "1", "HEAD"], work);
    git(["fetch", "--quiet", work, "main:main"], bare);
    await syncRepo(ctx, "payments-skills");
    const number = await ctx.store.nextRequestNumber(ctx.tenant, "platform-skills");
    await ctx.store.saveRequest({ tenant: ctx.tenant, repoId: "platform-skills", number, provider: "local", url: "", branch: "task/x", headSha: "b".repeat(40), title: "t", status: "open", createdAt: new Date().toISOString(), createdBy: "x" });
    await ctx.store.createTask({ tenant: ctx.tenant, id: "aaaaaaaaaaaa", repoId: "platform-skills", team: "Platform", title: "t", description: "", issueUrl: null, issueKey: null, agent: "fake", status: "needs-review", createdBy: MEMBER.email, createdAt: new Date().toISOString(), startedAt: null, finishedAt: null, baseSha: null, tests: null, cost: { usd: null, inputTokens: null, outputTokens: null }, requestNumber: number, error: null });

    // when
    const res = await createApp(ctx, as(MEMBER)).request("/api/analytics/requests");
    const analytics = await res.json();

    // then
    expect(res.status).toBe(200);
    expect(analytics).toMatchObject({ days: 30, lowerBound: true, orchestrator: { opened: 2, merged: 1, closed: 1, open: 0, reverted: 1, mergeRate: 0.5 }, agent: { opened: 1, open: 1, merged: 0, mergeRate: null } });
    expect(analytics.orchestrator.hoursToMerge).toEqual({ median: expect.any(Number), p90: expect.any(Number) });
    expect(analytics.byTeam.map((t: { team: string; orchestrator: { opened: number }; agent: { opened: number } }) => [t.team, t.orchestrator.opened, t.agent.opened])).toEqual([["Payments", 2, 0], ["Platform", 0, 1]]);
    expect(analytics.byRepo.map((r: { repoId: string; team: string }) => [r.repoId, r.team])).toEqual([["payments-skills", "Payments"], ["platform-skills", "Platform"]]);
  });

  it("given a team kept to its own people, when someone outside it reads the analytics, then neither the totals nor the breakdowns count that team's requests", async () => {
    // given
    const { ctx } = await seeded();
    const base = { tenant: ctx.tenant, provider: "local" as const, url: "", headSha: "c".repeat(40), title: "t", createdAt: new Date().toISOString(), createdBy: "pat@example.invalid" };
    await ctx.store.saveRequest({ ...base, repoId: "payments-skills", number: 1, branch: "b1", status: "merged", mergedAt: new Date().toISOString() });
    await ctx.store.saveRequest({ ...base, repoId: "platform-skills", number: 1, branch: "b2", status: "open" });

    // when
    const res = await createApp(ctx, as({ ...MEMBER, restrictedTeams: ["Payments"] })).request("/api/analytics/requests");
    const analytics = await res.json();

    // then
    expect(analytics.orchestrator).toMatchObject({ opened: 1, merged: 0, open: 1 });
    expect(analytics.byTeam.map((t: { team: string }) => t.team)).toEqual(["Platform"]);
    expect(analytics.byRepo.map((r: { repoId: string }) => r.repoId)).toEqual(["platform-skills"]);
  });

  it("given a request a teammate's task opened, one the person's own task opened and one no task opened, when a member reads the analytics, then a task's request counts only for whoever reads that task", async () => {
    // given
    const { ctx } = await seeded();
    const now = new Date().toISOString();
    const base = { tenant: ctx.tenant, provider: "local" as const, url: "", headSha: "c".repeat(40), title: "t", createdAt: now, createdBy: "pat@example.invalid", repoId: "platform-skills", status: "open" as const };
    const task = (id: string, createdBy: string, requestNumber: number): TaskRecord => ({ tenant: ctx.tenant, id, repoId: "platform-skills", team: "Platform", title: "t", description: "", issueUrl: null, issueKey: null, agent: "fake", status: "needs-review", createdBy, createdAt: now, startedAt: now, finishedAt: now, baseSha: null, tests: null, cost: { usd: null, inputTokens: null, outputTokens: null }, requestNumber, error: null });
    await ctx.store.createTask(task("tsk_pat", "pat@example.invalid", 1));
    await ctx.store.createTask(task("tsk_max", "max@example.invalid", 2));
    await ctx.store.saveRequest({ ...base, number: 1, branch: "task/tsk_pat" });
    await ctx.store.saveRequest({ ...base, number: 2, branch: "task/tsk_max", createdBy: "max@example.invalid" });
    await ctx.store.saveRequest({ ...base, number: 3, branch: "b3" });

    // when
    const analytics = await (await createApp(ctx, as(MEMBER)).request("/api/analytics/requests")).json();

    // then
    expect([analytics.agent.opened, analytics.orchestrator.opened]).toEqual([1, 1]);
  });

  it("given two people's tasks this month and one older, a request merged, one closed, a change kept, one undone, a failure and two costs known, when a member and an admin read the people's outcomes, then each person's are counted with what their tasks cost, the member sees only their own, and the older task is not counted", async () => {
    // given
    // The store alone: people's outcomes read no repository, so nothing is cloned or synced.
    const root = mkdtempSync(join(tmpdir(), "orchestrator-analytics-"));
    dirs.push(root);
    const ctx: OrchestratorContext = { store: openSqliteStore(":memory:"), dataDir: join(root, "data"), tenant: "acme" };
    const now = new Date();
    const at = (daysAgo: number) => new Date(now.getTime() - daysAgo * 86_400_000).toISOString();
    const base = { tenant: ctx.tenant, provider: "local" as const, url: "", headSha: "c".repeat(40), title: "t", createdAt: at(1), createdBy: "x", repoId: "platform-skills", branch: "b" };
    await ctx.store.saveRequest({ ...base, number: 1, status: "merged" });
    await ctx.store.saveRequest({ ...base, number: 2, status: "closed" });
    const task = (id: string, createdBy: string, fields: Partial<TaskRecord>): TaskRecord => ({ tenant: ctx.tenant, id, repoId: "platform-skills", team: "Platform", title: "t", description: "", issueUrl: null, issueKey: null, agent: "fake", status: "needs-review", createdBy, createdAt: at(1), startedAt: null, finishedAt: null, baseSha: null, tests: null, cost: { usd: null, inputTokens: null, outputTokens: null }, requestNumber: null, error: null, ...fields });
    await ctx.store.createTask(task("tsk_a", MEMBER.email, { requestNumber: 1, cost: { usd: 0.5, inputTokens: null, outputTokens: null } }));
    await ctx.store.createTask(task("tsk_b", MEMBER.email, { requestNumber: 2, cost: { usd: 0.25, inputTokens: null, outputTokens: null } }));
    await ctx.store.createTask(task("tsk_c", "pat@example.invalid", { status: "failed" }));
    await ctx.store.createTask(task("tsk_old", "pat@example.invalid", { createdAt: at(60) }));
    for (const [id, kept] of [["tsk_d", true], ["tsk_e", false]] as const) {
      await ctx.store.createTask(task(id, "pat@example.invalid", {}));
      await ctx.store.setTaskChanges(ctx.tenant, id, { before: "a".repeat(40), after: "b".repeat(40), files: [], undone: null });
      if (kept) await ctx.store.markTaskChangesKept(ctx.tenant, id, { at: at(0), by: "pat@example.invalid" });
      else await ctx.store.markTaskChangesUndone(ctx.tenant, id, { at: at(0), by: "pat@example.invalid", kept: [] });
    }

    // when
    const asAdmin = await (await createApp(ctx, as(ADMIN)).request("/api/analytics/people")).json();
    const asMember = await (await createApp(ctx, as({ ...MEMBER, ownedTeams: [] })).request("/api/analytics/people")).json();

    // then
    expect(asAdmin.people).toEqual([
      { email: "pat@example.invalid", name: null, tasks: 3, merged: 0, closed: 0, kept: 1, undone: 1, failed: 1, usd: 0, unknownCost: 3 },
      { email: MEMBER.email, name: null, tasks: 2, merged: 1, closed: 1, kept: 0, undone: 0, failed: 0, usd: 0.75, unknownCost: 0 },
    ]);
    expect(asMember.people.map((p: { email: string }) => p.email)).toEqual([MEMBER.email]);
  });

  it("given merged requests with and without a known merge time, when their stats are read, then only known times count toward the wait, in hours", () => {
    // given
    const requests = [
      request({ number: 1, status: "merged", mergedAt: "2026-10-20T02:00:00.000Z" }),
      request({ number: 2, status: "merged", mergedAt: "2026-10-20T10:00:00.000Z" }),
      request({ number: 3, status: "merged" }),
      request({ number: 4, status: "closed" }),
    ];

    // when
    const stats = requestStats(requests, new Set());

    // then
    expect(stats).toEqual({ opened: 4, merged: 3, closed: 1, open: 0, reverted: 0, mergeRate: 0.75, hoursToMerge: { median: 2, p90: 10 } });
  });

  it("given days outside 1 to 365, when the analytics are read, then they are refused", async () => {
    // given
    const { ctx } = await seeded();

    // when
    const res = await createApp(ctx, as(ADMIN)).request("/api/analytics/requests?days=0");

    // then
    expect(res.status).toBe(400);
  });
});
