import { describe, expect, it } from "vitest";
import { createUser, principalOf, setupFirstOwner, startSession } from "./accounts.js";
import { createApp } from "./app.js";
import { CSRF_HEADER, sessionCookie } from "./auth.js";
import { createKey, MOST } from "./keys.js";
import { changePrivacy, DEFAULT_PRIVACY, purgeTaskLogs, purgeUsageCounts, readPrivacy, seesLeaderboard } from "./privacy.js";
import { openSqliteStore } from "./store.js";
import type { TaskRecord } from "./tasks/types.js";

const TENANT = "acme";
const CODE = "setup-code-for-tests";
const PASSWORD = "correct horse battery";
const TEAMS = new Set(["Payments"]);

async function organization() {
  const store = openSqliteStore(":memory:");
  const owner = await principalOf(store, await setupFirstOwner(store, TENANT, CODE, { code: CODE, email: "ada@example.invalid", password: PASSWORD }));
  const admin = await principalOf(store, await createUser(store, TENANT, TEAMS, { email: "grace@example.invalid", role: "admin" }, owner));
  const member = await principalOf(store, await createUser(store, TENANT, TEAMS, { email: "max@example.invalid", role: "member" }, owner));
  return { store, owner, admin, member };
}

function task(id: string): TaskRecord {
  return {
    tenant: TENANT, id, repoId: "payments-skills", team: "Payments", title: "t", description: "", issueUrl: null, issueKey: null, agent: "fake", status: "needs-review",
    createdBy: "ada@example.invalid", createdAt: new Date().toISOString(), startedAt: null, finishedAt: null, baseSha: null, tests: null,
    cost: { usd: null, inputTokens: null, outputTokens: null }, requestNumber: null, error: null, template: null,
  };
}

describe("privacy settings", () => {
  it("given a new organization, when a member asks for the leaderboard, then only owners and admins see it until an admin shows it to members", async () => {
    // given
    const { store, owner, admin, member } = await organization();

    // when
    const before = await Promise.all([owner, admin, member].map((p) => seesLeaderboard(store, TENANT, p)));
    await changePrivacy(store, TENANT, admin, { leaderboard: "members" });

    // then
    expect(before).toEqual([true, true, false]);
    expect(await seesLeaderboard(store, TENANT, member)).toBe(true);
    expect(await readPrivacy(store, TENANT)).toEqual({ ...DEFAULT_PRIVACY, leaderboard: "members" });
  });

  it("given a member, an owner's key with every scope, and values out of range, when each changes privacy, then each is refused and the defaults stay", async () => {
    // given
    const { store, owner, member } = await organization();
    const { key } = await createKey(store, TENANT, owner, { name: "all", scopes: MOST });

    // when
    const attempts = await Promise.allSettled([
      changePrivacy(store, TENANT, member, { leaderboard: "members" }),
      changePrivacy(store, TENANT, { ...owner, key: { id: key.id, owner: key.owner, scopes: key.scopes, expiresAt: null } }, { leaderboard: "members" }),
      changePrivacy(store, TENANT, owner, { taskLogDays: 0 }),
      changePrivacy(store, TENANT, owner, { leaderboard: "everyone" }),
    ]);

    // then
    expect(attempts.map((a) => a.status)).toEqual(["rejected", "rejected", "rejected", "rejected"]);
    expect(await readPrivacy(store, TENANT)).toEqual(DEFAULT_PRIVACY);
  });

  it("given task log lines written today, when the retention passes them, then they go while the task stays, and a longer retention keeps them", async () => {
    // given
    const { store, owner } = await organization();
    await store.createTask(task("aaaaaaaaaaaa"));
    await store.appendTaskLog(TENANT, "aaaaaaaaaaaa", ["first line", "second line"]);
    const in40Days = new Date(Date.now() + 40 * 86_400_000);

    // when
    await changePrivacy(store, TENANT, owner, { taskLogDays: 60 });
    const kept = await purgeTaskLogs(store, TENANT, in40Days);
    await changePrivacy(store, TENANT, owner, { taskLogDays: 30 });
    const removed = await purgeTaskLogs(store, TENANT, in40Days);

    // then
    expect([kept, removed]).toEqual([0, 2]);
    expect(await store.taskLog(TENANT, "aaaaaaaaaaaa", 0)).toEqual([]);
    expect(await store.getTask(TENANT, "aaaaaaaaaaaa")).not.toBeNull();
  });

  it("given skill use counted 100 and 400 days ago, when the default retention purges, then the year-old count goes and the newer one stays", async () => {
    // given
    const { store } = await organization();
    const now = new Date("2026-10-26T12:00:00Z");
    const hourAgo = (days: number) => new Date(now.getTime() - days * 86_400_000).toISOString().slice(0, 13);
    await store.addUsage(TENANT, "payments-skills", "release-checklist", hourAgo(100), 3);
    await store.addUsage(TENANT, "payments-skills", "release-checklist", hourAgo(400), 5);

    // when
    const removed = await purgeUsageCounts(store, TENANT, now);

    // then
    expect(removed).toBe(1);
    expect((await store.usage(TENANT, hourAgo(1000))).map((u) => u.count)).toEqual([3]);
  });

  it("given the shortest retention, when it purges, then a 90-day export still lists every day it shows", async () => {
    // given
    const { store, owner } = await organization();
    const now = new Date();
    const dayAgo = (days: number) => new Date(now.getTime() - days * 86_400_000).toISOString().slice(0, 13);
    await store.addUsage(TENANT, "payments-skills", "release-checklist", dayAgo(89), 2);
    await store.addUsage(TENANT, "payments-skills", "release-checklist", dayAgo(91), 7);
    const window = `${new Date(now.getTime() - 89 * 86_400_000).toISOString().slice(0, 10)}T00`;
    const before = await store.usageDaily(TENANT, window);

    // when
    await changePrivacy(store, TENANT, owner, { usageDays: 90 }, now);

    // then
    expect(await store.usageDaily(TENANT, window)).toEqual(before);
    expect((await store.usage(TENANT, dayAgo(1000))).map((u) => u.count)).toEqual([2]);
  });

  it("given a retention shorter than the longest range Usage shows, or past ten years, when an owner sets it, then it is refused and the default stays", async () => {
    // given
    const { store, owner } = await organization();

    // when
    const attempts = await Promise.allSettled([changePrivacy(store, TENANT, owner, { usageDays: 89 }), changePrivacy(store, TENANT, owner, { usageDays: 3651 }), changePrivacy(store, TENANT, owner, { usageDays: "365" })]);

    // then
    expect(attempts.map((a) => a.status)).toEqual(["rejected", "rejected", "rejected"]);
    expect((await readPrivacy(store, TENANT)).usageDays).toBe(365);
  });

  it("given an admin's session, when privacy is read and changed over the API, then each repository's reporting is listed and the change holds, while a member is refused both", async () => {
    // given
    const { store, admin, member } = await organization();
    await store.upsertRepo({ tenant: TENANT, id: "payments-skills", team: "Payments", name: "payments-skills", url: "/nowhere.git" });
    const app = createApp({ store, dataDir: "unused", tenant: TENANT, allowedHosts: null });
    const as = async (id: string) => {
      const s = await startSession(store, TENANT, id);
      return { cookie: `${sessionCookie(TENANT)}=${s.token}`, [CSRF_HEADER]: s.csrf, "content-type": "application/json" };
    };

    // when
    const read = await (await app.request("/api/privacy", { headers: await as(admin.id) })).json();
    const changed = await app.request("/api/privacy", { method: "PUT", headers: await as(admin.id), body: JSON.stringify({ taskLogDays: 7 }) });
    const byMember = await app.request("/api/privacy", { headers: await as(member.id) });

    // then
    expect(read).toEqual({ privacy: DEFAULT_PRIVACY, usage: [{ repoId: "payments-skills", name: "payments-skills", team: "Payments", reporting: null }] });
    expect((await changed.json()).privacy.taskLogDays).toBe(7);
    expect(byMember.status).toBe(403);
  });
});
