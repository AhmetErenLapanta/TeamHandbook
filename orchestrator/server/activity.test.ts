import { describe, expect, it } from "vitest";
import { csvCell } from "../shared/csv.js";
import type { AccountError } from "./accounts.js";
import { createUser, principalOf, setupFirstOwner } from "./accounts.js";
import { changeOnboarding, dailySeries, readOnboarding, recentTask, usageCsv, usageReport } from "./activity.js";
import { openSqliteStore } from "./store.js";
import type { RepoRecord } from "./store.js";
import type { TaskRecord } from "./tasks/types.js";

const NOW = Date.parse("2026-10-23T12:00:00Z");
const repo = (id: string, team: string): RepoRecord => ({ tenant: "acme", id, team, name: id, url: "/srv/x.git", head: null, syncedAt: null, error: null });

describe("dailySeries", () => {
  it("given counts on two days of a seven-day window, when the series is drawn, then every day is present oldest first with the rest at zero", () => {
    // given
    const rows = [
      { repoId: "a", skill: "s", day: "2026-10-17", count: 2 },
      { repoId: "b", skill: "t", day: "2026-10-23", count: 3 },
      { repoId: "a", skill: "s", day: "2026-10-23", count: 1 },
    ];

    // when
    const series = dailySeries(rows, 7, NOW);

    // then
    expect(series.map((d) => d.day)).toEqual(["2026-10-17", "2026-10-18", "2026-10-19", "2026-10-20", "2026-10-21", "2026-10-22", "2026-10-23"]);
    expect(series.map((d) => d.count)).toEqual([2, 0, 0, 0, 0, 0, 4]);
  });
});

describe("usageReport", () => {
  it("given two teams' skills over two days, when the report is built, then teams and skills are summed and ranked by use", () => {
    // given
    const repos = [repo("payments-skills", "payments"), repo("platform-skills", "platform")];
    const rows = [
      { repoId: "payments-skills", skill: "release-checklist", day: "2026-10-22", count: 2 },
      { repoId: "payments-skills", skill: "release-checklist", day: "2026-10-23", count: 2 },
      { repoId: "payments-skills", skill: "add-ledger-migration", day: "2026-10-23", count: 1 },
      { repoId: "platform-skills", skill: "rotate-keys", day: "2026-10-23", count: 6 },
    ];

    // when
    const report = usageReport(rows, repos, 7, NOW);

    // then
    expect(report.total).toBe(11);
    expect(report.byTeam).toEqual([{ team: "platform", count: 6 }, { team: "payments", count: 5 }]);
    expect(report.bySkill.map((s) => [s.team, s.skill, s.count])).toEqual([["platform", "rotate-keys", 6], ["payments", "release-checklist", 4], ["payments", "add-ledger-migration", 1]]);
  });
});

describe("csvCell", () => {
  it("given cells a spreadsheet would run or split, when written, then formulas stay text and separators are quoted", () => {
    // given
    const cells = ["=HYPERLINK(1)", "+1", "-2", "@sum", "plain", 'with "quote", comma', 7];

    // when
    const written = cells.map(csvCell);

    // then
    expect(written).toEqual(["'=HYPERLINK(1)", "'+1", "'-2", "'@sum", "plain", '"with ""quote"", comma"', "7"]);
  });
});

describe("usageCsv", () => {
  it("given daily rows, when exported, then each row names the day, team, repository, skill and count", () => {
    // given
    const rows = [{ repoId: "payments-skills", skill: "release-checklist", day: "2026-10-23", count: 3 }];

    // when
    const csv = usageCsv(rows, [repo("payments-skills", "payments")]);

    // then
    expect(csv).toBe("day,team,repository,skill,count\r\n2026-10-23,payments,payments-skills,release-checklist,3\r\n");
  });
});

describe("onboarding", () => {
  async function organization() {
    const store = openSqliteStore(":memory:");
    const owner = await principalOf(store, await setupFirstOwner(store, "acme", "code-for-tests", { code: "code-for-tests", email: "ada@example.invalid", password: "correct horse battery" }));
    const member = await principalOf(store, await createUser(store, "acme", new Set(["Payments"]), { email: "max@example.invalid", role: "member" }, owner));
    return { store, owner, member };
  }

  it("given an owner who hides the guide and marks the join step, when anyone in the organization reads it, then they see it hidden and marked", async () => {
    // given
    const { store, owner } = await organization();
    const fresh = await readOnboarding(store, "acme");

    // when
    await changeOnboarding(store, "acme", owner, { dismissed: true, marked: ["join", "join"] });

    // then
    expect(fresh).toEqual({ dismissed: false, marked: [], skipped: [] });
    expect(await readOnboarding(store, "acme")).toEqual({ dismissed: true, marked: ["join"], skipped: [] });
    expect(await readOnboarding(store, "globex")).toEqual({ dismissed: false, marked: [], skipped: [] });
  });

  it("given an owner who leaves the forge and the first task for later, when anyone reads the guide, then both are skipped for the whole organization and an organization from before skipping reads none", async () => {
    // given
    const { store, owner } = await organization();
    await store.setSetting("globex", "onboarding.marked", JSON.stringify(["join"]));

    // when
    await changeOnboarding(store, "acme", owner, { skipped: ["forge", "start", "forge"] });

    // then
    expect((await readOnboarding(store, "acme")).skipped).toEqual(["forge", "start"]);
    expect(await readOnboarding(store, "globex")).toEqual({ dismissed: false, marked: ["join"], skipped: [] });
  });

  it("given a member, a key and a step the orchestrator checks itself, when each tries to change the guide, then each is refused and nothing changes", async () => {
    // given
    const { store, owner, member } = await organization();

    // when
    const tries = [
      changeOnboarding(store, "acme", member, { dismissed: true }),
      changeOnboarding(store, "acme", { ...owner, key: { id: "k1" } } as typeof owner, { dismissed: true }),
      changeOnboarding(store, "acme", owner, { marked: ["merge"] }),
      changeOnboarding(store, "acme", owner, { dismissed: "yes" }),
      changeOnboarding(store, "acme", member, { skipped: ["forge"] }),
      changeOnboarding(store, "acme", owner, { skipped: ["merge"] }),
      changeOnboarding(store, "acme", owner, { dismissed: true, skipped: "forge" }),
    ];

    // then
    const refused = await Promise.all(tries.map((t) => t.then(() => null, (e: AccountError) => e.status)));
    expect(refused).toEqual([403, 403, 400, 400, 403, 400, 400]);
    expect(await readOnboarding(store, "acme")).toEqual({ dismissed: false, marked: [], skipped: [] });
  });
});

describe("a recent task on Activity", () => {
  const task = (id: string, patch: Partial<TaskRecord> = {}): TaskRecord => ({ tenant: "acme", id, repoId: "shop", team: "Mine", title: "Tidy the readme", description: "", issueUrl: null, issueKey: null, agent: "fake", status: "needs-review", createdBy: "ada@example.invalid", createdAt: "2026-11-03T10:00:00.000Z", startedAt: null, finishedAt: null, baseSha: null, tests: null, cost: { usd: null, inputTokens: null, outputTokens: null }, requestNumber: null, error: null, ...patch });

  it("given a folder task whose changes were undone and one whose request was closed, when each is read for Activity, then each carries what its decision is read from", async () => {
    // given
    const store = openSqliteStore(":memory:");
    await store.saveRequest({ tenant: "acme", repoId: "shop", number: 4, provider: "local", url: "", branch: "task/x", headSha: "b".repeat(40), title: "t", status: "closed", createdAt: "2026-11-03T10:00:00.000Z", createdBy: "ada@example.invalid" });
    const undone = task("aaaaaaaaaaaa", { result: "changes", changes: { files: [], undone: { at: "2026-11-03T11:00:00.000Z", by: "ada@example.invalid", kept: [] }, kept: null } });
    const closed = task("bbbbbbbbbbbb", { requestNumber: 4 });

    // when
    const read = await Promise.all([recentTask(store, "acme", undone), recentTask(store, "acme", closed)]);

    // then
    expect(read[0]).toMatchObject({ id: "aaaaaaaaaaaa", status: "needs-review", result: "changes", changes: { undone: true, kept: false }, request: null, requests: [] });
    expect(read[1]).toMatchObject({ id: "bbbbbbbbbbbb", result: null, changes: null, request: { status: "closed" } });
  });
});
