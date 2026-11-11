import type { MiddlewareHandler } from "hono";
import { describe, expect, it } from "vitest";
import { breakdownFor, scopedReport, usageReport } from "./activity.js";
import { createApp } from "./app.js";
import type { OrchestratorContext } from "./app.js";
import type { OrchestratorEnv, Principal } from "./auth.js";
import { openSqliteStore } from "./store.js";
import type { RepoRecord } from "./store.js";

const ADMIN: Principal = { id: "a", name: "Ada", email: "ada@example.invalid", role: "admin", ownedTeams: [] };
const PAYMENTS_LEAD: Principal = { id: "p", name: "Pat", email: "pat@example.invalid", role: "member", ownedTeams: ["payments"] };
const MEMBER: Principal = { id: "m", name: "Max", email: "max@example.invalid", role: "member", ownedTeams: [] };

const repo = (id: string, team: string): RepoRecord => ({ tenant: "acme", id, team, name: id, url: "/srv/x.git", head: null, syncedAt: null, error: null });
const REPOS = [repo("payments-skills", "payments"), repo("platform-skills", "platform")];

function as(user: Principal): MiddlewareHandler<OrchestratorEnv> {
  return async (c, next) => {
    c.set("user", user);
    await next();
  };
}

async function withUse(): Promise<OrchestratorContext> {
  const ctx: OrchestratorContext = { store: openSqliteStore(":memory:"), dataDir: "/nonexistent", tenant: "acme" };
  for (const r of REPOS) await ctx.store.upsertRepo(r);
  const hour = new Date().toISOString().slice(0, 13);
  await ctx.store.addUsage("acme", "payments-skills", "release-checklist", hour, 4);
  await ctx.store.addUsage("acme", "platform-skills", "rotate-keys", hour, 6);
  return ctx;
}

describe("whose usage a person sees broken down", () => {
  it("given an admin, a team's owner and a member, when their breakdown is worked out, then it is every team, their own team, and nobody's", () => {
    expect(breakdownFor(ADMIN, false, REPOS)).toBe("all");
    expect(breakdownFor(PAYMENTS_LEAD, false, REPOS)).toEqual(new Set(["payments"]));
    expect(breakdownFor(MEMBER, false, REPOS)).toBeNull();
    expect(breakdownFor(MEMBER, true, REPOS)).toBe("all");
  });

  it("given a team's owner, when the report is scoped, then the totals stay and only their team's rows and a scope remain", () => {
    // given
    const report = usageReport([{ repoId: "payments-skills", skill: "release-checklist", day: "2026-10-23", count: 4 }, { repoId: "platform-skills", skill: "rotate-keys", day: "2026-10-23", count: 6 }], REPOS, 7, Date.parse("2026-10-23T12:00:00Z"));

    // when
    const scoped = scopedReport(report, new Set(["payments"]));

    // then
    expect(scoped.total).toBe(10);
    expect(scoped.byTeam).toEqual([{ team: "payments", count: 4 }]);
    expect(scoped.bySkill.map((s) => s.skill)).toEqual(["release-checklist"]);
    expect(scoped.scope).toEqual({ teams: ["payments"] });
  });
});

describe("the usage routes filter on the server", () => {
  it("given a team's owner, when they read usage, the leaderboard and the export, then each carries their team's rows and none of another team's", async () => {
    // given
    const app = createApp(await withUse(), as(PAYMENTS_LEAD));

    // when
    const usage = await (await app.request("/api/activity/usage?days=7")).json();
    const board = await (await app.request("/api/activity/leaderboard?days=7")).json();
    const exported = await (await app.request("/api/activity/usage/export?days=7&format=json")).json();
    const otherRepo = await (await app.request("/api/activity/usage/export?days=7&format=json&repo=platform-skills")).json();

    // then
    expect(usage.total).toBe(10);
    expect(usage.byTeam).toEqual([{ team: "payments", count: 4 }]);
    expect(usage.bySkill.map((s: { team: string }) => s.team)).toEqual(["payments"]);
    expect(board.teams.map((t: { team: string }) => t.team)).toEqual(["payments"]);
    expect(board.scope).toEqual({ teams: ["payments"] });
    expect(exported.rows.map((r: { team: string }) => r.team)).toEqual(["payments"]);
    expect(otherRepo.rows).toEqual([]);
  });

  it("given a member who owns no team, when they read usage and ask for the export and the leaderboard, then they get totals and both are refused", async () => {
    // given
    const app = createApp(await withUse(), as(MEMBER));

    // when
    const usage = await (await app.request("/api/activity/usage?days=7")).json();
    const exported = await app.request("/api/activity/usage/export?days=7&format=csv");
    const board = await app.request("/api/activity/leaderboard?days=7");

    // then
    expect(usage.total).toBe(10);
    expect(usage.byTeam).toEqual([]);
    expect(usage.scope).toBeUndefined();
    expect(exported.status).toBe(403);
    expect(board.status).toBe(403);
  });

  it("given an admin, when they read usage, then every team is broken down with no scope", async () => {
    // given
    const app = createApp(await withUse(), as(ADMIN));

    // when
    const usage = await (await app.request("/api/activity/usage?days=7")).json();

    // then
    expect(usage.byTeam.map((t: { team: string }) => t.team)).toEqual(["platform", "payments"]);
    expect(usage.scope).toBeUndefined();
  });
});

describe("no other usage read goes around the breakdown", () => {
  it("given a member who owns no team, when they read the repository usage list, then no skill's count comes back and it says so", async () => {
    // given
    const app = createApp(await withUse(), as(MEMBER));

    // when
    const all = await (await app.request("/api/usage")).json();
    const one = await (await app.request("/api/usage?repo=payments-skills")).json();

    // then
    expect([all.usage, all.shown]).toEqual([[], false]);
    expect([one.usage, one.shown]).toEqual([[], false]);
  });

  it("given a team's owner, when they read the repository usage list, then only their team's repository comes back and another team's is not shown", async () => {
    // given
    const app = createApp(await withUse(), as(PAYMENTS_LEAD));

    // when
    const all = await (await app.request("/api/usage")).json();
    const other = await (await app.request("/api/usage?repo=platform-skills")).json();

    // then
    expect(all.usage.map((u: { repoId: string }) => u.repoId)).toEqual(["payments-skills"]);
    expect([other.usage, other.shown]).toEqual([[], false]);
  });

  it("given a team's owner and a member, when each asks Activity for one repository outside what they see, then both are refused and the owner's own repository answers", async () => {
    // given
    const ctx = await withUse();

    // when
    const lead = createApp(ctx, as(PAYMENTS_LEAD));
    const otherTeam = await lead.request("/api/activity/usage?days=7&repo=platform-skills");
    const ownTeam = await (await lead.request("/api/activity/usage?days=7&repo=payments-skills")).json();
    const member = await createApp(ctx, as(MEMBER)).request("/api/activity/usage?days=7&repo=payments-skills");

    // then
    expect(otherTeam.status).toBe(403);
    expect(ownTeam.total).toBe(4);
    expect(member.status).toBe(403);
  });
});
