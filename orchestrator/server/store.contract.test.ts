import { createHash, randomBytes } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import pg from "pg";
import { describe, expect, it } from "vitest";
import type { UserRecord } from "./accounts.js";
import type { RequestRecord } from "./forge/types.js";
import { numberPlaceholders, openPostgresStore } from "./store-postgres.js";
import { MIGRATIONS, newerSchema, openSqliteStore, readableFrom, SCHEMA_VERSION, SCHEMA_VERSION_TABLE, sqliteDriver } from "./store.js";
import type { IdentityLogin, IdentityRecord, IdentitySessionRecord, OrgRecord, PendingSignIn, SocialProvider } from "./identities.js";
import type { EffectInput, TaskCommand } from "./effects.js";
import type { NewTaskRequest, TaskAnswer } from "./task-requests.js";
import { answerProblem } from "./task-requests.js";
import type { NewFollowUp } from "./task-followups.js";
import type { IdentityEvent } from "./identity-funnel.js";
import type { Store } from "./store.js";
import type { TaskRecord, TaskTarget } from "./tasks/types.js";

// Every behaviour the orchestrator relies on, run against each store it can open. SQLite runs
// always; Postgres runs when ORCHESTRATOR_TEST_DATABASE_URL names a server this suite may create
// and drop databases on, each test in a database of its own.
const PG_URL = process.env.ORCHESTRATOR_TEST_DATABASE_URL;

type Fresh = () => Promise<{ store: Store; dispose: () => Promise<void> }>;

const sqlite: Fresh = async () => {
  const store = openSqliteStore(":memory:");
  return { store, dispose: () => store.close() };
};

const postgres: Fresh = async () => {
  const name = `orchestrator_test_${randomBytes(6).toString("hex")}`;
  const admin = new pg.Client({ connectionString: PG_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  const url = new URL(PG_URL!);
  url.pathname = `/${name}`;
  const store = await openPostgresStore(url.toString(), ["a"], () => undefined);
  return {
    store,
    dispose: async () => {
      await store.close();
      const drop = new pg.Client({ connectionString: PG_URL });
      await drop.connect();
      await drop.query(`DROP DATABASE IF EXISTS ${name}`);
      await drop.end();
    },
  };
};

const drivers: [string, Fresh][] = [["sqlite", sqlite], ...(PG_URL ? ([["postgres", postgres]] as [string, Fresh][]) : [])];

function user(tenant: string, email: string, overrides: Partial<UserRecord> = {}): UserRecord {
  return {
    tenant,
    id: randomBytes(8).toString("hex"),
    email,
    name: email,
    role: "member",
    passwordHash: null,
    oidcIssuer: null,
    oidcSubject: null,
    forgeLogin: null,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function request(tenant: string, number: number, createdAt: string): RequestRecord {
  return {
    tenant,
    repoId: "payments-skills",
    number,
    provider: "local",
    url: `local://requests/payments-skills/${number}`,
    branch: `handbook/change-${number}`,
    headSha: "a".repeat(40),
    title: `change ${number}`,
    status: "open",
    createdAt,
    createdBy: "ada@example.invalid",
  };
}

async function using<T>(fresh: Fresh, fn: (store: Store) => Promise<T>): Promise<T> {
  const { store, dispose } = await fresh();
  try {
    return await fn(store);
  } finally {
    await dispose();
  }
}

describe("numbering placeholders for Postgres", () => {
  it("given a statement with placeholders and a quoted question mark, when it is rewritten, then only the placeholders are numbered", () => {
    expect(numberPlaceholders("SELECT * FROM t WHERE a = ? AND b = '?' AND c = ?")).toBe("SELECT * FROM t WHERE a = $1 AND b = '?' AND c = $2");
  });
});

describe.each(drivers)("the %s store", (_name, fresh) => {
  it("given organizations that let people join by one directory, another and none, when the key is looked up, then exactly those holding that key come back", async () => {
    await using(fresh, async (store) => {
      // given
      await store.setSetting("acme", "join.directory.google:example.invalid", '{"role":"member"}');
      await store.setSetting("globex", "join.directory.google:example.invalid", '{"role":"member"}');
      await store.setSetting("initech", "join.directory.google:other.invalid", '{"role":"member"}');

      // when
      const found = await store.tenantsWithSetting("join.directory.google:example.invalid");

      // then
      expect(found).toEqual(["acme", "globex"]);
      expect(await store.tenantsWithSetting("join.directory.google:%")).toEqual([]);
    });
  });

  it("given a policy put, put again and another tenant's of the same id, when listed and deleted, then each tenant sees its own latest and a second delete finds nothing", async () => {
    await using(fresh, async (store) => {
      // given
      const policy = { tenant: "acme", id: "p1", name: "Task budget", audience: '{"kind":"workspace"}', rules: "[]", updatedAt: "2026-10-25T10:00:00.000Z", updatedBy: "ada@example.invalid" };
      await store.putPolicy(policy);
      await store.putPolicy({ ...policy, rules: '[{"action":"task.run"}]', updatedAt: "2026-10-25T11:00:00.000Z" });
      await store.putPolicy({ ...policy, tenant: "globex", name: "Theirs" });

      // when
      const listed = await store.listPolicies("acme");
      const first = await store.deletePolicy("acme", "p1");
      const second = await store.deletePolicy("acme", "p1");

      // then
      expect(listed).toEqual([{ ...policy, rules: '[{"action":"task.run"}]', updatedAt: "2026-10-25T11:00:00.000Z" }]);
      expect([first, second]).toEqual([true, false]);
      expect((await store.listPolicies("globex")).map((p) => p.name)).toEqual(["Theirs"]);
    });
  });

  it("given a request merged with the forge's time, one merged with none and one reopened after a merge, when they are read back, then each keeps its merge time or has none", async () => {
    await using(fresh, async (store) => {
      // given
      for (const n of [1, 2, 3]) await store.saveRequest(request("acme", n, "2026-10-01T00:00:00.000Z"));
      await store.setRequestStatus("acme", "payments-skills", 1, "merged", "2026-10-02T08:00:00.000Z");
      await store.transitionRequest("acme", "payments-skills", 2, "open", "merged");
      await store.setRequestStatus("acme", "payments-skills", 3, "merged", "2026-10-02T08:00:00.000Z");
      await store.setRequestStatus("acme", "payments-skills", 3, "open");

      // when
      const [one, two, three] = await Promise.all([1, 2, 3].map((n) => store.getRequest("acme", "payments-skills", n)));

      // then
      expect(one?.mergedAt).toBe("2026-10-02T08:00:00.000Z");
      expect(Date.parse(two!.mergedAt!)).toBeGreaterThan(Date.parse("2026-10-01T00:00:00.000Z"));
      expect(three).not.toHaveProperty("mergedAt");
    });
  });

  it("given a lease one holder took, when another asks before it runs out and after, then only the second ask takes it, and the other tenant's is apart", async () => {
    await using(fresh, async (store) => {
      // given
      expect(await store.claimLease("acme", "forge.renewing.gitlab", "web", "2026-11-02T10:01:00.000Z", "2026-11-02T10:00:00.000Z")).toBe(true);

      // when
      const early = await store.claimLease("acme", "forge.renewing.gitlab", "runner", "2026-11-02T10:01:30.000Z", "2026-11-02T10:00:30.000Z");
      const elsewhere = await store.claimLease("globex", "forge.renewing.gitlab", "runner", "2026-11-02T10:01:30.000Z", "2026-11-02T10:00:30.000Z");
      const late = await store.claimLease("acme", "forge.renewing.gitlab", "runner", "2026-11-02T10:02:30.000Z", "2026-11-02T10:01:30.000Z");

      // then
      expect([early, elsewhere, late]).toEqual([false, true, true]);
      expect(await store.getSetting("acme", "forge.renewing.gitlab")).toBe("2026-11-02T10:02:30.000Z runner");
    });
  });

  it("given a setting saved in two tenants, when one is replaced and the other deleted, then each tenant reads only its own", async () => {
    await using(fresh, async (store) => {
      // given
      await store.setSetting("acme", "integration.slack", "first");
      await store.setSetting("globex", "integration.slack", "theirs");

      // when
      await store.setSetting("acme", "integration.slack", "second");
      await store.deleteSetting("globex", "integration.slack");

      // then
      expect(await store.getSetting("acme", "integration.slack")).toBe("second");
      expect(await store.getSetting("globex", "integration.slack")).toBeNull();
    });
  });

  it("given a repository upserted twice and synced, when repositories are listed, then one row carries the latest name and the head", async () => {
    await using(fresh, async (store) => {
      // given
      await store.upsertRepo({ tenant: "acme", id: "payments-skills", team: "Payments", name: "old", url: "file:///x.git" });
      await store.upsertRepo({ tenant: "acme", id: "payments-skills", team: "Payments", name: "payments-skills", url: "file:///x.git" });
      await store.recordSync("acme", "payments-skills", { head: "b".repeat(40) });

      // when
      const repos = await store.listRepos("acme");

      // then
      expect(repos).toHaveLength(1);
      expect(repos[0]).toMatchObject({ name: "payments-skills", head: "b".repeat(40), error: null });

      // when the next sync fails
      await store.recordSync("acme", "payments-skills", { error: "unreachable" });

      // then the last good head is kept beside the error
      expect(await store.getRepo("acme", "payments-skills")).toMatchObject({ head: "b".repeat(40), error: "unreachable" });
    });
  });

  it("given saved requests, when numbers, lists and status changes are read, then numbers count up per repository and the newest is listed first", async () => {
    await using(fresh, async (store) => {
      // given
      expect(await store.nextRequestNumber("acme", "payments-skills")).toBe(1);
      await store.saveRequest(request("acme", 1, "2026-10-01T00:00:00.000Z"));
      expect(await store.nextRequestNumber("acme", "payments-skills")).toBe(2);
      await store.saveRequest(request("acme", 2, "2026-10-02T00:00:00.000Z"));

      // when
      await store.setRequestStatus("acme", "payments-skills", 1, "merged");

      // then
      expect(await store.nextRequestNumber("acme", "payments-skills")).toBe(3);
      expect((await store.listRequests("acme")).map((r) => r.number)).toEqual([2, 1]);
      expect(await store.getRequest("acme", "payments-skills", 1)).toMatchObject({ status: "merged", number: 1 });
      expect(await store.getRequest("acme", "payments-skills", 9)).toBeNull();
    });
  });

  it("given requests a task opened on its own repository and on a target and requests no task opened, when a member, a task's starter and a team's owner read a page, then a task's request follows its task and any other its team or its opener", async () => {
    await using(fresh, async (store) => {
      // given
      const target = (repoId: string, requestNumber: number): TaskTarget => ({ repoId, status: "request", reason: "r", baseSha: null, branch: null, tests: null, requestNumber, error: null, cost: { usd: null, inputTokens: null, outputTokens: null } });
      await store.createTask({ ...task("acme", "aaaaaaaaaaaa", "needs-review"), requestNumber: 1 });
      await store.createTask({ ...task("acme", "bbbbbbbbbbbb", "needs-review"), repoId: "service-a", team: "Platform", createdBy: "lee@example.invalid", targetMode: "pinned" });
      await store.setTaskTargets("acme", "bbbbbbbbbbbb", [target("service-b", 7)]);
      await store.saveRequest(request("acme", 1, "2026-10-01T00:00:00.000Z"));
      await store.saveRequest(request("acme", 2, "2026-10-02T00:00:00.000Z"));
      await store.saveRequest({ ...request("acme", 3, "2026-10-03T00:00:00.000Z"), createdBy: "max@example.invalid" });
      await store.saveRequest({ ...request("acme", 7, "2026-10-04T00:00:00.000Z"), repoId: "service-b", createdBy: "lee@example.invalid" });
      const page = async (seenBy: { repoIds: string[]; taskTeams: string[]; people: string[] }) => (await store.requestPage("acme", { seenBy }, null, 10)).requests.map((r) => `${r.repoId}#${r.number}`);

      // when
      const member = await page({ repoIds: ["payments-skills"], taskTeams: [], people: ["max@example.invalid"] });
      const starter = await page({ repoIds: [], taskTeams: [], people: ["lee@example.invalid"] });
      const owner = await page({ repoIds: ["payments-skills"], taskTeams: ["Payments"], people: ["bo@example.invalid"] });

      // then
      expect(member).toEqual(["payments-skills#3", "payments-skills#2"]);
      expect(starter).toEqual(["service-b#7"]);
      expect(owner).toEqual(["payments-skills#3", "payments-skills#2", "payments-skills#1"]);
    });
  });

  it("given a request whose head passes, then a newer head fails, then a later head passes, when each check is recorded, then the failure holds it with why and the later pass lifts the hold, while a pass of the held head itself does not", async () => {
    await using(fresh, async (store) => {
      // given
      await store.saveRequest(request("acme", 1, "2026-10-01T00:00:00.000Z"));
      const read = async () => {
        const r = (await store.getRequest("acme", "payments-skills", 1))!;
        return [r.checkedHead ?? null, r.heldHead ?? null, r.heldReason ?? null];
      };
      const before = await read();

      // when
      await store.recordRequestCheck("acme", "payments-skills", 1, { head: "a".repeat(40), passed: true });
      const passed = await read();
      await store.recordRequestCheck("acme", "payments-skills", 1, { head: "b".repeat(40), passed: false, reason: "commit bbbbbbb: it looks like it holds a secret" });
      const held = await read();
      await store.recordRequestCheck("acme", "payments-skills", 1, { head: "b".repeat(40), passed: true });
      const stillHeld = await read();
      await store.recordRequestCheck("acme", "payments-skills", 1, { head: "c".repeat(40), passed: true });
      const lifted = await read();

      // then
      expect(before).toEqual([null, null, null]);
      expect(passed).toEqual(["a".repeat(40), null, null]);
      expect(held).toEqual(["a".repeat(40), "b".repeat(40), "commit bbbbbbb: it looks like it holds a secret"]);
      expect(stillHeld).toEqual(["b".repeat(40), "b".repeat(40), "commit bbbbbbb: it looks like it holds a secret"]);
      expect(lifted).toEqual(["c".repeat(40), null, null]);
    });
  });

  it("given requests in two repositories and three states, when a page is read, then it holds the newest of the filter's matches and the counts of every state", async () => {
    await using(fresh, async (store) => {
      // given
      for (let n = 1; n <= 7; n++) {
        await store.saveRequest({ ...request("acme", n, `2026-10-0${n}T00:00:00.000Z`), status: n % 3 === 0 ? "merged" : n % 3 === 1 ? "open" : "closed" });
      }
      await store.saveRequest({ ...request("acme", 1, "2026-10-09T00:00:00.000Z"), repoId: "platform-skills" });
      await store.saveRequest(request("other", 1, "2026-10-09T00:00:00.000Z"));

      // when
      const first = await store.requestPage("acme", {}, null, 3);
      const second = await store.requestPage("acme", {}, first.next, 3);
      const last = await store.requestPage("acme", {}, second.next, 3);
      const open = await store.requestPage("acme", { repoId: "payments-skills", status: "open" }, null, 10);
      const seen = await store.requestPage("acme", { seenBy: { repoIds: ["platform-skills"], taskTeams: [], people: [] } }, null, 10);
      const none = await store.requestPage("acme", { seenBy: { repoIds: [], taskTeams: [], people: ["nobody@example.invalid"] } }, null, 10);

      // then
      expect(first.requests.map((r) => `${r.repoId}#${r.number}`)).toEqual(["platform-skills#1", "payments-skills#7", "payments-skills#6"]);
      expect(second.requests.map((r) => r.number)).toEqual([5, 4, 3]);
      expect(last.requests.map((r) => r.number)).toEqual([2, 1]);
      expect(last.next).toBeNull();
      expect(first.total).toBe(8);
      expect(first.counts).toEqual({ open: 4, merged: 2, closed: 2 });
      expect(open.requests.map((r) => r.number)).toEqual([7, 4, 1]);
      expect(open.total).toBe(3);
      expect(open.counts).toEqual({ open: 3, merged: 2, closed: 2 });
      expect([seen.requests.map((r) => `${r.repoId}#${r.number}`), seen.total]).toEqual([["platform-skills#1"], 1]);
      expect([none.requests, none.total]).toEqual([[], 0]);
    });
  });

  it.each([
    ["a newer request is opened", (store: Store) => store.saveRequest(request("acme", 6, "2026-10-06T00:00:00.000Z"))],
    ["a request on the page read is merged", (store: Store) => store.transitionRequest("acme", "payments-skills", 5, "open", "merged")],
  ])("given a page of open requests read, when %s before the next page, then the next page neither repeats a row nor skips one", async (_label, between) => {
    await using(fresh, async (store) => {
      // given
      for (let n = 1; n <= 5; n++) await store.saveRequest(request("acme", n, `2026-10-0${n}T00:00:00.000Z`));
      const first = await store.requestPage("acme", { status: "open" }, null, 2);

      // when
      await between(store);
      const second = await store.requestPage("acme", { status: "open" }, first.next, 2);

      // then
      expect(first.requests.map((r) => r.number)).toEqual([5, 4]);
      expect(second.requests.map((r) => r.number)).toEqual([3, 2]);
    });
  });

  it("given requests opened at the same moment in two repositories, when they are read a page at a time, then each is read exactly once", async () => {
    await using(fresh, async (store) => {
      // given
      const at = "2026-10-01T00:00:00.000Z";
      for (let n = 1; n <= 3; n++) await store.saveRequest(request("acme", n, at));
      for (let n = 1; n <= 2; n++) await store.saveRequest({ ...request("acme", n, at), repoId: "platform-skills" });

      // when
      const read: string[] = [];
      let after: Awaited<ReturnType<Store["requestPage"]>>["next"] = null;
      for (let pages = 0; pages < 10 && (pages === 0 || after); pages++) {
        const page: Awaited<ReturnType<Store["requestPage"]>> = await store.requestPage("acme", {}, after, 2);
        read.push(...page.requests.map((r) => `${r.repoId}#${r.number}`));
        after = page.next;
      }

      // then
      expect(read).toEqual(["payments-skills#3", "payments-skills#2", "payments-skills#1", "platform-skills#2", "platform-skills#1"]);
    });
  });

  it("given tasks started at the same moment and others earlier, when they are read a page at a time, then each is read exactly once, newest first", async () => {
    await using(fresh, async (store) => {
      // given
      const at = (minute: number) => `2026-10-23T10:0${minute}:00.000Z`;
      for (const [id, minute] of [["aaaaaaaaaaaa", 1], ["bbbbbbbbbbbb", 2], ["cccccccccccc", 2], ["dddddddddddd", 2], ["eeeeeeeeeeee", 0]] as const) await store.createTask({ ...task("acme", id, "needs-review"), createdAt: at(minute) });
      await store.createTask({ ...task("other", "ffffffffffff", "needs-review"), createdAt: at(3) });

      // when
      const read: string[] = [];
      let after: Awaited<ReturnType<Store["taskPage"]>>["next"] = null;
      for (let pages = 0; pages < 10 && (pages === 0 || after); pages++) {
        const page: Awaited<ReturnType<Store["taskPage"]>> = await store.taskPage("acme", {}, after, 2);
        read.push(...page.tasks.map((t) => t.id));
        after = page.next;
      }

      // then
      expect(read).toEqual(["bbbbbbbbbbbb", "cccccccccccc", "dddddddddddd", "aaaaaaaaaaaa", "eeeeeeeeeeee"]);
    });
  });

  it("given tasks on two teams by two people, when a page is read for one person's view and spend is summed, then only the tasks the filter names count, summed per person and repository", async () => {
    await using(fresh, async (store) => {
      // given
      const cost = (usd: number | null) => ({ usd, inputTokens: null, outputTokens: null });
      await store.createTask({ ...task("acme", "aaaaaaaaaaaa", "needs-review"), cost: cost(1.25) });
      await store.createTask({ ...task("acme", "bbbbbbbbbbbb", "needs-review"), team: "Platform", createdBy: "grace@example.invalid", cost: cost(2) });
      await store.createTask({ ...task("acme", "cccccccccccc", "failed"), team: "Platform", cost: cost(null) });
      await store.createTask({ ...task("acme", "dddddddddddd", "needs-review"), team: "Platform", createdBy: "grace@example.invalid", createdAt: "2026-10-01T00:00:00.000Z", cost: cost(4) });

      // when
      const ids = async (filter: Parameters<Store["taskPage"]>[1]) => (await store.taskPage("acme", filter, null, 10)).tasks.map((t) => t.id).sort();

      // then
      expect(await ids({ visibleTo: { teams: [], creators: ["ada@example.invalid"] } })).toEqual(["aaaaaaaaaaaa", "cccccccccccc"]);
      expect(await ids({ visibleTo: { teams: ["Platform"], creators: [] } })).toEqual(["bbbbbbbbbbbb", "cccccccccccc", "dddddddddddd"]);
      expect(await ids({ createdBy: [] })).toEqual([]);
      expect(await store.taskSpendRows("acme", { visibleTo: { teams: ["Platform"], creators: [] }, since: "2026-10-20T00:00:00.000Z" })).toEqual([
        { repoId: "payments-skills", team: "Platform", createdBy: "ada@example.invalid", usd: 0, tasks: 1, unknownCost: 1, largestUsd: 0 },
        { repoId: "payments-skills", team: "Platform", createdBy: "grace@example.invalid", usd: 2, tasks: 1, unknownCost: 0, largestUsd: 2 },
      ]);
      expect(await store.taskSpendRows("acme", { createdBy: ["grace@example.invalid"] })).toEqual([{ repoId: "payments-skills", team: "Platform", createdBy: "grace@example.invalid", usd: 6, tasks: 2, unknownCost: 0, largestUsd: 4 }]);
    });
  });

  it("given model spend outside tasks, one of it recorded twice and one of unknown cost, when it is read since a time and by who spent it, then it is grouped as tasks' spend is, counted once, with no task in it", async () => {
    await using(fresh, async (store) => {
      // given
      const spend = (id: string, createdBy: string, at: string, usd: number | null) => ({ tenant: "acme", id, createdBy, repoId: "payments-skills", team: "Platform", at, kind: "skill-suggestion", usd, inputTokens: 10, outputTokens: 20 });
      await store.recordExtraSpend(spend("s1", "grace@example.invalid", "2026-10-21T00:00:00.000Z", 0.5));
      await store.recordExtraSpend(spend("s1", "grace@example.invalid", "2026-10-21T00:00:00.000Z", 0.5));
      await store.recordExtraSpend(spend("s2", "grace@example.invalid", "2026-10-22T00:00:00.000Z", 1.25));
      await store.recordExtraSpend(spend("s3", "grace@example.invalid", "2026-10-23T00:00:00.000Z", null));
      await store.recordExtraSpend(spend("s4", "ada@example.invalid", "2026-09-01T00:00:00.000Z", 9));
      await store.recordExtraSpend({ ...spend("s5", "grace@example.invalid", "2026-10-22T00:00:00.000Z", 7), tenant: "globex" });

      // when
      const since = await store.extraSpendRows("acme", { since: "2026-10-01T00:00:00.000Z" });
      const byAda = await store.extraSpendRows("acme", { createdBy: ["ada@example.invalid"] });
      const byNobody = await store.extraSpendRows("acme", { createdBy: [] });

      // then
      expect(since).toEqual([{ repoId: "payments-skills", team: "Platform", createdBy: "grace@example.invalid", usd: 1.75, tasks: 0, unknownCost: 1, largestUsd: 1.25 }]);
      expect(byAda.map((r) => r.usd)).toEqual([9]);
      expect(byNobody).toEqual([]);
    });
  });

  it("given tasks that opened requests in two repositories under one number, when tasks are read by when their request opened and by text in their description, then only the matching repository's and the exact text's count", async () => {
    await using(fresh, async (store) => {
      // given
      await store.saveRequest(request("acme", 7, "2026-10-20T00:00:00.000Z"));
      await store.saveRequest({ ...request("acme", 7, "2026-09-01T00:00:00.000Z"), repoId: "platform-skills" });
      await store.createTask({ ...task("acme", "aaaaaaaaaaaa", "needs-review"), createdAt: "2026-10-01T00:00:00.000Z", requestNumber: 7, description: "From [a comment](https://forge.example.invalid/c/1_%)" });
      await store.createTask({ ...task("acme", "bbbbbbbbbbbb", "needs-review"), repoId: "platform-skills", requestNumber: 7, description: "From [a comment](https://forge.example.invalid/c/12a)" });
      await store.createTask({ ...task("acme", "cccccccccccc", "needs-review"), requestNumber: null });

      // when
      const ids = async (filter: Parameters<Store["taskPage"]>[1]) => (await store.taskPage("acme", filter, null, 10)).tasks.map((t) => t.id).sort();

      // then
      expect(await ids({ requestOpenedSince: "2026-10-20T00:00:00.000Z" })).toEqual(["aaaaaaaaaaaa"]);
      expect(await ids({ requestOpenedSince: "2026-10-20T00:00:00.001Z" })).toEqual([]);
      expect(await ids({ descriptionHas: "(https://forge.example.invalid/c/1_%)" })).toEqual(["aaaaaaaaaaaa"]);
      expect(await ids({ descriptionHas: "c/1" })).toEqual(["aaaaaaaaaaaa", "bbbbbbbbbbbb"]);
    });
  });

  it("given a task over three repositories, when its targets are put, one is updated and the task is read, then they come back in order with their costs, and a task over one carries none", async () => {
    await using(fresh, async (store) => {
      // given
      const target = (repoId: string, requestNumber: number | null, usd: number | null): TaskTarget => ({ repoId, status: "planned", reason: `because ${repoId}`, baseSha: null, branch: null, tests: null, requestNumber, error: null, cost: { usd, inputTokens: null, outputTokens: null } });
      await store.createTask({ ...task("acme", "aaaaaaaaaaaa", "running"), targetMode: "orchestrator" });
      await store.createTask({ ...task("acme", "bbbbbbbbbbbb", "running"), targetMode: "pinned" });
      await store.createTask(task("acme", "cccccccccccc", "running"));
      await store.setTaskTargets("acme", "aaaaaaaaaaaa", [target("service-a", null, null), target("bff", null, null), target("gateway", null, null)]);

      // when
      await store.setTaskTargets("acme", "aaaaaaaaaaaa", [target("service-a", 3, 0.5), target("bff", null, null), target("gateway", null, null)]);
      await store.updateTaskTarget("acme", "aaaaaaaaaaaa", 1, { status: "request", requestNumber: 7, branch: "TEAM-1-x", cost: { usd: 1.25, inputTokens: 10, outputTokens: 20 } });
      const [many, planning, one] = await Promise.all(["aaaaaaaaaaaa", "bbbbbbbbbbbb", "cccccccccccc"].map((id) => store.getTask("acme", id)));
      const unfinished = await store.unfinishedTasks("acme");

      // then
      expect(many!.targetMode).toBe("orchestrator");
      expect(many!.targets!.map((t) => [t.repoId, t.status, t.requestNumber, t.cost.usd])).toEqual([["service-a", "planned", 3, 0.5], ["bff", "request", 7, 1.25], ["gateway", "planned", null, null]]);
      expect(many!.targets![1]).toMatchObject({ branch: "TEAM-1-x", cost: { inputTokens: 10, outputTokens: 20 } });
      expect([planning!.targetMode, planning!.targets]).toEqual(["pinned", []]);
      expect(one).not.toHaveProperty("targets");
      expect(unfinished.find((u) => u.id === "aaaaaaaaaaaa")!.targets).toEqual([{ repoId: "service-a", branch: null }, { repoId: "bff", branch: "TEAM-1-x" }, { repoId: "gateway", branch: null }]);
      expect(unfinished.find((u) => u.id === "cccccccccccc")!.targets).toEqual([]);
    });
  });

  it("given a task started with two skills and one with none, when the first moves through its stages and ends, then it keeps its skills, reads each stage, and the other carries neither", async () => {
    await using(fresh, async (store) => {
      // given
      await store.createTask({ ...task("acme", "aaaaaaaaaaaa", "running"), skills: ["add-ledger-migration", "release-checklist"], mode: "approval-required" });
      await store.createTask(task("acme", "bbbbbbbbbbbb", "running"));

      // when
      const stages = [];
      for (const stage of ["working", "tests", "request", null] as const) {
        await store.updateTask("acme", "aaaaaaaaaaaa", { stage });
        stages.push((await store.getTask("acme", "aaaaaaaaaaaa"))!.stage ?? null);
      }

      // then
      expect(stages).toEqual(["working", "tests", "request", null]);
      expect((await store.getTask("acme", "aaaaaaaaaaaa"))!.mode).toBe("approval-required");
      expect((await store.getTask("acme", "aaaaaaaaaaaa"))!.skills).toEqual(["add-ledger-migration", "release-checklist"]);
      const none = await store.getTask("acme", "bbbbbbbbbbbb");
      expect(none).not.toHaveProperty("stage");
      expect(none).not.toHaveProperty("skills");
      expect(none).not.toHaveProperty("mode");
    });
  });

  it("given a task that delegated two, one of which delegated on twice, and the same ids in another organization, when children and descendants are read, then each task sees only what is below it, with its parent and depth", async () => {
    await using(fresh, async (store) => {
      // given
      const at = (n: number) => `2026-11-02T10:0${n}:00.000Z`;
      const child = (tenant: string, id: string, parentId: string, depth: number, n: number) => ({ ...task(tenant, id, "running"), createdAt: at(n), parentId, depth });
      await store.createTask({ ...task("a", "tsk_root", "running"), createdAt: at(0) });
      await store.createTask(child("a", "tsk_a", "tsk_root", 1, 1));
      await store.createTask(child("a", "tsk_b", "tsk_root", 1, 2));
      await store.createTask(child("a", "tsk_a1", "tsk_a", 2, 3));
      await store.createTask(child("a", "tsk_a2", "tsk_a1", 3, 4));
      await store.createTask({ ...task("b", "tsk_root", "running"), createdAt: at(0) });
      await store.createTask(child("b", "tsk_x", "tsk_root", 1, 5));

      // when
      const ids = (tasks: TaskRecord[]) => tasks.map((t) => t.id);
      const children = ids(await store.taskChildren("a", "tsk_root"));
      const belowA = ids(await store.taskDescendants("a", "tsk_a"));
      const belowRoot = ids(await store.taskDescendants("a", "tsk_root"));
      const belowLeaf = ids(await store.taskDescendants("a", "tsk_a2"));

      // then
      expect(children).toEqual(["tsk_a", "tsk_b"]);
      expect(belowA).toEqual(["tsk_a1", "tsk_a2"]);
      expect(belowRoot).toEqual(["tsk_a", "tsk_b", "tsk_a1", "tsk_a2"]);
      expect(belowLeaf).toEqual([]);
      expect(await store.getTask("a", "tsk_a2")).toMatchObject({ parentId: "tsk_a1", depth: 3 });
      expect(await store.getTask("a", "tsk_root")).not.toHaveProperty("parentId");
      expect(ids(await store.taskDescendants("b", "tsk_root"))).toEqual(["tsk_x"]);
    });
  });

  it("given a task whose target A opened #3 and target B opened #7, when tasks are read by repository and request, then a pair matches only from one row, a repository matches through a target, and a status stays the task's own", async () => {
    await using(fresh, async (store) => {
      // given
      const target = (repoId: string, requestNumber: number): TaskTarget => ({ repoId, status: "request", reason: "r", baseSha: null, branch: null, tests: null, requestNumber, error: null, cost: { usd: null, inputTokens: null, outputTokens: null } });
      await store.createTask({ ...task("acme", "aaaaaaaaaaaa", "needs-review"), repoId: "service-a", requestNumber: null, targetMode: "pinned" });
      await store.setTaskTargets("acme", "aaaaaaaaaaaa", [target("service-a", 3), target("service-b", 7)]);
      await store.createTask({ ...task("acme", "bbbbbbbbbbbb", "running"), repoId: "service-b", requestNumber: 3 });
      await store.saveRequest({ ...request("acme", 7, "2026-10-20T00:00:00.000Z"), repoId: "service-b" });

      // when
      const ids = async (filter: Parameters<Store["taskPage"]>[1]) => (await store.taskPage("acme", filter, null, 10)).tasks.map((t) => t.id).sort();

      // then
      expect(await ids({ repoId: "service-b", requestNumber: 3 })).toEqual(["bbbbbbbbbbbb"]);
      expect(await ids({ repoId: "service-b", requestNumber: 7 })).toEqual(["aaaaaaaaaaaa"]);
      expect(await ids({ repoId: "service-a", requestNumber: 3 })).toEqual(["aaaaaaaaaaaa"]);
      expect(await ids({ repoId: "service-b" })).toEqual(["aaaaaaaaaaaa", "bbbbbbbbbbbb"]);
      expect(await ids({ repoId: "service-b", statuses: ["running"] })).toEqual(["bbbbbbbbbbbb"]);
      expect(await ids({ requestOpenedSince: "2026-10-20T00:00:00.000Z" })).toEqual(["aaaaaaaaaaaa"]);
      expect((await store.taskSpendRows("acme", { repoId: "service-b" })).reduce((n, r) => n + r.tasks, 0)).toBe(2);
    });
  });

  it("given an open request, when two callers move it from open at once, then exactly one succeeds", async () => {
    await using(fresh, async (store) => {
      await store.saveRequest(request("acme", 1, "2026-10-01T00:00:00.000Z"));
      const moved = await Promise.all([
        store.transitionRequest("acme", "payments-skills", 1, "open", "merged"),
        store.transitionRequest("acme", "payments-skills", 1, "open", "closed"),
      ]);
      expect(moved.filter(Boolean)).toHaveLength(1);
      expect(["merged", "closed"]).toContain((await store.getRequest("acme", "payments-skills", 1))!.status);
    });
  });

  it("given five reservations at once, when they all return, then each holds a different number in order with no gap", async () => {
    await using(fresh, async (store) => {
      const numbers = await Promise.all(Array.from({ length: 5 }, () => store.nextRequestNumber("acme", "payments-skills")));
      expect([...numbers].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
      expect(await store.nextRequestNumber("acme", "platform-skills")).toBe(1);
    });
  });

  it("given requests recorded before the counter existed, when the first number is reserved, then it carries on after the highest", async () => {
    await using(fresh, async (store) => {
      await store.saveRequest(request("acme", 7, "2026-10-01T00:00:00.000Z"));
      expect(await store.nextRequestNumber("acme", "payments-skills")).toBe(8);
    });
  });

  it("given counts added twice for the same skill and hour, when usage is read, then they are summed as a number", async () => {
    await using(fresh, async (store) => {
      // given
      await store.addUsage("acme", "payments-skills", "release-checklist", "2026-10-23T09", 2);
      await store.addUsage("acme", "payments-skills", "release-checklist", "2026-10-23T09", 3);
      await store.addUsage("acme", "payments-skills", "release-checklist", "2026-10-23T10", 1);

      // when
      const usage = await store.usage("acme", "2026-10-01T00", "payments-skills");

      // then
      expect(usage).toEqual([{ repoId: "payments-skills", skill: "release-checklist", count: 6, lastHour: "2026-10-23T10" }]);
    });
  });

  it("given counts over two days, two skills and two tenants, when usage is read per day, then each day is summed within the window and tenant", async () => {
    await using(fresh, async (store) => {
      // given
      await store.addUsage("acme", "payments-skills", "release-checklist", "2026-10-22T23", 4);
      await store.addUsage("acme", "payments-skills", "release-checklist", "2026-10-23T09", 2);
      await store.addUsage("acme", "payments-skills", "release-checklist", "2026-10-23T17", 3);
      await store.addUsage("acme", "payments-skills", "add-ledger-migration", "2026-10-23T10", 1);
      await store.addUsage("acme", "payments-skills", "release-checklist", "2026-10-20T10", 9);
      await store.addUsage("globex", "payments-skills", "release-checklist", "2026-10-23T09", 7);

      // when
      const daily = await store.usageDaily("acme", "2026-10-22T00", "payments-skills");

      // then
      expect(daily).toEqual([
        { repoId: "payments-skills", skill: "release-checklist", day: "2026-10-22", count: 4 },
        { repoId: "payments-skills", skill: "add-ledger-migration", day: "2026-10-23", count: 1 },
        { repoId: "payments-skills", skill: "release-checklist", day: "2026-10-23", count: 5 },
      ]);
    });
  });

  it("given an address in use in a tenant, when another account takes it there and in another tenant, then only the other tenant accepts it", async () => {
    await using(fresh, async (store) => {
      // given
      await store.insertUser(user("acme", "ada@example.invalid"));

      // when
      const same = store.insertUser(user("acme", "ada@example.invalid"));
      const other = store.insertUser(user("globex", "ada@example.invalid"));

      // then
      await expect(same).rejects.toThrow();
      await expect(other).resolves.toBeUndefined();
      expect(await store.countUsers("acme")).toBe(1);
      expect((await store.getUserByEmail("globex", "ada@example.invalid"))?.tenant).toBe("globex");
    });
  });

  it("given ten first-owner claims racing on an empty tenant, when they all run, then exactly one wins and one account exists", async () => {
    await using(fresh, async (store) => {
      // when
      const results = await Promise.all(
        Array.from({ length: 10 }, (_, i) => store.claimSetup(user("acme", `owner${i}@example.invalid`, { role: "owner" }))),
      );

      // then
      expect(results.filter(Boolean)).toHaveLength(1);
      expect(await store.countUsers("acme")).toBe(1);
    });
  });

  it("given an account's role, name and owned teams changed, when it is read back, then the changes hold and removing it removes its sessions and teams", async () => {
    await using(fresh, async (store) => {
      // given
      const u = user("acme", "olu@example.invalid", { oidcIssuer: "https://idp.example.invalid", oidcSubject: "s-1" });
      await store.insertUser(u);
      await store.updateUser("acme", u.id, { name: "Olu" });
      expect(await store.setRole("acme", u.id, "owner")).toBe(true);
      await store.setOwnedTeams("acme", u.id, ["Payments", "Platform", "Payments"]);
      await store.saveSession({ tokenHash: "h1", tenant: "acme", userId: u.id, csrf: "c1", expiresAt: "2099-01-01T00:00:00.000Z" });

      // when
      const read = await store.getUserByOidc("acme", "https://idp.example.invalid", "s-1");

      // then
      expect(read).toMatchObject({ role: "owner", name: "Olu" });
      expect(await store.ownedTeams("acme", u.id)).toEqual(["Payments", "Platform"]);
      expect(await store.teamOwners("acme")).toEqual([
        { userId: u.id, team: "Payments" },
        { userId: u.id, team: "Platform" },
      ]);

      // when it is removed
      await store.insertUser(user("acme", "second@example.invalid", { role: "owner" }));
      expect(await store.deleteUser("acme", u.id)).toBe(true);

      // then
      expect(await store.getUser("acme", u.id)).toBeNull();
      expect(await store.getSession("h1")).toBeNull();
      expect(await store.ownedTeams("acme", u.id)).toEqual([]);
    });
  });

  it("given an owner written without the setup marker, as a database from before the marker holds one, when setup is claimed, then it is refused and no second owner appears", async () => {
    await using(fresh, async (store) => {
      // given
      await store.insertUser(user("acme", "ada@example.invalid", { role: "owner" }));

      // when
      const claimed = await store.claimSetup(user("acme", "eve@example.invalid", { role: "owner" }));

      // then
      expect(claimed).toBe(false);
      expect(await store.countOwners("acme")).toBe(1);
    });
  });

  it("given two owners demoting each other at the same moment, when both run, then exactly one change lands and the organization keeps an owner", async () => {
    await using(fresh, async (store) => {
      for (let round = 0; round < 5; round++) {
        // given
        const tenant = `race-${round}`;
        const a = user(tenant, "a@example.invalid", { role: "owner" });
        const b = user(tenant, "b@example.invalid", { role: "owner" });
        await store.insertUser(a);
        await store.insertUser(b);

        // when
        const results = await Promise.all([store.setRole(tenant, a.id, "admin"), store.setRole(tenant, b.id, "member")]);

        // then
        expect(results.filter(Boolean)).toHaveLength(1);
        expect(await store.countOwners(tenant)).toBe(1);
      }
    });
  });

  it("given the last owner, when they are demoted or removed, then both are refused and anyone else's change still goes through", async () => {
    await using(fresh, async (store) => {
      // given
      const owner = user("acme", "o@example.invalid", { role: "owner" });
      const admin = user("acme", "a@example.invalid", { role: "admin" });
      await store.insertUser(owner);
      await store.insertUser(admin);

      // when
      const demoted = await store.setRole("acme", owner.id, "admin");
      const removed = await store.deleteUser("acme", owner.id);
      const adminDemoted = await store.setRole("acme", admin.id, "member");

      // then
      expect([demoted, removed, adminDemoted]).toEqual([false, false, true]);
      expect((await store.getUser("acme", owner.id))?.role).toBe("owner");
    });
  });

  it("given an invitation, when its link is taken twice at once and another tenant takes it, then exactly one take gets it and the other tenant gets nothing", async () => {
    await using(fresh, async (store) => {
      // given
      const base = { tenant: "acme", email: "kim@example.invalid", role: "member" as const, teams: ["Payments"], invitedBy: "ada@example.invalid", createdAt: "2026-10-25T00:00:00.000Z", expiresAt: "2099-01-01T00:00:00.000Z" };
      await store.saveInvite({ ...base, id: "i1", tokenHash: "t1" });
      await store.saveInvite({ ...base, id: "i2", tokenHash: "t2" });

      // when
      const elsewhere = await store.takeInviteByToken("globex", "t2");
      const takes = await Promise.all([store.takeInviteByToken("acme", "t2"), store.takeInviteByToken("acme", "t2")]);

      // then
      expect(elsewhere).toBeNull();
      expect(takes.filter(Boolean)).toEqual([expect.objectContaining({ id: "i2", teams: ["Payments"] })]);
      expect(await store.getInviteByToken("t1")).toBeNull();
      expect(await store.listInvites("acme")).toEqual([]);
    });
  });

  it("given a member's API key, when it is used, revoked, and the member removed, then each change reads back and removing the member removes the key", async () => {
    await using(fresh, async (store) => {
      // given
      const owner = user("acme", "o@example.invalid", { role: "owner" });
      const member = user("acme", "m@example.invalid");
      await store.insertUser(owner);
      await store.insertUser(member);
      const scopes = { repositories: "read", requests: "none", tasks: "none", usage: "none", members: "none", settings: "none", keys: "none" } as const;
      await store.saveKey({ tenant: "acme", id: "k1", prefix: "th_sk_000000000001", secretHash: "h", name: "ci", owner: { kind: "user", id: member.id }, scopes, createdBy: member.email, createdAt: "2026-10-25T00:00:00.000Z", expiresAt: null, lastUsedAt: null, revokedAt: null, mintedBy: null });

      // when
      await store.touchKey("acme", "k1", "2026-10-25T01:00:00.000Z");
      await store.revokeKey("acme", "k1", "2026-10-25T02:00:00.000Z");
      await store.revokeKey("acme", "k1", "2026-10-25T03:00:00.000Z");

      // then
      expect(await store.keyByPrefix("th_sk_000000000001")).toMatchObject({ scopes, lastUsedAt: "2026-10-25T01:00:00.000Z", revokedAt: "2026-10-25T02:00:00.000Z" });
      await store.deleteUser("acme", member.id);
      expect(await store.listKeys("acme", { kind: "user", id: member.id })).toEqual([]);
    });
  });

  it("given a key that minted a key that minted another, and a sibling it did not mint, when the first is revoked, then every generation it minted is revoked and the sibling is not", async () => {
    await using(fresh, async (store) => {
      // given
      const scopes = { repositories: "read", requests: "none", tasks: "none", usage: "none", members: "none", settings: "none", keys: "write" } as const;
      const key = (id: string, mintedBy: string | null) => ({ tenant: "acme", id, prefix: `th_sk_00000000000${id}`, secretHash: id, name: id, owner: { kind: "user" as const, id: "u1" }, scopes, createdBy: "a@example.invalid", createdAt: "2026-10-25T00:00:00.000Z", expiresAt: null, lastUsedAt: null, revokedAt: null, mintedBy });
      await store.saveKey(key("p", null));
      await store.saveKey(key("c", "p"));
      await store.saveKey(key("g", "c"));
      await store.saveKey(key("s", null));

      // when
      await store.revokeKey("acme", "p", "2026-10-25T01:00:00.000Z");

      // then
      expect((await store.listKeys("acme", { kind: "user", id: "u1" })).map((k) => [k.id, k.revokedAt !== null]).sort()).toEqual([["c", true], ["g", true], ["p", true], ["s", false]]);
    });
  });

  it("given a setting written twice and task log lines on either side of a cut, when the log is purged at the cut, then the setting reads its last value and only the older lines go", async () => {
    await using(fresh, async (store) => {
      // given
      await store.setSetting("acme", "privacy.taskLogDays", "30");
      await store.setSetting("acme", "privacy.taskLogDays", "7");
      await store.createTask(task("acme", "aaaaaaaaaaaa", "needs-review"));
      await store.appendTaskLog("acme", "aaaaaaaaaaaa", ["kept"]);
      const cut = new Date(Date.now() - 1000).toISOString();

      // when
      const before = await store.purgeTaskLog("acme", cut);
      const after = await store.purgeTaskLog("acme", new Date(Date.now() + 1000).toISOString());

      // then
      expect(await store.getSetting("acme", "privacy.taskLogDays")).toBe("7");
      expect(await store.getSetting("globex", "privacy.taskLogDays")).toBeNull();
      expect([before, after]).toEqual([0, 1]);
    });
  });

  it("given skill use on either side of an hour, when counts are purged before it, then only the older ones go and only in that organization", async () => {
    await using(fresh, async (store) => {
      // given
      await store.addUsage("acme", "payments-skills", "deploy", "2026-01-01T10", 2);
      await store.addUsage("acme", "payments-skills", "deploy", "2026-06-01T10", 3);
      await store.addUsage("globex", "payments-skills", "deploy", "2026-01-01T10", 4);

      // when
      const removed = await store.purgeUsage("acme", "2026-03-01T00");

      // then
      expect(removed).toBe(1);
      expect((await store.usage("acme", "2025-01-01T00")).map((u) => u.count)).toEqual([3]);
      expect((await store.usage("globex", "2025-01-01T00")).map((u) => u.count)).toEqual([4]);
    });
  });

  it("given members' groups, a mapping and tags by hand, when each is replaced, then each reads back as the last one written", async () => {
    await using(fresh, async (store) => {
      // when
      await store.setMemberGroups("acme", "u1", ["eng", "all", "eng"]);
      await store.setMemberGroups("acme", "u1", ["ops"]);
      await store.setGroupTags("acme", [{ group: "eng", tag: "backend" }]);
      await store.setGroupTags("acme", [{ group: "ops", tag: "on-call" }]);
      await store.setManualTags("acme", "u1", ["lead", "lead"]);

      // then
      expect(await store.memberGroups("acme")).toEqual([{ userId: "u1", group: "ops" }]);
      expect(await store.groupTags("acme")).toEqual([{ group: "ops", tag: "on-call" }]);
      expect(await store.manualTags("acme")).toEqual([{ userId: "u1", tag: "lead" }]);
      expect(await store.memberGroups("globex")).toEqual([]);
    });
  });

  it("given two tenants adding the same domain, when one verifies it twice, then only its row is verified, once, and removing it leaves the other tenant's", async () => {
    await using(fresh, async (store) => {
      // given
      const row = (tenant: string) => ({ tenant, domain: "acme.example", token: `t-${tenant}`, addedBy: "a@acme.example", addedAt: "2026-10-25T00:00:00.000Z", verifiedAt: null });
      await store.saveDomain(row("acme"));
      await store.saveDomain(row("globex"));

      // when
      await store.markDomainVerified("acme", "acme.example", "2026-10-25T01:00:00.000Z");
      await store.markDomainVerified("acme", "acme.example", "2026-10-25T02:00:00.000Z");
      await store.deleteDomain("acme", "acme.example");

      // then
      expect(await store.listDomains("acme")).toEqual([]);
      expect(await store.listDomains("globex")).toEqual([{ ...row("globex") }]);
    });
  });

  it("given a member with their own MCP servers' sealed credentials and an app they approved, when the account is deleted, then those go with it and another member's stay", async () => {
    await using(fresh, async (store) => {
      // given
      const kim = user("acme", "kim@example.invalid");
      const lee = user("acme", "lee@example.invalid");
      await store.insertUser(kim);
      await store.insertUser(lee);
      for (const who of [kim, lee]) {
        await store.setSetting("acme", `mcp.personal.${who.id}`, "[]");
        await store.putSecret("acme", `mcp.personal.${who.id}.tickets.oauth`, "sealed", who.email);
        await store.setSetting("acme", `oauth.grant.g-${who.id}`, JSON.stringify({ userId: who.id, clientName: "app", scopes: [], createdAt: "2026-10-25T00:00:00.000Z", tokens: [`h-${who.id}`] }));
        await store.setSetting("acme", `oauth.token.h-${who.id}`, JSON.stringify({ kind: "access", grant: `g-${who.id}`, userId: who.id, scopes: [], expiresAt: "2099-01-01T00:00:00.000Z" }));
      }

      // when
      await store.deleteUser("acme", kim.id);

      // then
      expect(await store.getSecret("acme", `mcp.personal.${kim.id}.tickets.oauth`)).toBeNull();
      expect(await store.getSetting("acme", `mcp.personal.${kim.id}`)).toBeNull();
      expect(await store.getSetting("acme", `oauth.grant.g-${kim.id}`)).toBeNull();
      expect(await store.getSetting("acme", `oauth.token.h-${kim.id}`)).toBeNull();
      expect(await store.getSecret("acme", `mcp.personal.${lee.id}.tickets.oauth`)).toBe("sealed");
      expect(await store.getSetting("acme", `oauth.grant.g-${lee.id}`)).not.toBeNull();
      expect(await store.getSetting("acme", `oauth.token.h-${lee.id}`)).not.toBeNull();
    });
  });

  it("given secrets under two prefixes and two tenants, when one prefix is listed, then only that tenant's names under it come back, with who set them and never the sealed value", async () => {
    await using(fresh, async (store) => {
      // given
      await store.putSecret("acme", "task.secret.team.Payments.B", "sealed-b", "ada@example.invalid");
      await store.putSecret("acme", "task.secret.repo.payments-skills.A", "sealed-a", "ada@example.invalid");
      await store.putSecret("acme", "forge.token.payments-skills", "sealed-f", "ada@example.invalid");
      await store.putSecret("globex", "task.secret.team.Payments.C", "sealed-c", "gil@example.invalid");

      // when
      const listed = await store.listSecrets("acme", "task.secret.");

      // then
      expect(listed.map((s) => [s.name, s.updatedBy])).toEqual([
        ["task.secret.repo.payments-skills.A", "ada@example.invalid"],
        ["task.secret.team.Payments.B", "ada@example.invalid"],
      ]);
      expect(JSON.stringify(listed)).not.toContain("sealed-");
    });
  });

  it("given settings under a prefix and an account's address and app approvals, when they are listed, changed and dropped, then each reads back in this tenant only", async () => {
    await using(fresh, async (store) => {
      // given
      const kim = user("acme", "kim@example.invalid");
      await store.insertUser(kim);
      await store.setSetting("acme", "scim.group.b", "{}");
      await store.setSetting("acme", "scim.group.a", "{}");
      await store.setSetting("acme", "scim.token", "{}");
      await store.setSetting("globex", "scim.group.c", "{}");
      await store.setSetting("acme", "oauth.grant.g", JSON.stringify({ userId: kim.id }));

      // when
      const listed = await store.listSettings("acme", "scim.group.");
      await store.setUserEmail("acme", kim.id, "kim.lee@example.invalid");
      await store.dropOauthGrants("acme", kim.id);

      // then
      expect(listed.map((r) => r.key)).toEqual(["scim.group.a", "scim.group.b"]);
      expect((await store.getUser("acme", kim.id))!.email).toBe("kim.lee@example.invalid");
      expect(await store.getSetting("acme", "oauth.grant.g")).toBeNull();
    });
  });

  it("given two owners, when both are turned off at the same moment, then exactly one is and one owner stays on", async () => {
    await using(fresh, async (store) => {
      for (let round = 0; round < 5; round++) {
        // given
        const tenant = `off-${round}`;
        const a = user(tenant, "a@example.invalid", { role: "owner" });
        const b = user(tenant, "b@example.invalid", { role: "owner" });
        await store.insertUser(a);
        await store.insertUser(b);

        // when
        const results = await Promise.all([store.turnOffUser(tenant, a.id, "2026-10-25T00:00:00.000Z"), store.turnOffUser(tenant, b.id, "2026-10-25T00:00:00.000Z")]);

        // then
        expect(results.filter(Boolean)).toHaveLength(1);
        expect(await store.countOwners(tenant)).toBe(1);
      }
    });
  });

  it("given three sessions of one person, when the others are ended, then only the kept one remains", async () => {
    await using(fresh, async (store) => {
      // given
      for (const h of ["h1", "h2", "h3"]) await store.saveSession({ tokenHash: h, tenant: "acme", userId: "u", csrf: `c-${h}`, expiresAt: "2099-01-01T00:00:00.000Z" });

      // when
      await store.deleteSessions("acme", "u", "h2");

      // then
      expect(await store.getSession("h1")).toBeNull();
      // A session saved without its start is stamped with the time it was saved, which renewal counts its most from.
      expect(await store.getSession("h2")).toEqual({ tokenHash: "h2", tenant: "acme", userId: "u", csrf: "c-h2", expiresAt: "2099-01-01T00:00:00.000Z", createdAt: expect.any(String) });
      expect(await store.getSession("h3")).toBeNull();
    });
  });

  it("given saved sign-in states, when each is taken by eight callers at once, then exactly one caller gets each", async () => {
    await using(fresh, async (store) => {
      // given
      const states = Array.from({ length: 20 }, (_, i) => `st-${i}`);
      for (const state of states) await store.saveOidcLogin({ state, tenant: "acme", nonce: "n", verifier: "v", expiresAt: "2099-01-01T00:00:00.000Z" });

      // when
      const takers = await Promise.all(states.map((state) => Promise.all(Array.from({ length: 8 }, () => store.takeOidcLogin(state)))));

      // then
      expect(takers.map((got) => got.filter(Boolean).length)).toEqual(states.map(() => 1));
      expect(takers[0]!.find(Boolean)).toEqual({ state: "st-0", tenant: "acme", nonce: "n", verifier: "v", expiresAt: "2099-01-01T00:00:00.000Z" });
    });
  });

  it("given a sealed secret and a forge configuration, when each is replaced and read, then the latest is kept and deleting removes it", async () => {
    await using(fresh, async (store) => {
      // given
      await store.putSecret("acme", "forge:payments-skills", "v1.a.b.c", "ada@example.invalid");
      await store.putSecret("acme", "forge:payments-skills", "v1.d.e.f", "grace@example.invalid");
      await store.setForgeConfig("acme", { repoId: "payments-skills", kind: "gitlab", apiUrl: "https://gitlab.example.invalid/api/v4", project: "acme/old" });
      await store.setForgeConfig("acme", { repoId: "payments-skills", kind: "gitlab", apiUrl: "https://gitlab.example.invalid/api/v4", project: "acme/payments-skills" });

      // when
      const sealed = await store.getSecret("acme", "forge:payments-skills");
      const setAt = await store.secretSetAt("acme", "forge:payments-skills");
      const forge = await store.getForgeConfig("acme", "payments-skills");

      // then
      expect(sealed).toBe("v1.d.e.f");
      expect(setAt?.updatedBy).toBe("grace@example.invalid");
      expect(forge).toEqual({ repoId: "payments-skills", kind: "gitlab", apiUrl: "https://gitlab.example.invalid/api/v4", project: "acme/payments-skills" });

      // when both are removed
      await store.deleteSecret("acme", "forge:payments-skills");
      await store.deleteForgeConfig("acme", "payments-skills");

      // then
      expect(await store.getSecret("acme", "forge:payments-skills")).toBeNull();
      expect(await store.getForgeConfig("acme", "payments-skills")).toBeNull();
    });
  });

  it("given an ingest id per repository, when one is replaced, then the old id writes nowhere and each id names only its own repository", async () => {
    await using(fresh, async (store) => {
      // given
      await store.setIngestId("a", "payments-skills", "p".repeat(32));
      await store.setIngestId("a", "platform-skills", "l".repeat(32));

      // when
      await store.setIngestId("a", "payments-skills", "q".repeat(32));

      // then
      expect(await store.ingestId("a", "payments-skills")).toBe("q".repeat(32));
      expect(await store.repoForIngest("p".repeat(32))).toBeNull();
      expect(await store.repoForIngest("q".repeat(32))).toEqual({ tenant: "a", repoId: "payments-skills" });
      expect(await store.repoForIngest("l".repeat(32))).toEqual({ tenant: "a", repoId: "platform-skills" });
    });
  });

  it("given a repository with requests, a number, counts, a task and an ingest id, when it is removed, then only its row and ingest id go, and another tenant's same id stays", async () => {
    await using(fresh, async (store) => {
      // given
      for (const tenant of ["a", "b"]) {
        await store.upsertRepo({ tenant, id: "payments-skills", team: "Payments", name: "payments-skills", url: "file:///x.git" });
        await store.setIngestId(tenant, "payments-skills", tenant.repeat(32));
      }
      expect(await store.nextRequestNumber("a", "payments-skills")).toBe(1);
      await store.saveRequest({ ...request("a", 1, "2026-10-01T00:00:00.000Z"), status: "merged" });
      await store.addUsage("a", "payments-skills", "release-checklist", "2026-10-01T00", 2);
      await store.createTask(task("a", "aaaaaaaaaaaa", "needs-review"));

      // when
      await store.removeRepo("a", "payments-skills");

      // then
      expect(await store.getRepo("a", "payments-skills")).toBeNull();
      expect(await store.repoForIngest("a".repeat(32))).toBeNull();
      expect(await store.getRepo("b", "payments-skills")).not.toBeNull();
      expect(await store.repoForIngest("b".repeat(32))).toEqual({ tenant: "b", repoId: "payments-skills" });
      expect((await store.listRequests("a", "payments-skills")).map((r) => r.number)).toEqual([1]);
      expect(await store.nextRequestNumber("a", "payments-skills")).toBe(2);
      expect((await store.usage("a", "2000-01-01T00", "payments-skills"))[0]!.count).toBe(2);
      expect(await store.getTask("a", "aaaaaaaaaaaa")).not.toBeNull();
    });
  });

  it("given requests in two tenants, when every tenant's are read, then both tenants' rows come back", async () => {
    await using(fresh, async (store) => {
      await store.upsertRepo({ tenant: "a", id: "payments-skills", team: "Payments", name: "payments-skills", url: "file:///x.git" });
      await store.upsertRepo({ tenant: "b", id: "payments-skills", team: "Payments", name: "payments-skills", url: "file:///x.git" });
      await store.saveRequest(request("a", 1, "2026-10-01T00:00:00.000Z"));
      await store.saveRequest(request("b", 1, "2026-10-02T00:00:00.000Z"));
      expect((await store.allRequests()).map((r) => `${r.tenant}#${r.number}`)).toEqual(["a#1", "b#1"]);
    });
  });

  it("given rows of every kind in tenant A, when tenant B reads, then it sees none of them", async () => {
    await using(fresh, async (store) => {
      // given
      await store.upsertRepo({ tenant: "a", id: "payments-skills", team: "Payments", name: "payments-skills", url: "file:///x.git" });
      await store.saveRequest(request("a", 1, "2026-10-01T00:00:00.000Z"));
      await store.addUsage("a", "payments-skills", "release-checklist", "2026-10-23T09", 1);
      const u = user("a", "ada@example.invalid");
      await store.insertUser(u);
      await store.setOwnedTeams("a", u.id, ["Payments"]);
      await store.putSecret("a", "forge:payments-skills", "v1.a.b.c", "ada@example.invalid");
      await store.setForgeConfig("a", { repoId: "payments-skills", kind: "github", apiUrl: "https://api.github.com", project: "a/payments-skills" });
      await store.setIngestId("a", "payments-skills", "i".repeat(32));

      // when
      const seen = {
        repos: await store.listRepos("b"),
        repo: await store.getRepo("b", "payments-skills"),
        requests: await store.listRequests("b"),
        nextNumber: await store.nextRequestNumber("b", "payments-skills"),
        usage: await store.usage("b", "2000-01-01T00"),
        users: await store.listUsers("b"),
        user: await store.getUser("b", u.id),
        owners: await store.teamOwners("b"),
        secret: await store.getSecret("b", "forge:payments-skills"),
        forge: await store.getForgeConfig("b", "payments-skills"),
        ingest: await store.ingestId("b", "payments-skills"),
      };

      // then
      expect(seen).toEqual({ repos: [], repo: null, requests: [], nextNumber: 1, usage: [], users: [], user: null, owners: [], secret: null, forge: null, ingest: null });
      expect(await store.repoForIngest("i".repeat(32))).toEqual({ tenant: "a", repoId: "payments-skills" });
    });
  });

  it("given organization A's task, spend, invitation, member, keys, policy, request and limits, when organization B reads and writes them by their ids, then B sees none, changes none, and its counts and limits stay its own", async () => {
    await using(fresh, async (store) => {
      // given
      const at = "2026-11-02T10:00:00.000Z";
      await store.upsertRepo({ tenant: "a", id: "payments-skills", team: "Payments", name: "payments-skills", url: "file:///x.git" });
      await store.createTask({ ...task("a", "aaaaaaaaaaaa", "running"), stage: "working", skills: ["release-checklist"], targetMode: "pinned" });
      await store.setTaskTargets("a", "aaaaaaaaaaaa", [{ repoId: "payments-skills", status: "working", reason: "r", baseSha: null, branch: null, tests: null, requestNumber: null, error: null, cost: { usd: null, inputTokens: null, outputTokens: null } }]);
      await store.appendTaskLog("a", "aaaaaaaaaaaa", ["started"]);
      await store.recordExtraSpend({ tenant: "a", id: "s1", createdBy: "ada@example.invalid", repoId: "payments-skills", team: "Payments", at, kind: "skill-suggestion", usd: 2, inputTokens: 1, outputTokens: 1 });
      const invite = { tenant: "a", id: "inv_a", email: "new@example.invalid", role: "member" as const, teams: [], tokenHash: "token-a", invitedBy: "owner@example.invalid", createdAt: at, expiresAt: "2026-11-09T10:00:00.000Z" };
      await store.saveInvite(invite);
      const member = user("a", "ada@example.invalid", { identityId: "idn_a" });
      await store.insertUser(member);
      await store.saveKey({ tenant: "a", id: "key_a", prefix: "th_sk_00000000000a", secretHash: "h", name: "ci", owner: { kind: "user", id: member.id }, scopes: { repositories: "read", requests: "none", tasks: "none", usage: "none", members: "none", settings: "none", keys: "none" }, createdBy: member.email, createdAt: at, expiresAt: null, lastUsedAt: null, revokedAt: null, mintedBy: null });
      await store.putSecret("a", "model:anthropic", "v1.a.b.c", member.email);
      await store.putPolicy({ tenant: "a", id: "pol_a", name: "Task budget", audience: '{"kind":"workspace"}', rules: "[]", updatedAt: at, updatedBy: member.email });
      await store.saveRequest(request("a", 1, at));
      await store.setSetting("a", "org.name", "Acme");
      await store.insertOrg({ tenant: "a", name: "a", createdBy: "idn_a", createdAt: at, quotas: { members: 1, tasksPerMonth: 10, concurrentTasks: 1 }, deletedAt: null });
      await store.insertOrg({ tenant: "b", name: "b", createdBy: "idn_b", createdAt: at, quotas: { members: 5, tasksPerMonth: null, concurrentTasks: null }, deletedAt: null });

      // when B reads by A's ids
      const seen = {
        task: await store.getTask("b", "aaaaaaaaaaaa"),
        tasks: await store.listTasks("b"),
        log: await store.taskLog("b", "aaaaaaaaaaaa", 0),
        unfinished: await store.unfinishedTasks("b"),
        spend: await store.taskSpendRows("b", {}),
        extra: await store.extraSpendRows("b", {}),
        invite: await store.getInvite("b", "inv_a"),
        invites: await store.listInvites("b"),
        byToken: await store.takeInviteByToken("b", "token-a"),
        byEmail: await store.takeInviteByEmail("b", "new@example.invalid", at),
        user: await store.getUser("b", member.id),
        byIdentity: await store.getUserByIdentity("b", "idn_a"),
        key: await store.getKey("b", "key_a"),
        secret: await store.getSecret("b", "model:anthropic"),
        policies: await store.listPolicies("b"),
        request: await store.getRequest("b", "payments-skills", 1),
        name: await store.getSetting("b", "org.name"),
        members: await store.countMembers("b"),
      };

      // and writes by A's ids
      await store.updateTask("b", "aaaaaaaaaaaa", { status: "failed", stage: null });
      await store.setTaskTargets("b", "aaaaaaaaaaaa", []);
      await expect(store.appendTaskLog("b", "aaaaaaaaaaaa", ["planted"])).rejects.toThrow();
      await store.deleteInvite("b", "inv_a");
      await store.setRole("b", member.id, "owner");
      await store.deleteSessions("b", member.id);
      await store.deleteUser("b", member.id);
      await store.revokeKey("b", "key_a", at);
      await store.deleteSecret("b", "model:anthropic");
      await store.deletePolicy("b", "pol_a");
      await store.setRequestStatus("b", "payments-skills", 1, "closed");
      await store.setOrgQuotas("b", { members: null, tasksPerMonth: null, concurrentTasks: null });
      const joinedB = await store.insertMember(user("b", "bea@example.invalid"), 5);

      // then B saw nothing
      expect(seen).toEqual({ task: null, tasks: [], log: [], unfinished: [], spend: [], extra: [], invite: null, invites: [], byToken: null, byEmail: null, user: null, byIdentity: null, key: null, secret: null, policies: [], request: null, name: null, members: 0 });

      // and A kept everything as it was
      expect(await store.getTask("a", "aaaaaaaaaaaa")).toMatchObject({ status: "running", stage: "working", skills: ["release-checklist"], targets: [{ repoId: "payments-skills", status: "working" }] });
      expect((await store.taskLog("a", "aaaaaaaaaaaa", 0)).map((l) => l.text)).toEqual(["started"]);
      expect((await store.extraSpendRows("a", {})).map((r) => r.usd)).toEqual([2]);
      expect(await store.getInvite("a", "inv_a")).toMatchObject({ email: "new@example.invalid" });
      expect(await store.getUser("a", member.id)).toMatchObject({ role: "member", sessionsRevokedAt: null });
      expect((await store.getKey("a", "key_a"))?.revokedAt).toBeNull();
      expect(await store.getSecret("a", "model:anthropic")).toBe("v1.a.b.c");
      expect((await store.listPolicies("a")).map((p) => p.id)).toEqual(["pol_a"]);
      expect((await store.getRequest("a", "payments-skills", 1))?.status).toBe(request("a", 1, at).status);
      expect((await store.getOrg("a"))?.quotas).toEqual({ members: 1, tasksPerMonth: 10, concurrentTasks: 1 });

      // and each organization's members count against its own limit
      expect(joinedB).toBe(true);
      expect([await store.countMembers("a"), await store.countMembers("b")]).toEqual([1, 1]);
      expect(await store.insertMember(user("a", "second@example.invalid"), 1)).toBe(false);
    });
  });

  it("given events of several kinds by two people and by the orchestrator, when the first of each kind is read, overall and per person, then the oldest kept one comes back, a tie goes to the lower id, the orchestrator's are left out per person, and another organization's never count", async () => {
    await using(fresh, async (store) => {
      // given
      const event = (tenant: string, id: string, at: string, kind: string, actor: string | null) => ({ tenant, id, at, kind, actor: actor ? { kind: "user" as const, id: actor, email: `${actor}@example.invalid`, name: actor } : { kind: "orchestrator" as const, id: null, email: null, name: "TeamHandbook Orchestrator" }, repoId: null, subject: null, detail: kind });
      await store.appendEvent(event("a", "evt_3", "2026-11-02T10:00:00.000Z", "task.started", "ada"));
      await store.appendEvent(event("a", "evt_2", "2026-11-02T10:00:00.000Z", "task.started", "bo"));
      await store.appendEvent(event("a", "evt_4", "2026-11-02T11:00:00.000Z", "task.started", "ada"));
      await store.appendEvent(event("a", "evt_1", "2026-11-02T09:00:00.000Z", "org.created", null));
      await store.appendEvent(event("a", "evt_5", "2026-11-02T12:00:00.000Z", "request.opened", "bo"));
      await store.appendEvent(event("a", "evt_6", "2026-11-02T12:30:00.000Z", "account.signin", "ada"));
      await store.appendEvent(event("b", "evt_0", "2026-11-01T00:00:00.000Z", "task.started", "ada"));

      // when
      const kinds = ["org.created", "task.started", "request.opened", "request.merged"];
      const first = await store.firstEvents("a", kinds);
      const byActor = await store.firstEventsByActor("a", kinds);

      // then
      expect(Object.fromEntries(Object.entries(first).map(([kind, e]) => [kind, e.id]))).toEqual({ "org.created": "evt_1", "task.started": "evt_2", "request.opened": "evt_5" });
      expect(Object.fromEntries(Object.entries(byActor).map(([actor, firsts]) => [actor, Object.fromEntries(Object.entries(firsts).map(([kind, e]) => [kind, e.id]))]))).toEqual({ ada: { "task.started": "evt_3" }, bo: { "task.started": "evt_2", "request.opened": "evt_5" } });
      expect(first["task.started"]).toMatchObject({ tenant: "a", at: "2026-11-02T10:00:00.000Z", actor: { id: "bo" } });
      expect([await store.firstEvents("a", []), await store.firstEventsByActor("a", [])]).toEqual([{}, {}]);
    });
  });

  it("given a task updated through its run, when it is read back, then status, timings, cost and request hold, and another tenant sees none of it", async () => {
    await using(fresh, async (store) => {
      // given
      await store.createTask(task("a", "aaaaaaaaaaaa", "running"));

      // when
      await store.updateTask("a", "aaaaaaaaaaaa", { status: "needs-review", finishedAt: "2026-10-23T10:05:00.000Z", tests: "passed", requestNumber: 3, cost: { usd: 0.0425, inputTokens: 200, outputTokens: 75 } });

      // then
      const read = await store.getTask("a", "aaaaaaaaaaaa");
      expect(read).toMatchObject({ status: "needs-review", tests: "passed", requestNumber: 3, cost: { usd: 0.0425, inputTokens: 200, outputTokens: 75 }, finishedAt: "2026-10-23T10:05:00.000Z" });
      expect(await store.listTasks("a", "payments-skills")).toHaveLength(1);
      expect(await store.listTasks("b")).toEqual([]);
      expect(await store.getTask("b", "aaaaaaaaaaaa")).toBeNull();
    });
  });

  it("given log lines written by several writers at once, when the log is read, then every line has its own number in order and a cursor returns only later lines", async () => {
    await using(fresh, async (store) => {
      // given
      await store.createTask(task("a", "bbbbbbbbbbbb", "running"));

      // when
      await Promise.all([store.appendTaskLog("a", "bbbbbbbbbbbb", ["one", "two"]), store.appendTaskLog("a", "bbbbbbbbbbbb", ["three"]), store.appendTaskLog("a", "bbbbbbbbbbbb", ["four", "five"])]);

      // then
      const all = await store.taskLog("a", "bbbbbbbbbbbb", 0);
      expect(all.map((l) => l.seq)).toEqual([1, 2, 3, 4, 5]);
      expect(all.map((l) => l.text).sort()).toEqual(["five", "four", "one", "three", "two"]);
      expect((await store.taskLog("a", "bbbbbbbbbbbb", 3)).map((l) => l.seq)).toEqual([4, 5]);
    });
  });

  it("given a running task's process group, when unfinished tasks are read and the group is cleared, then the group comes back as a number and then as none", async () => {
    await using(fresh, async (store) => {
      // given
      await store.createTask(task("a", "gggggggggggg", "running"));
      await store.createTask(task("a", "hhhhhhhhhhhh", "needs-review"));

      // when
      await store.setTaskProcess("a", "gggggggggggg", 4242);
      await store.setTaskBranch("a", "gggggggggggg", "task/gggggggggggg");
      const recorded = await store.unfinishedTasks("a");
      await store.setTaskProcess("a", "gggggggggggg", null);

      // then
      expect(recorded).toEqual([{ id: "gggggggggggg", repoId: "payments-skills", pgid: 4242, branch: "task/gggggggggggg", targets: [] }]);
      expect(await store.unfinishedTasks("a")).toEqual([{ id: "gggggggggggg", repoId: "payments-skills", pgid: null, branch: "task/gggggggggggg", targets: [] }]);
      expect(await store.unfinishedTasks("b")).toEqual([]);
    });
  });

  it("given tasks left queued, running and finished, when a restart interrupts the tenant, then only the unfinished ones fail", async () => {
    await using(fresh, async (store) => {
      // given
      await store.createTask(task("a", "cccccccccccc", "queued"));
      await store.createTask(task("a", "dddddddddddd", "running"));
      await store.createTask(task("a", "eeeeeeeeeeee", "needs-review"));
      await store.createTask(task("b", "ffffffffffff", "running"));

      // when
      const interrupted = await store.interruptTasks("a", "restarted");

      // then
      expect(interrupted).toBe(2);
      expect((await store.listTasks("a")).map((t) => [t.id, t.status]).sort()).toEqual([["cccccccccccc", "failed"], ["dddddddddddd", "failed"], ["eeeeeeeeeeee", "needs-review"]]);
      expect((await store.getTask("b", "ffffffffffff"))?.status).toBe("running");
    });
  });
});

describe.each(drivers)("the %s store's record of the skills a task's agent called", (_name, fresh) => {
  it("given two different skills noted at once on one task, when both writes finish, then both names are kept", async () => {
    await using(fresh, async (store) => {
      // given
      await store.createTask(task("a", "tsk_a", "running"));

      // when
      await Promise.all([store.noteUsedSkill("a", "tsk_a", "add-field"), store.noteUsedSkill("a", "tsk_a", "release-notes"), store.noteUsedSkill("a", "tsk_a", "db-query")]);

      // then
      expect([...(await store.getTask("a", "tsk_a"))!.usedSkills!].sort()).toEqual(["add-field", "db-query", "release-notes"]);
    });
  });

  it("given a skill called twice and more skills than the record holds, when each is noted, then a name is kept once, nothing past the most, and another tenant's task is untouched", async () => {
    await using(fresh, async (store) => {
      // given
      await store.createTask(task("a", "tsk_a", "running"));
      await store.createTask(task("b", "tsk_a", "running"));

      // when
      await store.noteUsedSkill("a", "tsk_a", "add-field");
      await store.noteUsedSkill("a", "tsk_a", "add-field");
      for (let i = 0; i < 25; i++) await store.noteUsedSkill("a", "tsk_a", `skill-${i}`);
      await store.noteUsedSkill("a", "tsk_missing", "x");

      // then
      const held = (await store.getTask("a", "tsk_a"))!.usedSkills!;
      expect([held.length, held[0], held.filter((n) => n === "add-field").length]).toEqual([20, "add-field", 1]);
      expect((await store.getTask("b", "tsk_a"))!.usedSkills).toBeUndefined();
    });
  });
});

describe.each(drivers)("the %s store's task effects", (_name, fresh) => {
  const at = "2026-11-02T10:00:00.000Z";
  const later = (seconds: number) => new Date(Date.parse(at) + seconds * 1000).toISOString();
  const push = (branch: string): EffectInput => ({ kind: "branch.push", payload: { branch }, replay: "replay-safe" });

  it("given a command that creates a task with two effects and an event, when it is sent twice and twice more at once, then one task, one event and two effects are written and every repeat gets the first receipt back", async () => {
    await using(fresh, async (store) => {
      // given
      const command: TaskCommand = {
        tenant: "a",
        taskId: "tsk_a",
        at,
        receipt: { actorId: "usr_ada", commandId: "cmd-1", kind: "task.start", result: '{"task":"tsk_a"}' },
        createTask: task("a", "tsk_a", "queued"),
        events: [{ tenant: "a", id: "evt_a", at, kind: "task.started", actor: { kind: "user", id: "usr_ada", email: "ada@example.invalid", name: "Ada" }, repoId: "payments-skills", subject: "task:tsk_a", detail: "started" }],
        effects: [push("task/a"), { kind: "request.open", payload: { branch: "task/a" }, replay: "replay-safe" }],
      };

      // when
      const first = await store.commitCommand(command);
      const again = await store.commitCommand(command);
      const atOnce = await Promise.all([store.commitCommand(command), store.commitCommand(command)]);

      // then
      expect(first.replayed).toBe(false);
      expect(first.effects.map((e) => [e.seq, e.kind, e.status])).toEqual([[1, "branch.push", "pending"], [2, "request.open", "pending"]]);
      expect([again, ...atOnce].map((r) => [r.replayed, r.receipt?.result, r.effects.length])).toEqual([[true, '{"task":"tsk_a"}', 0], [true, '{"task":"tsk_a"}', 0], [true, '{"task":"tsk_a"}', 0]]);
      expect(await store.listTasks("a")).toHaveLength(1);
      expect(await store.taskEffects("a", "tsk_a")).toHaveLength(2);
      expect(await store.getEvent("a", "evt_a")).toMatchObject({ kind: "task.started" });
      expect(await store.getReceipt("a", "usr_bo", "cmd-1")).toBeNull();
    });
  });

  it("given an effect whose payload holds a token, when its command is sent, then it is refused and nothing of the command is written", async () => {
    await using(fresh, async (store) => {
      // when
      const sent = store.commitCommand({ tenant: "a", taskId: "tsk_a", at, createTask: task("a", "tsk_a", "queued"), effects: [{ kind: "request.open", payload: { token: "ghp_" + "a".repeat(36) }, replay: "replay-safe" }] });

      // then
      await expect(sent).rejects.toThrow(/never a secret/);
      expect(await store.getTask("a", "tsk_a")).toBeNull();
      expect(await store.taskEffects("a", "tsk_a")).toEqual([]);
    });
  });

  it("given a task's two effects, when two workers claim at once, then one gets the first, the second waits until the first settles, and a settle by a worker that does not hold it is refused", async () => {
    await using(fresh, async (store) => {
      // given
      await store.commitCommand({ tenant: "a", taskId: "tsk_a", at, createTask: task("a", "tsk_a", "queued"), effects: [push("one"), push("two")] });

      // when
      const both = await Promise.all([store.claimEffect("w1", at, later(30)), store.claimEffect("w2", at, later(30))]);
      const held = both.find((e) => e !== null)!;
      const holder = held.claimedBy!;
      const whileHeld = await store.claimEffect("w3", at, later(30));
      const stranger = await store.settleEffect("a", held.id, "w3", { done: null }, at);
      const settled = await store.settleEffect("a", held.id, holder, { done: "pushed" }, later(1));
      const next = await store.claimEffect("w3", later(1), later(31));

      // then
      expect(both.filter((e) => e !== null).map((e) => e!.payload)).toEqual([{ branch: "one" }]);
      expect([whileHeld, stranger, settled]).toEqual([null, false, true]);
      expect(next).toMatchObject({ seq: 2, claimedBy: "w3", attempts: 1 });
      expect((await store.taskEffects("a", "tsk_a")).map((e) => [e.seq, e.status, e.result])).toEqual([[1, "done", "pushed"], [2, "pending", null]]);
    });
  });

  it("given a claimed effect whose lease runs out, when another worker claims it and the first one settles late, then the second holds it with its attempts counted and the late settle changes nothing", async () => {
    await using(fresh, async (store) => {
      // given
      await store.commitCommand({ tenant: "a", taskId: "tsk_a", at, createTask: task("a", "tsk_a", "queued"), effects: [push("one")] });
      const first = (await store.claimEffect("w1", at, later(30)))!;

      // when
      const early = await store.claimEffect("w2", later(10), later(40));
      const renewed = await store.renewEffect("a", first.id, "w1", later(60));
      const stillHeld = await store.claimEffect("w2", later(45), later(75));
      const taken = await store.claimEffect("w2", later(61), later(91));
      const late = await store.settleEffect("a", first.id, "w1", { done: null }, later(62));

      // then
      expect([early, renewed, stillHeld]).toEqual([null, true, null]);
      expect(taken).toMatchObject({ id: first.id, claimedBy: "w2", attempts: 2 });
      expect(late).toBe(false);
      expect(await store.renewEffect("a", first.id, "w1", later(120))).toBe(false);
    });
  });

  it("given three effects settled long ago, when they are pruned two at a time, then the oldest two go first and the third on the next page", async () => {
    await using(fresh, async (store) => {
      // given
      for (const [id, settledAt] of [["tsk_a", later(1)], ["tsk_b", later(2)], ["tsk_c", later(3)]] as const) {
        await store.commitCommand({ tenant: "a", taskId: id, at, createTask: task("a", id, "queued"), effects: [push(id)] });
        const claimed = (await store.claimEffect("w1", at, later(30), ["a"]))!;
        await store.settleEffect("a", claimed.id, "w1", { done: null }, settledAt);
      }

      // when
      const first = await store.pruneEffects(later(10), 2);
      const left = (await Promise.all(["tsk_a", "tsk_b", "tsk_c"].map((id) => store.taskEffects("a", id)))).map((e) => e.length);
      const second = await store.pruneEffects(later(10), 2);

      // then
      expect([first, left, second]).toEqual([2, [0, 0, 1], 1]);
    });
  });

  it("given an effect sent back with a later time and one that failed, when workers claim before and after that time and old rows are pruned, then the first waits for its time and the failed one is kept", async () => {
    await using(fresh, async (store) => {
      // given
      await store.commitCommand({ tenant: "a", taskId: "tsk_a", at, createTask: task("a", "tsk_a", "queued"), effects: [push("one")] });
      await store.commitCommand({ tenant: "a", taskId: "tsk_b", at, createTask: task("a", "tsk_b", "queued"), effects: [{ kind: "worktree.clean", payload: { path: "tasks/tsk_b" }, replay: "replay-safe" }] });
      await store.commitCommand({ tenant: "a", taskId: "tsk_c", at, createTask: task("a", "tsk_c", "queued"), effects: [push("three")] });
      const one = (await store.claimEffect("w1", at, later(30), ["a"]))!;
      await store.settleEffect("a", one.id, "w1", { retryAt: later(5), error: "the forge did not answer" }, at);

      // when
      const b = (await store.claimEffect("w1", at, later(30)))!;
      await store.settleEffect("a", b.id, "w1", { failed: "the folder is held open" }, at);
      const c = (await store.claimEffect("w1", at, later(30)))!;
      await store.settleEffect("a", c.id, "w1", { done: null }, at);
      const beforeItsTime = await store.claimEffect("w1", later(4), later(34));
      const atItsTime = await store.claimEffect("w1", later(5), later(35));
      const pruned = await store.pruneEffects(later(1), 1_000);

      // then
      expect([b.taskId, c.taskId, beforeItsTime]).toEqual(["tsk_b", "tsk_c", null]);
      expect(atItsTime).toMatchObject({ id: one.id, attempts: 2, lastError: "the forge did not answer" });
      expect(pruned).toBe(1);
      expect(await store.pruneEffects(later(1), 1_000)).toBe(0);
      expect((await store.taskEffects("a", "tsk_b")).map((e) => [e.status, e.lastError])).toEqual([["failed", "the folder is held open"]]);
      expect(await store.taskEffects("a", "tsk_c")).toEqual([]);
    });
  });

  it("given pending effects of both kinds, one held, in two organizations, when one organization recovers after a restart, then its process-bound ones are cancelled, its held replay-safe one is free again, and the other organization's are untouched and never claimed for it", async () => {
    await using(fresh, async (store) => {
      // given
      const turn: EffectInput = { kind: "agent.turn", payload: { prompt: "p1" }, replay: "process-bound" };
      await store.commitCommand({ tenant: "a", taskId: "tsk_a", at, createTask: task("a", "tsk_a", "queued"), effects: [push("one")] });
      await store.commitCommand({ tenant: "a", taskId: "tsk_b", at, createTask: task("a", "tsk_b", "queued"), effects: [turn] });
      await store.commitCommand({ tenant: "b", taskId: "tsk_c", at, createTask: task("b", "tsk_c", "queued"), effects: [turn] });
      const held = (await store.claimEffect("w1", at, later(300), ["a"]))!;

      // when
      const recovered = await store.recoverEffects("a", later(1));

      // then
      expect(recovered).toEqual({ cancelled: 1, requeued: held.replay === "replay-safe" ? 1 : 0 });
      expect((await store.taskEffects("a", "tsk_b"))[0]!.status).toBe("cancelled");
      expect((await store.taskEffects("a", "tsk_a"))[0]).toMatchObject({ status: "pending", claimedBy: null });
      expect((await store.taskEffects("b", "tsk_c"))[0]).toMatchObject({ status: "pending" });
      expect(await store.claimEffect("w2", later(2), later(30), ["a"])).toMatchObject({ tenant: "a", taskId: "tsk_a" });
      expect(await store.claimEffect("w2", later(2), later(30), [])).toBeNull();
    });
  });
});

describe.each(drivers)("the %s store's signup steps", (_name, fresh) => {
  it("given steps of two people, one before the window, when they are read since a time and old ones are pruned, then only the window's come back in order with the domain in lower case", async () => {
    await using(fresh, async (store) => {
      // given
      const step = (id: string, identityId: string, at: string, kind: IdentityEvent["kind"], org: string | null = null): IdentityEvent => ({ id, identityId, at, kind, provider: "google", emailDomain: "Example.INVALID", org });
      await store.recordIdentityEvent(step("ide_1", "idn_a", "2026-08-01T00:00:00.000Z", "signup.started"));
      await store.recordIdentityEvent(step("ide_2", "idn_b", "2026-11-02T10:00:00.000Z", "signup.started"));
      await store.recordIdentityEvent(step("ide_3", "idn_b", "2026-11-02T10:05:00.000Z", "org.created", "acme"));

      // when
      const recent = await store.identityEventsSince("2026-10-01T00:00:00.000Z");
      const pruned = await store.pruneIdentityEvents("2026-10-01T00:00:00.000Z");

      // then
      expect(recent.map((e) => [e.id, e.kind, e.emailDomain, e.org])).toEqual([["ide_2", "signup.started", "example.invalid", null], ["ide_3", "org.created", "example.invalid", "acme"]]);
      expect(pruned).toBe(1);
      expect((await store.identityEventsSince("2000-01-01T00:00:00.000Z")).map((e) => e.id)).toEqual(["ide_2", "ide_3"]);
    });
  });
});

describe.each(drivers)("the %s store's listed sessions", (_name, fresh) => {
  const session = (tokenHash: string, userId: string, createdAt: string, userAgent: string | null = "Firefox on macOS") => ({ tokenHash, tenant: "a", userId, csrf: `c-${tokenHash}`, expiresAt: "2026-11-03T10:00:00.000Z", createdAt, userAgent });

  it("given a person's two sessions and another person's, when they are listed after one is seen and one is ended by id, then the person sees theirs newest seen first with the current one marked and no token, and cannot end another person's", async () => {
    await using(fresh, async (store) => {
      // given
      await store.saveSession(session("h1", "usr_ada", "2026-11-02T09:00:00.000Z", `${"Firefox ".repeat(30)}on macOS`));
      await store.saveSession(session("h2", "usr_ada", "2026-11-02T10:00:00.000Z", null));
      await store.saveSession(session("h3", "usr_bo", "2026-11-02T10:00:00.000Z"));

      // when
      await store.touchSession("h1", "2026-11-02T11:00:00.000Z");
      const listed = await store.listSessions("a", "usr_ada", "h2");
      const others = (await store.listSessions("a", "usr_bo"))[0]!;
      const notMine = await store.deleteSessionById("a", "usr_ada", others.id);
      const mine = await store.deleteSessionById("a", "usr_ada", listed[0]!.id);

      // then
      expect(listed.map((l) => [l.lastSeenAt, l.current, l.userAgent?.length ?? null])).toEqual([["2026-11-02T11:00:00.000Z", false, 120], ["2026-11-02T10:00:00.000Z", true, null]]);
      expect(listed.every((l) => l.id.startsWith("ses_") && !JSON.stringify(l).includes("h1") && !JSON.stringify(l).includes("c-h"))).toBe(true);
      expect([notMine, mine]).toEqual([false, true]);
      expect(await store.getSession("h1")).toBeNull();
      expect(await store.getSession("h3")).not.toBeNull();
      expect(await store.listSessions("b", "usr_ada")).toEqual([]);
    });
  });

  it("given a person's session and an identity's, when each is seen with a later expiry, then with an earlier one, and one is seen after it ended, then the expiry only moves later and an ended session stays ended", async () => {
    await using(fresh, async (store) => {
      // given
      await store.saveSession(session("h1", "usr_ada", "2026-11-02T09:00:00.000Z"));
      await store.saveSession(session("h2", "usr_ada", "2026-11-02T09:00:00.000Z"));
      await store.saveIdentitySession({ tokenHash: "i1", identityId: "idn_a", csrf: "c", method: "google", domain: null, authenticatedAt: "2026-11-02T10:00:00.000Z", expiresAt: "2026-11-02T22:00:00.000Z", userAgent: null });

      // when
      await store.touchSession("h1", "2026-11-02T11:00:00.000Z", "2026-12-02T11:00:00.000Z");
      await store.touchSession("h1", "2026-11-02T12:00:00.000Z", "2026-11-04T00:00:00.000Z");
      await store.touchSession("h1", "2026-11-02T12:30:00.000Z");
      await store.touchIdentitySession("i1", "2026-11-02T11:00:00.000Z", "2026-11-03T11:00:00.000Z");
      await store.touchIdentitySession("i1", "2026-11-02T12:00:00.000Z", "2026-11-02T13:00:00.000Z");
      await store.deleteSession("h2");
      await store.touchSession("h2", "2026-11-02T13:00:00.000Z", "2026-12-02T13:00:00.000Z");

      // then
      expect(await store.getSession("h1")).toMatchObject({ expiresAt: "2026-12-02T11:00:00.000Z" });
      expect((await store.listSessions("a", "usr_ada"))[0]).toMatchObject({ lastSeenAt: "2026-11-02T12:30:00.000Z" });
      expect(await store.getIdentitySession("i1")).toMatchObject({ expiresAt: "2026-11-03T11:00:00.000Z" });
      expect(await store.getSession("h2")).toBeNull();
    });
  });

  it("given an identity's session and another identity's, when they are listed, seen and ended by id, then only the identity's own come back and end", async () => {
    await using(fresh, async (store) => {
      // given
      const identitySession = (tokenHash: string, identityId: string) => ({ tokenHash, identityId, csrf: "c", method: "google" as const, domain: null, authenticatedAt: "2026-11-02T10:00:00.000Z", expiresAt: "2026-11-02T22:00:00.000Z", userAgent: "Chrome on Linux" });
      await store.saveIdentitySession(identitySession("h1", "idn_a"));
      await store.saveIdentitySession(identitySession("h2", "idn_b"));

      // when
      await store.touchIdentitySession("h1", "2026-11-02T10:30:00.000Z");
      const listed = await store.listIdentitySessions("idn_a", "h1");
      const theirs = (await store.listIdentitySessions("idn_b"))[0]!;

      // then
      expect(listed).toEqual([{ id: expect.stringMatching(/^ses_/), createdAt: "2026-11-02T10:00:00.000Z", lastSeenAt: "2026-11-02T10:30:00.000Z", userAgent: "Chrome on Linux", expiresAt: "2026-11-02T22:00:00.000Z", current: true }]);
      expect(await store.deleteIdentitySessionById("idn_a", theirs.id)).toBe(false);
      expect(await store.deleteIdentitySessionById("idn_a", listed[0]!.id)).toBe(true);
      expect(await store.getIdentitySession("h1")).toBeNull();
      expect(await store.getIdentitySession("h2")).not.toBeNull();
    });
  });
});

describe.each(drivers)("the %s store's questions agents ask", (_name, fresh) => {
  const at = "2026-11-02T10:00:00.000Z";
  const asked = (id: string, sourceKey: string, kind: NewTaskRequest["kind"], tenant = "a"): NewTaskRequest => ({ tenant, id, taskId: "tsk_a", targetPosition: null, sourceKey, kind, payload: { command: "npm test" }, createdAt: at, expiresAt: "2026-11-02T10:10:00.000Z" });

  it("given a question an agent asked, when the runner reports it again and two browsers answer it at once, then it is kept once and only one answer counts", async () => {
    await using(fresh, async (store) => {
      // given
      const first = await store.recordTaskRequest(asked("req_1", "toolu_1", "command"));
      const again = await store.recordTaskRequest({ ...asked("req_2", "toolu_1", "command"), payload: { command: "rm -rf /" } });

      // when
      const answers = await Promise.all([
        store.answerTaskRequest("a", "req_1", { decision: "allow_once" }, "ada@example.invalid", "web", "2026-11-02T10:01:00.000Z"),
        store.answerTaskRequest("a", "req_1", { decision: "allow_for_task" }, "bo@example.invalid", "web", "2026-11-02T10:01:00.000Z"),
      ]);

      // then
      expect([first.created, again.created, again.request.id, again.request.payload]).toEqual([true, false, "req_1", { command: "npm test" }]);
      expect(answers.filter((a) => a !== null)).toHaveLength(1);
      expect((await store.taskRequests("a", "tsk_a")).map((r) => [r.id, r.status, r.answeredVia])).toEqual([["req_1", "answered", "web"]]);
      expect(await store.taskRequests("b", "tsk_a")).toEqual([]);
      expect(await store.answerTaskRequest("b", "req_1", { decision: "allow_once" }, "eve@example.invalid", "web", "2026-11-02T10:01:00.000Z")).toBeNull();
    });
  });

  it("given questions of each kind, when they are answered with the wrong shape, a secret's value, after their time or after the agent has gone, then each is refused and none is kept answered", async () => {
    await using(fresh, async (store) => {
      // given
      await store.recordTaskRequest(asked("req_c", "k1", "command"));
      await store.recordTaskRequest(asked("req_p", "k6", "permission"));
      await store.recordTaskRequest(asked("req_q", "k2", "question"));
      await store.recordTaskRequest(asked("req_s", "k3", "secret"));
      await store.recordTaskRequest({ ...asked("req_late", "k4", "question"), payload: { questions: [{ key: "q1", title: "Which branch?", choice: "text" }] } });
      await store.recordTaskRequest({ ...asked("req_gone", "k5", "mcp"), taskId: "tsk_b" });
      const answer = (id: string, a: TaskAnswer, now = "2026-11-02T10:01:00.000Z") => store.answerTaskRequest("a", id, a, "ada@example.invalid", "web", now);

      // when
      const permitted = await answer("req_p", { decision: "allow_for_task" });
      const shapes = [answer("req_c", { text: "yes" } as unknown as TaskAnswer), answer("req_c", { decision: "allow_always" } as unknown as TaskAnswer), answer("req_q", { decision: "allow_once" }), answer("req_s", { value: "hunter2" } as unknown as TaskAnswer)];
      const late = await answer("req_late", { answers: { q1: { chosen: [], other: "too late" } } }, "2026-11-02T10:10:00.000Z");
      const ended = await store.endTaskRequests("a", "tsk_b", "2026-11-02T10:02:00.000Z");
      const afterGone = await store.answerTaskRequest("a", "req_gone", { decision: "allow_once" }, "ada@example.invalid", "web", "2026-11-02T10:03:00.000Z");
      const expired = await store.expireTaskRequests("2026-11-02T10:10:00.000Z");
      const secret = await answer("req_s", { provided: true });

      // then
      for (const shape of shapes) await expect(shape).rejects.toThrow();
      expect(permitted).toMatchObject({ status: "answered", answer: { decision: "allow_for_task" } });
      expect([late, ended, afterGone, expired]).toEqual([null, 1, null, 4]);
      expect(secret).toBeNull();
      const requests = [...(await store.taskRequests("a", "tsk_a")), ...(await store.taskRequests("a", "tsk_b"))];
      expect(requests.map((r) => [r.id, r.status, r.responseCapability, r.answer])).toEqual([
        ["req_c", "expired", "live", null],
        ["req_late", "expired", "live", null],
        ["req_p", "answered", "live", { decision: "allow_for_task" }],
        ["req_q", "expired", "live", null],
        ["req_s", "expired", "live", null],
        ["req_gone", "expired", "not_resumable", null],
      ]);
    });
  });

  it("given a question with no deadline, when the clock passes, a deny carries a note, an allow carries one and the agent withdraws another, then only the deadline-free one stays open, the note is masked and the withdrawn one takes no answer", async () => {
    await using(fresh, async (store) => {
      // given
      await store.recordTaskRequest({ ...asked("req_open", "k1", "command"), expiresAt: null });
      await store.recordTaskRequest({ ...asked("req_deny", "k2", "command"), expiresAt: null });
      await store.recordTaskRequest({ ...asked("req_back", "k3", "permission"), expiresAt: null });
      const token = "ghp_" + "a".repeat(36);

      // when
      const expired = await store.expireTaskRequests("2027-01-01T00:00:00.000Z");
      const denied = await store.answerTaskRequest("a", "req_deny", { decision: "deny", note: `use the staging key, not ${token}` }, "ada@example.invalid", "web", "2027-01-01T00:00:00.000Z");
      const allowWithNote = store.answerTaskRequest("a", "req_open", { decision: "allow_once", note: "fine" }, "ada@example.invalid", "web", "2027-01-01T00:00:00.000Z");
      const longNote = store.answerTaskRequest("a", "req_open", { decision: "deny", note: "x".repeat(2001) }, "ada@example.invalid", "web", "2027-01-01T00:00:00.000Z");
      const withdrawn = await store.withdrawTaskRequest("a", "tsk_a", "k3", "2027-01-01T00:00:00.000Z");
      const twice = await store.withdrawTaskRequest("a", "tsk_a", "k3", "2027-01-01T00:00:01.000Z");
      const afterWithdrawn = await store.answerTaskRequest("a", "req_back", { decision: "allow_once" }, "ada@example.invalid", "web", "2027-01-01T00:00:02.000Z");

      // then
      expect(expired).toBe(0);
      expect(denied?.answer).toEqual({ decision: "deny", note: "[redacted:github-token]" });
      await expect(allowWithNote).rejects.toThrow(/only a deny/);
      await expect(longNote).rejects.toThrow(/at most 2000/);
      expect(withdrawn).toMatchObject({ id: "req_back", status: "withdrawn", responseCapability: "not_resumable" });
      expect([twice, afterWithdrawn]).toEqual([null, null]);
      expect((await store.taskRequests("a", "tsk_a")).map((r) => [r.id, r.status, r.expiresAt])).toEqual([
        ["req_back", "withdrawn", null],
        ["req_deny", "answered", null],
        ["req_open", "pending", null],
      ]);
    });
  });

  it("given an agent's questions of one choice, many and its own words, when they are answered in full, in part, outside their options, past their size or with a key in the words, then only the full answer in each question's own shape is kept, and the key is refused as looking secret", async () => {
    await using(fresh, async (store) => {
      // given
      const questions = [
        { key: "base", title: "Which branch?", choice: "one", options: [{ value: "main", label: "main" }, { value: "release", label: "release" }], other: true },
        { key: "checks", title: "Which checks?", choice: "many", options: [{ value: "lint", label: "Lint" }, { value: "test", label: "Tests" }] },
        { key: "why", title: "Why?", choice: "text" },
      ];
      await store.recordTaskRequest({ ...asked("req_q", "kq", "question"), payload: { questions } });
      const kept = { kind: "question" as const, payload: { questions } };
      const full = { base: { chosen: ["main"], other: null }, checks: { chosen: ["lint", "test"], other: null }, why: { chosen: [], other: "the release is frozen" } };
      const without = (key: string) => Object.fromEntries(Object.entries(full).filter(([k]) => k !== key));

      // when
      const problems = [
        answerProblem(kept, { answers: without("why") }),
        answerProblem(kept, { answers: { ...full, base: { chosen: ["main", "release"], other: null } } }),
        answerProblem(kept, { answers: { ...full, checks: { chosen: ["deploy"], other: null } } }),
        answerProblem(kept, { answers: { ...full, checks: { chosen: ["lint"], other: "and deploy" } } }),
        answerProblem(kept, { answers: { ...full, checks: { chosen: [], other: null } } }),
        answerProblem(kept, { answers: { ...full, why: { chosen: [], other: "x".repeat(4097) } } }),
      ];
      const looksSecret = answerProblem(kept, { answers: { ...full, why: { chosen: [], other: `use ghp_${"a".repeat(36)}` } } });
      const answered = await store.answerTaskRequest("a", "req_q", { answers: full }, "ada@example.invalid", "web", "2026-11-02T10:01:00.000Z");

      // then
      expect(problems.map((p) => p?.code)).toEqual(["answer-shape", "answer-shape", "answer-shape", "answer-shape", "answer-shape", "answer-shape"]);
      expect(looksSecret?.code).toBe("answer-looks-secret");
      expect(answerProblem(kept, { answers: { ...full, base: { chosen: [], other: "a hotfix branch" } } })).toBeNull();
      expect(answerProblem(kept, { decision: "deny", note: "not now" })).toBeNull();
      expect(answerProblem(kept, { decision: "allow_once" })?.code).toBe("answer-shape");
      expect(answered).toMatchObject({ status: "answered", answer: { answers: full } });
    });
  });

  it("given a question whose payload holds a token, when it is recorded, then it is refused and nothing is kept", async () => {
    await using(fresh, async (store) => {
      await expect(store.recordTaskRequest({ ...asked("req_t", "k1", "command"), payload: { command: `curl -H "Authorization: token ghp_${"a".repeat(36)}"` } })).rejects.toThrow(/never a secret/);
      expect(await store.taskRequests("a", "tsk_a")).toEqual([]);
    });
  });
});

describe.each(drivers)("the %s store's machines and the tasks they lease", (_name, fresh) => {
  const at = "2026-11-02T10:00:00.000Z";
  const later = (seconds: number) => new Date(Date.parse(at) + seconds * 1000).toISOString();
  const local = (tenant: string, id: string, createdAt: string, createdBy = "ada@example.invalid"): TaskRecord => ({ ...task(tenant, id, "queued"), startedAt: null, createdAt, createdBy, runner: "local" });
  const machine = (tenant: string, id: string, userId: string, tokenHash: string) => ({
    tenant,
    id,
    userId,
    name: `${id} laptop`,
    platform: "darwin",
    publicKey: `key-${id}`,
    agents: [],
    createdAt: at,
    lastSeenAt: null,
    revokedAt: null,
    tokenHash,
  });
  const event = (n: number, text: string) => ({ n, kind: "message" as const, text, data: { type: "message" as const, text } });
  const question = (tenant: string, taskId: string, id: string): NewTaskRequest => ({ tenant, id, taskId, targetPosition: null, sourceKey: id, kind: "command", payload: { tool: "Bash", summary: "npm test" }, createdAt: at, expiresAt: null });

  it("given tasks started with an agent's options and with its defaults, when they are read back, then the options come back as given and the defaults as none", async () => {
    await using(fresh, async (store) => {
      // given
      await store.createTask({ ...task("a", "tsk_chose", "queued"), choices: { model: "opus", effort: "high" } });
      await store.createTask({ ...task("a", "tsk_plain", "queued"), choices: {} });

      // when
      const chose = await store.getTask("a", "tsk_chose");
      const plain = await store.getTask("a", "tsk_plain");

      // then
      expect(chose?.choices).toEqual({ model: "opus", effort: "high" });
      expect(plain && "choices" in plain).toBe(false);
      expect((await store.listTasks("a")).find((t) => t.id === "tsk_chose")?.choices).toEqual({ model: "opus", effort: "high" });
    });
  });

  it("given a pairing code, when it is taken twice, after its time, and counted, then it is taken once and only while it is open", async () => {
    await using(fresh, async (store) => {
      // given
      await store.savePairing({ tenant: "a", codeHash: "h1", userId: "usr_ada", expiresAt: later(300) });
      await store.savePairing({ tenant: "a", codeHash: "h2", userId: "usr_ada", expiresAt: later(300) });

      // when
      const [first, second] = await Promise.all([store.takePairing("a", "h1", at), store.takePairing("a", "h1", at)]);
      const late = await store.takePairing("a", "h2", later(301));

      // then
      expect([first, second].filter(Boolean)).toEqual([{ userId: "usr_ada" }]);
      expect(late).toBeNull();
      expect(await store.takePairing("b", "h2", at)).toBeNull();
      expect(await store.countOpenPairings("a", "usr_ada", at)).toBe(1);
    });
  });

  it("given an organization that connects one machine, when two connect, one is revoked and tokens are looked up, then the second waits for the first's revocation and a revoked token names nobody", async () => {
    await using(fresh, async (store) => {
      // given
      expect(await store.insertMachine(machine("a", "mch_1", "usr_ada", "t1"), 1)).toBe(true);

      // when
      const full = await store.insertMachine(machine("a", "mch_2", "usr_bob", "t2"), 1);
      const revoked = await store.revokeMachine("a", "mch_1", later(1));
      const again = await store.revokeMachine("a", "mch_1", later(2));
      const kept = await store.insertMachine(machine("a", "mch_2", "usr_bob", "t2"), 1);
      await store.touchMachine("a", "mch_2", later(3), [{ id: "claude-code", installed: true, version: "2.1.0", supported: "ok", signIn: "signed-in" }]);

      // then
      expect([full, revoked, again, kept]).toEqual([false, true, false, true]);
      expect(await store.machineByToken("t1")).toBeNull();
      expect(await store.machineByToken("t2")).toMatchObject({ tenant: "a", id: "mch_2", userId: "usr_bob", lastSeenAt: later(3), agents: [{ id: "claude-code", signIn: "signed-in" }] });
      expect((await store.listMachines("a", "usr_bob")).map((m) => m.id)).toEqual(["mch_2"]);
      expect((await store.listMachines("a", null)).map((m) => [m.id, m.revokedAt])).toEqual([["mch_1", later(1)], ["mch_2", null]]);
    });
  });

  it("given a signed request's nonce, when it comes again and the round passes its time, then the repeat is refused and the expired rows go", async () => {
    await using(fresh, async (store) => {
      // given
      await store.savePairing({ tenant: "a", codeHash: "used", userId: "usr_ada", expiresAt: later(300) });
      await store.takePairing("a", "used", at);
      await store.savePairing({ tenant: "a", codeHash: "open", userId: "usr_ada", expiresAt: later(300) });

      // when
      const first = await store.takeNonce("a", "mch_1", "n1", later(300));
      const repeat = await store.takeNonce("a", "mch_1", "n1", later(300));
      const other = await store.takeNonce("a", "mch_2", "n1", later(300));
      const pruned = await store.pruneRunnerRows(later(299));

      // then
      expect([first, repeat, other]).toEqual([true, false, true]);
      expect(pruned).toBe(1);
      expect(await store.countOpenPairings("a", "usr_ada", later(299))).toBe(1);
      expect(await store.pruneRunnerRows(later(300))).toBe(3);
    });
  });

  it("given a person's oldest task in a folder of their laptop and a newer one in a repository, when their desktop and then their laptop claim, then the desktop gets the repository's task and only the laptop the folder's", async () => {
    await using(fresh, async (store) => {
      // given
      await store.upsertRepo({ tenant: "a", id: "notes", team: "Mine", name: "notes", url: "machine:mch_laptop:~/notes" });
      await store.createTask({ ...local("a", "tsk_folder", later(1)), repoId: "notes" });
      await store.createTask(local("a", "tsk_repo", later(2)));

      // when
      const desktop = await store.claimLocalTask("a", "ada@example.invalid", "mch_desktop", "lease_1", later(90), later(3));
      const again = await store.claimLocalTask("a", "ada@example.invalid", "mch_desktop", "lease_2", later(90), later(3));
      const laptop = await store.claimLocalTask("a", "ada@example.invalid", "mch_laptop", "lease_3", later(90), later(3));

      // then
      expect([desktop?.task.id, again, laptop?.task.id]).toEqual(["tsk_repo", null, "tsk_folder"]);
    });
  });

  it("given queued tasks of two people, one the orchestrator runs, and an organization limit, when a machine claims, then it gets its person's oldest local task and nothing past the limit", async () => {
    await using(fresh, async (store) => {
      // given
      await store.createTask(local("a", "tsk_new", later(2)));
      await store.createTask(local("a", "tsk_old", later(1)));
      await store.createTask(local("a", "tsk_bob", at, "bob@example.invalid"));
      await store.createTask({ ...task("a", "tsk_srv", "queued"), createdAt: at });

      // when
      const [one, two] = await Promise.all([
        store.claimLocalTask("a", "ada@example.invalid", "mch_1", "lease_1", later(90), later(3), 1),
        store.claimLocalTask("a", "ada@example.invalid", "mch_1", "lease_2", later(90), later(3), 1),
      ]);
      const unlimited = await store.claimLocalTask("a", "ada@example.invalid", "mch_1", "lease_3", later(90), later(3));

      // then
      const won = [one, two].filter(Boolean);
      expect(won).toHaveLength(1);
      expect(won[0]).toMatchObject({ task: { id: "tsk_old", status: "running", runner: "local", startedAt: later(3) }, nextEvent: 1 });
      expect(unlimited?.task.id).toBe("tsk_new");
      expect(await store.claimLocalTask("a", "ada@example.invalid", "mch_1", "lease_4", later(90), later(3))).toBeNull();
      expect((await store.getTask("a", "tsk_srv"))?.status).toBe("queued");
      expect((await store.getTask("a", "tsk_bob"))?.status).toBe("queued");
      expect(await store.taskLease("a", "tsk_srv")).toEqual({ runner: "server", claimedBy: null, leaseId: null, leaseUntil: null, nativeSession: null, branch: null, runStartedAt: null });
    });
  });

  it("given a leased task, when its holder and a stale lease write, renew and finish it, then only the held lease changes it, the cost adds up, its open question ends with it and its session with its run", async () => {
    await using(fresh, async (store) => {
      // given
      await store.createTask(local("a", "tsk_1", at));
      await store.claimLocalTask("a", "ada@example.invalid", "mch_1", "lease_1", later(90), at);
      await store.recordTaskRequest(question("a", "tsk_1", "req_1"));

      // when
      const stale = await store.updateLeasedTask("a", "tsk_1", "lease_0", { stage: "tests" });
      const progressed = await store.updateLeasedTask("a", "tsk_1", "lease_1", { stage: "working", baseSha: "b".repeat(40), branch: "task/tsk_1", nativeSession: "sess-early", addCost: { usd: 0.5, inputTokens: 100, outputTokens: null } });
      const earlySession = (await store.taskLease("a", "tsk_1"))?.nativeSession;
      await store.updateLeasedTask("a", "tsk_1", "lease_1", { addCost: { usd: 0.25, inputTokens: 50, outputTokens: 7 } });
      const renewedStale = await store.renewLease("a", "tsk_1", "lease_0", later(120), later(30));
      const renewed = await store.renewLease("a", "tsk_1", "lease_1", later(120), later(30));
      const held = await store.heldTasks("a", "mch_1", later(30));
      const finished = await store.finishLeasedTask("a", "tsk_1", "lease_1", { status: "needs-review", error: null, nativeSession: "sess-1", branch: null }, later(40));
      const afterwards = await store.renewLease("a", "tsk_1", "lease_1", later(150), later(41));

      // then
      expect([stale, progressed, renewedStale, renewed, finished, afterwards]).toEqual([false, true, false, true, true, false]);
      expect(held).toEqual([{ taskId: "tsk_1", leaseId: "lease_1", stopRequested: false }]);
      expect(earlySession).toBe("sess-early");
      expect(await store.getTask("a", "tsk_1")).toMatchObject({ status: "needs-review", finishedAt: later(40), baseSha: "b".repeat(40), cost: { usd: 0.75, inputTokens: 150, outputTokens: 7 } });
      expect(await store.taskLease("a", "tsk_1")).toEqual({ runner: "local", claimedBy: "mch_1", leaseId: null, leaseUntil: null, nativeSession: null, branch: "task/tsk_1", runStartedAt: at });
      expect(await store.heldTasks("a", "mch_1", later(41))).toEqual([]);
      expect((await store.taskRequests("a", "tsk_1")).map((r) => [r.status, r.responseCapability])).toEqual([["expired", "not_resumable"]]);
    });
  });

  it("given a task a machine runs, when a Stop is asked twice, for a queued task, and the run ends and the task is leased again, then the runner reads it until the end and the next run starts without it", async () => {
    await using(fresh, async (store) => {
      // given
      await store.createTask(local("a", "tsk_1", at));
      await store.createTask(local("a", "tsk_q", later(1)));
      await store.claimLocalTask("a", "ada@example.invalid", "mch_1", "lease_1", later(90), at);

      // when
      const asked = await store.requestStop("a", "tsk_1", later(2));
      const again = await store.requestStop("a", "tsk_1", later(3));
      const queued = await store.requestStop("a", "tsk_q", later(3));
      const whileRunning = await store.heldTasks("a", "mch_1", later(4));
      await store.updateLeasedTask("a", "tsk_1", "lease_1", { nativeSession: "sess-1" });
      await store.finishLeasedTask("a", "tsk_1", "lease_1", { status: "interrupted", error: "stopped", nativeSession: null, branch: null }, later(5));
      // Asked to stop, the run ended as its person asked: cancelled, with no session left for a Continue.
      const stoppedAs = await store.getTask("a", "tsk_1");
      const stoppedSession = (await store.taskLease("a", "tsk_1"))?.nativeSession;
      await store.updateTask("a", "tsk_1", { status: "queued" });
      await store.claimLocalTask("a", "ada@example.invalid", "mch_1", "lease_2", later(90), later(6));

      // then
      expect([asked, again, queued]).toEqual([true, true, false]);
      expect(whileRunning).toEqual([{ taskId: "tsk_1", leaseId: "lease_1", stopRequested: true }]);
      expect(stoppedAs).toMatchObject({ status: "cancelled", error: "stopped", finishedAt: later(5) });
      expect(stoppedSession).toBeNull();
      expect(await store.heldTasks("a", "mch_1", later(7))).toEqual([{ taskId: "tsk_1", leaseId: "lease_2", stopRequested: false }]);
    });
  });

  it("given a queued, a leased and an interrupted local task, when each is cancelled and a claim races a cancel, then only the unheld ones are cancelled with their questions, and of the claim and the cancel one wins", async () => {
    await using(fresh, async (store) => {
      // given
      await store.createTask(local("a", "tsk_held", at));
      await store.claimLocalTask("a", "ada@example.invalid", "mch_1", "lease_1", later(90), at);
      await store.createTask(local("a", "tsk_gone", later(1)));
      await store.claimLocalTask("a", "ada@example.invalid", "mch_1", "lease_2", later(90), later(1));
      await store.finishLeasedTask("a", "tsk_gone", "lease_2", { status: "interrupted", error: "machine slept", nativeSession: null, branch: null }, later(2));
      await store.createTask(local("a", "tsk_q", later(3)));
      await store.recordTaskRequest(question("a", "tsk_q", "req_q"));
      await store.createTask(local("a", "tsk_race", later(4)));

      // when
      const held = await store.cancelLocalTask("a", "tsk_held", later(5));
      const queued = await store.cancelLocalTask("a", "tsk_q", later(5));
      const interrupted = await store.cancelLocalTask("a", "tsk_gone", later(5));
      const [claimed, cancelled] = await Promise.all([store.claimLocalTask("a", "ada@example.invalid", "mch_1", "lease_3", later(90), later(6)), store.cancelLocalTask("a", "tsk_race", later(6))]);

      // then
      expect([held, queued, interrupted]).toEqual([false, true, true]);
      expect((await store.getTask("a", "tsk_held"))?.status).toBe("running");
      expect(await store.getTask("a", "tsk_q")).toMatchObject({ status: "cancelled", finishedAt: later(5) });
      expect((await store.taskRequests("a", "tsk_q")).map((r) => r.status)).toEqual(["expired"]);
      expect((await store.getTask("a", "tsk_gone"))?.status).toBe("cancelled");
      expect(Number(Boolean(claimed)) + Number(cancelled)).toBe(1);
    });
  });

  it("given a session recorded before the agent started, when a restart ends the task interrupted without one, then the recorded session stays for Continue", async () => {
    await using(fresh, async (store) => {
      // given
      await store.createTask(local("a", "tsk_1", at));
      await store.claimLocalTask("a", "ada@example.invalid", "mch_1", "lease_1", later(90), at);
      await store.updateLeasedTask("a", "tsk_1", "lease_1", { nativeSession: "sess-early" });

      // when
      const ended = await store.finishLeasedTask("a", "tsk_1", "lease_1", { status: "interrupted", error: "restarted", nativeSession: null, branch: null }, later(5));

      // then
      expect(ended).toBe(true);
      expect(await store.taskLease("a", "tsk_1")).toMatchObject({ claimedBy: "mch_1", leaseId: null, nativeSession: "sess-early" });
      expect(await store.getTask("a", "tsk_1")).toMatchObject({ status: "interrupted", finishedAt: null });
    });
  });

  it("given runs on a machine that end for review, fail and are cut off, when each ends, then only the one for review reads as still opening its request", async () => {
    await using(fresh, async (store) => {
      // given
      for (const [i, id] of ["tsk_rev", "tsk_fail", "tsk_cut"].entries()) {
        await store.createTask(local("a", id, later(i)));
        await store.claimLocalTask("a", "ada@example.invalid", "mch_1", `lease_${id}`, later(90), later(i));
      }

      // when
      await store.finishLeasedTask("a", "tsk_rev", "lease_tsk_rev", { status: "needs-review", error: null, nativeSession: null, branch: "task/rev" }, later(10));
      await store.finishLeasedTask("a", "tsk_fail", "lease_tsk_fail", { status: "failed", error: "it failed", nativeSession: null, branch: null }, later(10));
      await store.finishLeasedTask("a", "tsk_cut", "lease_tsk_cut", { status: "interrupted", error: "cut off", nativeSession: null, branch: null }, later(10));

      // then
      expect([(await store.getTask("a", "tsk_rev"))!.stage, (await store.getTask("a", "tsk_fail"))!.stage ?? null, (await store.getTask("a", "tsk_cut"))!.stage ?? null]).toEqual(["request", null, null]);
    });
  });

  it("given a task that runs twice on a machine, when each run ends with the time its agent worked, then the task keeps their sum", async () => {
    await using(fresh, async (store) => {
      // given
      await store.createTask(local("a", "tsk_twice", at));
      await store.claimLocalTask("a", "ada@example.invalid", "mch_1", "lease_1", later(90), at);
      await store.finishLeasedTask("a", "tsk_twice", "lease_1", { status: "interrupted", error: "The machine stopped.", nativeSession: "sess", branch: null, ranMs: 60_000 }, later(60));
      await store.continueLocalTask("a", "tsk_twice", null, later(70));
      await store.claimLocalTask("a", "ada@example.invalid", "mch_1", "lease_2", later(200), later(80));

      // when
      await store.finishLeasedTask("a", "tsk_twice", "lease_2", { status: "needs-review", error: null, nativeSession: null, branch: null, ranMs: 90_000 }, later(170));

      // then
      expect((await store.getTask("a", "tsk_twice"))!.ranMs).toBe(150_000);
      expect(await store.taskLease("a", "tsk_twice")).toMatchObject({ runStartedAt: later(80) });
    });
  });

  it("given machine runs whose agent estimated its turn, when one is cut off, one is stopped after a change, one's turn reports its cost and one ends for review on its own, then only the cut-off and the stopped ones add the estimate", async () => {
    await using(fresh, async (store) => {
      // given
      const ids = ["tsk_cut", "tsk_stop", "tsk_said", "tsk_done"];
      for (const [i, id] of ids.entries()) {
        await store.createTask(local("a", id, later(i)));
        await store.claimLocalTask("a", "ada@example.invalid", "mch_1", `lease_${id}`, later(90), later(i));
        await store.updateLeasedTask("a", id, `lease_${id}`, { addCost: { usd: 0.1, inputTokens: null, outputTokens: null } });
        await store.updateLeasedTask("a", id, `lease_${id}`, { turnEstimate: 0.04 });
      }
      await store.updateLeasedTask("a", "tsk_said", "lease_tsk_said", { addCost: { usd: 0.05, inputTokens: null, outputTokens: null } });
      await store.requestStop("a", "tsk_stop", later(10));

      // when
      await store.finishLeasedTask("a", "tsk_cut", "lease_tsk_cut", { status: "interrupted", error: "The machine stopped.", nativeSession: null, branch: null }, later(20));
      await store.finishLeasedTask("a", "tsk_stop", "lease_tsk_stop", { status: "needs-review", error: null, nativeSession: null, branch: null }, later(20));
      await store.finishLeasedTask("a", "tsk_said", "lease_tsk_said", { status: "failed", error: "The agent failed.", nativeSession: null, branch: null }, later(20));
      await store.finishLeasedTask("a", "tsk_done", "lease_tsk_done", { status: "needs-review", error: null, nativeSession: null, branch: null }, later(20));

      // then
      const usd = async (id: string) => Number((await store.getTask("a", id))!.cost.usd!.toFixed(4));
      expect([await usd("tsk_cut"), await usd("tsk_stop"), await usd("tsk_said"), await usd("tsk_done")]).toEqual([0.14, 0.14, 0.15, 0.1]);
    });
  });

  it("given runs on a machine cut off at a usage limit, stopped by their person and ended for review, when each ends, then only the cut-off one waits for its reset, which goes on once, counted, and marks one run as going on after it", async () => {
    await using(fresh, async (store) => {
      // given
      const resetAt = later(3_600);
      for (const [id, lease] of [["tsk_limit", "lease_1"], ["tsk_stop", "lease_2"], ["tsk_done", "lease_3"]] as const) {
        await store.createTask(local("a", id, at));
        await store.claimLocalTask("a", "ada@example.invalid", "mch_1", lease, later(90), at);
      }
      await store.requestStop("a", "tsk_stop", later(1));

      // when
      await store.finishLeasedTask("a", "tsk_limit", "lease_1", { status: "interrupted", error: "Claude Code reached its usage limit.", nativeSession: "sess-1", branch: null, limitResetAt: resetAt }, later(5));
      await store.finishLeasedTask("a", "tsk_stop", "lease_2", { status: "interrupted", error: null, nativeSession: null, branch: null, limitResetAt: resetAt }, later(5));
      await store.finishLeasedTask("a", "tsk_done", "lease_3", { status: "needs-review", error: null, nativeSession: null, branch: null, limitResetAt: resetAt }, later(5));
      const before = await store.limitedTasks("a", later(3_599));
      const due = await store.limitedTasks("a", later(3_660));
      const wrongReset = await store.continueAfterLimit("a", "tsk_limit", later(10));
      const first = await store.continueAfterLimit("a", "tsk_limit", resetAt);
      const again = await store.continueAfterLimit("a", "tsk_limit", resetAt);
      const took = [await store.takeLimitContinue("a", "tsk_limit"), await store.takeLimitContinue("a", "tsk_limit")];

      // then
      expect(before).toEqual([]);
      expect(due).toEqual([{ taskId: "tsk_limit", resetAt, limitAt: later(5), goneOn: 0 }]);
      expect((await store.getTask("a", "tsk_stop"))!.limitResetAt).toBeUndefined();
      expect((await store.getTask("a", "tsk_done"))!.limitResetAt).toBeUndefined();
      expect([wrongReset, first, again, took]).toEqual([false, true, false, [true, false]]);
      expect(await store.getTask("a", "tsk_limit")).toMatchObject({ status: "queued", error: null });
      expect((await store.getTask("a", "tsk_limit"))!.limitResetAt).toBeUndefined();
      expect(await store.taskLease("a", "tsk_limit")).toMatchObject({ claimedBy: "mch_1", nativeSession: "sess-1" });
    });
  });

  it("given two tasks waiting for a usage limit's reset, when one is let go of and its person continues the other, then neither waits for it any more and a later one goes on with its count kept", async () => {
    await using(fresh, async (store) => {
      // given
      const resetAt = later(3_600);
      for (const [id, lease] of [["tsk_drop", "lease_1"], ["tsk_go", "lease_2"]] as const) {
        await store.createTask(local("a", id, at));
        await store.claimLocalTask("a", "ada@example.invalid", "mch_1", lease, later(90), at);
        await store.finishLeasedTask("a", id, lease, { status: "interrupted", error: "limit", nativeSession: "sess", branch: null, limitResetAt: resetAt }, later(5));
      }
      await store.continueAfterLimit("a", "tsk_go", resetAt);
      await store.claimLocalTask("a", "ada@example.invalid", "mch_1", "lease_3", later(4_000), later(3_700));
      await store.finishLeasedTask("a", "tsk_go", "lease_3", { status: "interrupted", error: "limit", nativeSession: "sess", branch: null, limitResetAt: later(7_200) }, later(3_800));

      // when
      const dropped = [await store.dropLimit("a", "tsk_drop", later(10)), await store.dropLimit("a", "tsk_drop", resetAt)];
      const continued = await store.continueLocalTask("a", "tsk_go", null, later(3_900));

      // then
      expect(dropped).toEqual([false, true]);
      expect(continued).toBe(true);
      expect(await store.limitedTasks("a", later(90_000))).toEqual([]);
      expect((await store.getTask("a", "tsk_drop"))!.status).toBe("interrupted");
      await store.claimLocalTask("a", "ada@example.invalid", "mch_1", "lease_4", later(4_100), later(4_000));
      await store.finishLeasedTask("a", "tsk_go", "lease_4", { status: "interrupted", error: "limit", nativeSession: "sess", branch: null, limitResetAt: later(9_000) }, later(4_050));
      expect(await store.limitedTasks("a", later(90_000))).toEqual([{ taskId: "tsk_go", resetAt: later(9_000), limitAt: later(4_050), goneOn: 1 }]);
    });
  });

  it("given a local task and an orchestrator task past their leases, when leases expire and a restart interrupts the organization, then the local one waits interrupted on its machine with its questions ended, the other fails, and the restart leaves the local one alone", async () => {
    await using(fresh, async (store) => {
      // given
      await store.createTask(local("a", "tsk_gone", at));
      await store.claimLocalTask("a", "ada@example.invalid", "mch_1", "lease_1", later(90), at);
      await store.createTask(local("a", "tsk_live", later(1)));
      await store.claimLocalTask("a", "ada@example.invalid", "mch_1", "lease_2", later(200), later(1));
      await store.createTask({ ...task("a", "tsk_srv", "queued"), createdAt: later(2) });
      await store.updateLeasedTask("a", "tsk_gone", "lease_1", { stage: "working" });
      await store.recordTaskRequest(question("a", "tsk_gone", "req_gone"));
      await store.recordTaskRequest(question("a", "tsk_live", "req_live"));

      // when
      const expired = await store.expireLeases(later(91));
      const restarted = await store.interruptTasks("a", "restarted");
      const unfinished = await store.unfinishedTasks("a", "server");
      const everyRunner = await store.unfinishedTasks("a");

      // then
      expect(expired).toEqual({ interrupted: 1, failed: 0 });
      expect(await store.getTask("a", "tsk_gone")).toMatchObject({ status: "interrupted", finishedAt: null });
      expect((await store.getTask("a", "tsk_gone"))?.stage).toBeUndefined();
      expect((await store.taskRequests("a", "tsk_gone")).map((r) => [r.status, r.responseCapability])).toEqual([["expired", "not_resumable"]]);
      expect(await store.answerTaskRequest("a", "req_gone", { decision: "allow_once" }, "ada@example.invalid", "web", later(92))).toBeNull();
      expect((await store.taskRequests("a", "tsk_live")).map((r) => r.status)).toEqual(["pending"]);
      expect(await store.taskLease("a", "tsk_gone")).toMatchObject({ claimedBy: "mch_1", leaseId: null });
      expect(await store.renewLease("a", "tsk_gone", "lease_1", later(200), later(92))).toBe(false);
      expect(restarted).toBe(1);
      expect(unfinished).toEqual([]);
      expect(everyRunner.map((t) => t.id)).toEqual(["tsk_live"]);
      expect((await store.getTask("a", "tsk_live"))?.status).toBe("running");
      expect((await store.getTask("a", "tsk_srv"))?.status).toBe("failed");
    });
  });

  it("given a leased task, when its runner sends events, resends a batch, sends under a stale lease and sends a secret, then each number is written once in order and an event carrying the secret is withheld", async () => {
    await using(fresh, async (store) => {
      // given
      await store.createTask(local("a", "tsk_1", at));
      await store.claimLocalTask("a", "ada@example.invalid", "mch_1", "lease_1", later(90), at);
      await store.appendTaskLog("a", "tsk_1", ["prepared"]);
      const token = "ghp_" + "a".repeat(36);

      // when
      const first = await store.appendRunnerEvents("a", "tsk_1", "lease_1", [event(1, "reading"), event(2, "writing")]);
      const resent = await store.appendRunnerEvents("a", "tsk_1", "lease_1", [event(2, "writing"), event(3, "done"), event(3, "done")]);
      const stale = await store.appendRunnerEvents("a", "tsk_1", "lease_0", [event(4, "late")]);
      await store.appendRunnerEvents("a", "tsk_1", "lease_1", [event(4, `pushed with ${token}`), { n: 5, kind: "output", text: "plain", data: { type: "output", text: token } }]);

      // then
      expect([first, resent, stale]).toEqual([true, true, false]);
      const log = await store.taskLog("a", "tsk_1", 0);
      expect(log.map((l) => [l.seq, l.text, l.kind])).toEqual([
        [1, "prepared", undefined],
        [2, "reading", "message"],
        [3, "writing", "message"],
        [4, "done", "message"],
        [5, "[redacted:github-token] the event was withheld", "message"],
        [6, "[redacted:github-token] the event was withheld", "output"],
      ]);
      expect(log[1]?.data).toEqual({ type: "message", text: "reading" });
      expect(log[4]?.data).toBeUndefined();
      expect(log[5]?.data).toBeUndefined();
    });
  });

  it("given a machine disconnected while its poll waited, when that poll claims, then it is given nothing and the task waits for a connected machine", async () => {
    await using(fresh, async (store) => {
      // given
      await store.insertMachine(machine("a", "mch_1", "usr_ada", "t1"), null);
      await store.createTask(local("a", "tsk_1", at));
      await store.revokeMachine("a", "mch_1", later(1));

      // when
      const claimed = await store.claimLocalTask("a", "ada@example.invalid", "mch_1", "lease_1", later(90), later(2));

      // then
      expect(claimed).toBeNull();
      expect((await store.getTask("a", "tsk_1"))?.status).toBe("queued");
    });
  });

  it("given a machine holding a task with a question open, when the machine is revoked, then the task is interrupted in the same write, its lease is gone and its question ended", async () => {
    await using(fresh, async (store) => {
      // given
      await store.insertMachine(machine("a", "mch_1", "usr_ada", "t1"), null);
      await store.createTask(local("a", "tsk_1", at));
      await store.claimLocalTask("a", "ada@example.invalid", "mch_1", "lease_1", later(90), at);
      await store.recordTaskRequest(question("a", "tsk_1", "req_1"));

      // when
      await store.revokeMachine("a", "mch_1", later(5));

      // then
      expect(await store.getTask("a", "tsk_1")).toMatchObject({ status: "interrupted", error: "The machine running this task was disconnected." });
      expect(await store.updateLeasedTask("a", "tsk_1", "lease_1", { stage: "tests" })).toBe(false);
      expect((await store.taskRequests("a", "tsk_1")).map((r) => [r.status, r.responseCapability])).toEqual([["expired", "not_resumable"]]);
    });
  });
});

describe.each(drivers)("the %s store's tasks in a folder without git", (_name, fresh) => {
  const at = "2026-11-03T12:00:00.000Z";
  const file = (path: string) => ({ path, status: "modified" as const, previousPath: null, additions: 1, deletions: 0, binary: false, test: false });

  it("given a task's changes kept with their snapshots, when the task is read and undone twice, then its page sees the files and the undo but never the snapshots, and the second undo is refused", async () => {
    await using(fresh, async (store) => {
      // given
      await store.createTask(task("a", "tsk_1", "needs-review"));
      await store.setTaskChanges("a", "tsk_1", { before: "b".repeat(40), after: "c".repeat(40), files: [file("todo.md")], undone: null });

      // when
      const read = await store.getTask("a", "tsk_1");
      const snapshots = await store.taskChangeSnapshots("a", "tsk_1");
      const [first, second] = await Promise.all([1, 2].map((n) => store.markTaskChangesUndone("a", "tsk_1", { at, by: `p${n}@example.invalid`, kept: [] })));

      // then
      expect(read).toMatchObject({ result: "changes", changes: { files: [file("todo.md")], undone: null } });
      expect(JSON.stringify(read)).not.toContain("b".repeat(40));
      expect(snapshots).toEqual({ before: "b".repeat(40), after: "c".repeat(40) });
      expect([first, second].sort()).toEqual([false, true]);
      expect((await store.getTask("a", "tsk_1"))?.changes?.undone).toMatchObject({ at, kept: [] });
      expect(await store.taskChangeSnapshots("a", "tsk_none")).toBeNull();
    });
  });

  it("given a task shared with two members and one not, when it is shared again, read, listed by who sees it, unshared and a member is deleted, then each share is kept once, the task names who it is shared with, a share lets that member find it, and a deleted member's share goes with them", async () => {
    await using(fresh, async (store) => {
      // given
      await store.createTask(task("a", "tsk_shared", "needs-review"));
      await store.createTask(task("a", "tsk_alone", "needs-review"));
      const bo = user("a", "bo@example.invalid", { role: "member" });
      await store.insertMember(bo, 10);
      const share = (userId: string, at: string) => store.addTaskShare({ tenant: "a", taskId: "tsk_shared", userId, sharedBy: "ada@example.invalid", at });

      // when
      const [first, second, again] = [await share("usr_lee", "2026-11-03T10:00:00.000Z"), await share(bo.id, "2026-11-03T10:01:00.000Z"), await share("usr_lee", "2026-11-03T10:02:00.000Z")];
      const read = await store.getTask("a", "tsk_shared");
      const leeSees = (await store.taskPage("a", { visibleTo: { teams: [], creators: ["lee@example.invalid"], sharedWith: "usr_lee" } }, null, 10)).tasks.map((t) => t.id);
      const nobody = (await store.taskPage("a", { visibleTo: { teams: [], creators: ["lee@example.invalid"] } }, null, 10)).tasks.map((t) => t.id);
      const removed = [await store.removeTaskShare("a", "tsk_shared", "usr_lee"), await store.removeTaskShare("a", "tsk_shared", "usr_lee")];
      await store.deleteUser("a", bo.id);

      // then
      expect([first, second, again]).toEqual([true, true, false]);
      expect(read?.sharedWith).toEqual(["usr_lee", bo.id]);
      expect([leeSees, nobody]).toEqual([["tsk_shared"], []]);
      expect(removed).toEqual([true, false]);
      expect(await store.listTaskShares("a", "tsk_shared")).toEqual([]);
      expect((await store.getTask("a", "tsk_alone"))?.sharedWith).toBeUndefined();
    });
  });

  it("given a task started with a pick of its project's skills and MCP servers and one with none, when they are read, then the first keeps its pick and the second carries no field", async () => {
    await using(fresh, async (store) => {
      // given
      const tools = { skills: [{ source: "ssr_1", name: "handover", head: "a".repeat(40) }], mcpServers: ["mcp_1"] };
      await store.createTask({ ...task("a", "tsk_tools", "queued"), tools });
      await store.createTask(task("a", "tsk_plain", "queued"));

      // when
      const [picked, plain] = [await store.getTask("a", "tsk_tools"), await store.getTask("a", "tsk_plain")];

      // then
      expect(picked?.tools).toEqual(tools);
      expect(plain && "tools" in plain).toBe(false);
    });
  });

  it("given a task's change in a folder, when it is kept and undone at once, kept twice, and another task's is undone and then kept, then each is settled once, kept or undone and never both", async () => {
    await using(fresh, async (store) => {
      // given
      for (const id of ["tsk_1", "tsk_2"]) {
        await store.createTask(task("a", id, "needs-review"));
        await store.setTaskChanges("a", id, { before: "b".repeat(40), after: "c".repeat(40), files: [file("todo.md")], undone: null });
      }

      // when
      const [kept, undone] = await Promise.all([store.markTaskChangesKept("a", "tsk_1", { at, by: "ada@example.invalid" }), store.markTaskChangesUndone("a", "tsk_1", { at, by: "ada@example.invalid", kept: [] })]);
      const keptAgain = await store.markTaskChangesKept("a", "tsk_1", { at, by: "ada@example.invalid" });
      const otherUndone = await store.markTaskChangesUndone("a", "tsk_2", { at, by: "ada@example.invalid", kept: [] });
      const otherKept = await store.markTaskChangesKept("a", "tsk_2", { at, by: "ada@example.invalid" });
      const none = await store.markTaskChangesKept("a", "tsk_none", { at, by: "ada@example.invalid" });

      // then
      expect([kept, undone].sort()).toEqual([false, true]);
      const first = (await store.getTask("a", "tsk_1"))!.changes!;
      expect(Boolean(first.kept) !== Boolean(first.undone)).toBe(true);
      expect([keptAgain, otherUndone, otherKept, none]).toEqual([false, true, false, false]);
      expect((await store.getTask("a", "tsk_2"))!.changes).toMatchObject({ undone: { at }, files: [file("todo.md")] });
      expect((await store.getTask("a", "tsk_2"))!.changes!.kept).toBeUndefined();
    });
  });

  it("given two tasks for one folder, when both take it, the holder takes it again, the holder's lock is let go by another, and a start lets go of locks held by tasks that ended, then one holds it at a time, its holder takes it again, and only its own task lets it go", async () => {
    await using(fresh, async (store) => {
      // given
      await store.createTask(task("a", "tsk_1", "running"));
      await store.createTask(task("a", "tsk_2", "queued"));

      // when
      const [one, two] = await Promise.all([store.takeProjectLock("a", "notes", "tsk_1", at), store.takeProjectLock("a", "notes", "tsk_2", at)]);
      const holder = one ? "tsk_1" : "tsk_2";
      const takenAgain = await store.takeProjectLock("a", "notes", holder, at);
      await store.releaseProjectLock("a", "notes", holder === "tsk_1" ? "tsk_2" : "tsk_1");
      const stillHeld = await store.takeProjectLock("a", "notes", "tsk_3", at);
      await store.updateTask("a", holder, { status: "failed" });
      const released = await store.releaseStaleProjectLocks("a");
      const free = await store.takeProjectLock("a", "notes", "tsk_3", at);

      // then
      expect([one, two].sort()).toEqual([false, true]);
      expect(takenAgain).toBe(true);
      expect([stillHeld, released, free]).toEqual([false, 1, true]);
    });
  });
});

describe.each(drivers)("the %s store's follow-ups for a running task", (_name, fresh) => {
  const at = "2026-11-03T10:00:00.000Z";
  const followUp = (id: string, key: string, text = "also update the changelog"): NewFollowUp => ({ tenant: "a", id, taskId: "tsk_1", source: "person", key, text, quotes: null, createdAt: at, createdBy: "ada@example.invalid" });

  it("given a person's follow-up waiting, one delivered and a watch's, when each is changed and taken back, then only the waiting person's changes, keeping its quotes when none are given, and is taken back once, and words that look like a secret are refused", async () => {
    await using(fresh, async (store) => {
      // given
      const waiting = (await store.addFollowUp(followUp("fup_w", "w"))).followUp.id;
      const reached = (await store.addFollowUp(followUp("fup_r", "r"))).followUp.id;
      const watched = (await store.addFollowUp({ ...followUp("fup_x", "x"), source: "watch" })).followUp.id;
      await store.markFollowUpsDelivered("a", [reached], at);

      // when
      const edits = [
        await store.editFollowUp("a", "tsk_1", waiting, "also update the readme", [{ path: "README.md", lines: "1-2", text: "old" }]),
        await store.editFollowUp("a", "tsk_1", reached, "too late", null),
        await store.editFollowUp("a", "tsk_1", watched, "not a person's", null),
        await store.editFollowUp("b", "tsk_1", waiting, "another organization", null),
      ];
      const wordsOnly = await store.editFollowUp("a", "tsk_1", waiting, "also update the readme and the index");
      const secret = store.editFollowUp("a", "tsk_1", waiting, "use ghp_0123456789abcdefghijklmnopqrstuvwxyzAB", null);
      const drops = [await store.dropFollowUp("a", "tsk_1", waiting), await store.dropFollowUp("a", "tsk_1", waiting), await store.dropFollowUp("a", "tsk_1", watched)];

      // then
      expect([...edits, wordsOnly]).toEqual([true, false, false, false, true]);
      await expect(secret).rejects.toThrow(/looks like a/);
      expect(drops).toEqual([true, false, false]);
      expect((await store.taskFollowUps("a", "tsk_1")).map((f) => [f.id, f.status, f.text, f.quotes])).toEqual([
        ["fup_r", "delivered", "also update the changelog", null],
        ["fup_w", "dismissed", "also update the readme and the index", [{ path: "README.md", lines: "1-2", text: "old" }]],
        ["fup_x", "pending", "also update the changelog", null],
      ]);
    });
  });

  it("given a follow-up written twice by two nodes, one with quotes, and the task ending, when they are delivered and closed, then each key is kept once, delivered once, what was left pending is closed, and the delivered ones are counted per task by source", async () => {
    await using(fresh, async (store) => {
      // given
      const [first, second] = await Promise.all([store.addFollowUp(followUp("fup_1", "k1")), store.addFollowUp(followUp("fup_2", "k1", "a copy"))]);
      const quoted = await store.addFollowUp({ ...followUp("fup_3", "k2", "this line is wrong"), source: "watch", quotes: [{ path: "skills/a/SKILL.md", lines: "3-4", text: "old wording" }] });
      await store.addFollowUp(followUp("fup_4", "k3"));

      // when
      const pending = await store.pendingFollowUps("a", "tsk_1");
      const delivered = await store.markFollowUpsDelivered("a", [first.followUp.id, quoted.followUp.id], "2026-11-03T10:01:00.000Z");
      const again = await store.markFollowUpsDelivered("a", [first.followUp.id], "2026-11-03T10:02:00.000Z");
      const closed = await store.closeFollowUps("a", "tsk_1", "2026-11-03T10:03:00.000Z");
      const rounds = await store.deliveredFollowUpCounts("a", ["tsk_1", "tsk_2"], ["person", "watch"]);
      const byPerson = await store.deliveredFollowUpCounts("a", ["tsk_1"], ["person"]);

      // then
      expect([first.created, second.created].sort()).toEqual([false, true]);
      expect(first.followUp.id).toBe(second.followUp.id);
      expect(pending.map((f) => f.key)).toEqual(["k1", "k2", "k3"]);
      expect(pending[1]).toMatchObject({ source: "watch", quotes: [{ path: "skills/a/SKILL.md", lines: "3-4", text: "old wording" }], status: "pending" });
      expect([delivered, again, closed]).toEqual([2, 0, 1]);
      expect([...rounds]).toEqual([["tsk_1", 2]]);
      expect([...byPerson]).toEqual([["tsk_1", 1]]);
      expect(await store.pendingFollowUps("a", "tsk_1")).toEqual([]);
      expect(await store.pendingFollowUps("b", "tsk_1")).toEqual([]);
      expect((await store.taskFollowUps("a", "tsk_1")).map((f) => [f.key, f.status])).toEqual([["k1", "delivered"], ["k2", "delivered"], ["k3", "closed"]]);
      expect(await store.taskFollowUps("b", "tsk_1")).toEqual([]);
    });
  });

  it("given a follow-up whose text or quote holds a token, when it is added, then it is refused and nothing is kept", async () => {
    await using(fresh, async (store) => {
      const token = "ghp_" + "a".repeat(36);
      await expect(store.addFollowUp(followUp("fup_t", "k1", `use ${token}`))).rejects.toThrow(/never with a secret/);
      await expect(store.addFollowUp({ ...followUp("fup_q", "k2"), quotes: [{ path: ".env", lines: "1", text: token }] })).rejects.toThrow(/never with a secret/);
      expect(await store.pendingFollowUps("a", "tsk_1")).toEqual([]);
    });
  });
});

describe.each(drivers)("the %s store's cloud identities", (_name, fresh) => {
  const at = "2026-11-02T10:00:00.000Z";
  const identity = (id: string, email: string): IdentityRecord => ({ id, email, name: email, emailVerifiedAt: at, termsUrl: null, termsAcceptedAt: null, createdAt: at });
  const login = (identityId: string, provider: SocialProvider, subject: string): IdentityLogin => ({ provider, subject, identityId, email: `${subject}@example.invalid`, addedAt: at });
  const org = (tenant: string, createdBy: string, createdAt = at): OrgRecord => ({ tenant, name: tenant, createdBy, createdAt, quotas: { members: null, tasksPerMonth: null, concurrentTasks: null }, deletedAt: null });

  it("given an identity, when another is saved with its address in other letters or with its login, then neither is saved, and the first is found by address and by login", async () => {
    await using(fresh, async (store) => {
      // given
      expect(await store.insertIdentity(identity("idn_a", "Ada@Example.invalid"), login("idn_a", "google", "g-1"))).toBe(true);

      // when
      const sameAddress = await store.insertIdentity(identity("idn_b", "ada@example.INVALID"), login("idn_b", "github", "h-1"));
      const sameLogin = await store.insertIdentity(identity("idn_c", "other@example.invalid"), login("idn_c", "google", "g-1"));

      // then
      expect([sameAddress, sameLogin]).toEqual([false, false]);
      expect(await store.getIdentity("idn_b")).toBeNull();
      expect(await store.getIdentity("idn_c")).toBeNull();
      expect((await store.getIdentityByLogin("github", "h-1"))).toBeNull();
      expect((await store.getIdentityByEmail("ADA@example.invalid"))?.id).toBe("idn_a");
      expect(await store.getIdentityByLogin("google", "g-1")).toEqual({ ...identity("idn_a", "Ada@Example.invalid"), email: "ada@example.invalid" });
    });
  });

  it("given an identity with two logins, when one is removed, then the last is kept, a login of another identity is neither added nor removed, and two removals at once leave one", async () => {
    await using(fresh, async (store) => {
      // given
      await store.insertIdentity(identity("idn_a", "a@example.invalid"), login("idn_a", "google", "g-1"));
      await store.insertIdentity(identity("idn_b", "b@example.invalid"), login("idn_b", "github", "h-1"));
      expect(await store.addLogin(login("idn_a", "github", "h-2"))).toBe(true);

      // when
      const taken = await store.addLogin(login("idn_a", "github", "h-1"));
      const others = await store.removeLogin("idn_a", "github", "h-1");
      const second = await store.removeLogin("idn_a", "github", "h-2");
      const last = await store.removeLogin("idn_a", "google", "g-1");

      // then
      expect([taken, others, second, last]).toEqual([false, false, true, false]);
      expect((await store.listLogins("idn_a")).map((l) => [l.provider, l.subject])).toEqual([["google", "g-1"]]);
      expect((await store.listLogins("idn_b")).map((l) => l.identityId)).toEqual(["idn_b"]);

      // when two are removed at once
      await store.addLogin(login("idn_a", "microsoft", "m-1"));
      const both = await Promise.all([store.removeLogin("idn_a", "google", "g-1"), store.removeLogin("idn_a", "microsoft", "m-1")]);

      // then
      expect(both.filter(Boolean)).toHaveLength(1);
      expect(await store.listLogins("idn_a")).toHaveLength(1);
    });
  });

  it("given a session and two pending sign-ins, when they are read, taken and the clock passes them, then a pending one is taken once, an expired one never, and purging clears what ended", async () => {
    await using(fresh, async (store) => {
      // given
      const session: IdentitySessionRecord = { tokenHash: "h1", identityId: "idn_a", csrf: "c1", method: "google", domain: "example.invalid", authenticatedAt: at, expiresAt: "2026-11-02T22:00:00.000Z" };
      await store.saveIdentitySession(session);
      await store.saveIdentitySession({ ...session, tokenHash: "h2", expiresAt: "2026-11-02T10:30:00.000Z" });
      const pending = (state: string, expiresAt: string): PendingSignIn => ({ state, provider: "github", purpose: "link", nonce: "n", verifier: "v", identityId: "idn_a", inviteId: null, account: null, expiresAt });
      await store.savePendingSignIn(pending("s1", "2026-11-02T10:10:00.000Z"));
      await store.savePendingSignIn(pending("s2", "2026-11-02T10:10:00.000Z"));

      // when
      const first = await store.takePendingSignIn("s1", "2026-11-02T10:05:00.000Z");
      const again = await store.takePendingSignIn("s1", "2026-11-02T10:05:00.000Z");
      const late = await store.takePendingSignIn("s2", "2026-11-02T10:11:00.000Z");
      await store.purgeExpired("2026-11-02T11:00:00.000Z");

      // then
      expect(first).toEqual(pending("s1", "2026-11-02T10:10:00.000Z"));
      expect([again, late]).toEqual([null, null]);
      expect(await store.takePendingSignIn("s2", "2026-11-02T10:05:00.000Z")).toBeNull();
      expect(await store.getIdentitySession("h1")).toEqual(session);
      expect(await store.getIdentitySession("h2")).toBeNull();
      await store.deleteIdentitySession("h1");
      expect(await store.getIdentitySession("h1")).toBeNull();
    });
  });

  it("given a pending link that waits for the person to confirm another email's account, when it is taken, then the account comes back with it, and a pending sign-in saved without one reads as none", async () => {
    await using(fresh, async (store) => {
      // given
      const account = { subject: "4711", email: "ada@other.invalid", name: "Ada" };
      await store.savePendingSignIn({ state: "s1", provider: "github", purpose: "link", nonce: "n", verifier: "v", identityId: "idn_a", inviteId: null, account, expiresAt: "2026-11-02T10:10:00.000Z" });
      await store.savePendingSignIn({ state: "s2", provider: "google", purpose: "sign-in", nonce: "n", verifier: "v", identityId: null, inviteId: null, expiresAt: "2026-11-02T10:10:00.000Z" });

      // when
      const confirming = await store.takePendingSignIn("s1", "2026-11-02T10:05:00.000Z");
      const plain = await store.takePendingSignIn("s2", "2026-11-02T10:05:00.000Z");

      // then
      expect(confirming?.account).toEqual(account);
      expect(plain?.account).toBeNull();
    });
  });

  it("given one pending sign-in, when two callbacks take its state at once, then exactly one of them gets it", async () => {
    await using(fresh, async (store) => {
      // given
      await store.savePendingSignIn({ state: "s1", provider: "google", purpose: "sign-in", nonce: "n", verifier: "v", identityId: null, inviteId: null, expiresAt: "2026-11-02T10:10:00.000Z" });

      // when
      const taken = await Promise.all([store.takePendingSignIn("s1", "2026-11-02T10:05:00.000Z"), store.takePendingSignIn("s1", "2026-11-02T10:05:00.000Z")]);

      // then
      expect(taken.filter((t) => t !== null)).toHaveLength(1);
    });
  });

  it("given an identity that is a member of two organizations, when its memberships are read and one organization ends its sessions, then each account comes back, only that one is stamped, and a second account of it in one organization is refused", async () => {
    await using(fresh, async (store) => {
      // given
      await store.insertIdentity(identity("idn_a", "a@example.invalid"), login("idn_a", "google", "g-1"));
      const inAcme = user("acme", "a@example.invalid", { identityId: "idn_a", role: "owner" });
      const inGlobex = user("globex", "a@example.invalid", { identityId: "idn_a" });
      await store.insertUser(inAcme);
      await store.insertUser(inGlobex);
      await store.insertUser(user("acme", "b@example.invalid"));
      await store.insertUser(user("acme", "c@example.invalid"));

      // when
      await store.deleteSessions("globex", inGlobex.id);

      // then
      expect((await store.listMemberships("idn_a")).map((u) => [u.tenant, u.id, u.role])).toEqual([["acme", inAcme.id, "owner"], ["globex", inGlobex.id, "member"]]);
      expect((await store.getUserByIdentity("acme", "idn_a"))?.sessionsRevokedAt).toBeNull();
      expect((await store.getUserByIdentity("globex", "idn_a"))?.sessionsRevokedAt).toEqual(expect.any(String));
      expect(await store.getUserByIdentity("initech", "idn_a")).toBeNull();
      await expect(store.insertUser(user("acme", "a2@example.invalid", { identityId: "idn_a" }))).rejects.toThrow();
    });
  });

  it("given an organization with a seat for two and one member, when two people join at once, then one is added and the other finds it full, and no limit adds both", async () => {
    await using(fresh, async (store) => {
      // given
      await store.insertUser(user("acme", "a@example.invalid", { role: "owner" }));

      // when
      const joined = await Promise.all([store.insertMember(user("acme", "b@example.invalid"), 2), store.insertMember(user("acme", "c@example.invalid"), 2)]);
      const unlimited = await Promise.all([store.insertMember(user("globex", "b@example.invalid"), null), store.insertMember(user("globex", "c@example.invalid"), null)]);

      // then
      expect(joined.filter(Boolean)).toHaveLength(1);
      expect(await store.countMembers("acme")).toBe(2);
      expect(unlimited).toEqual([true, true]);
      expect(await store.countMembers("globex")).toBe(2);
    });
  });

  it("given a signup, when it creates an organization, then the organization, its owner and its name land together, and a taken slug or a tenant that has an owner leaves nothing behind", async () => {
    await using(fresh, async (store) => {
      // given
      await store.insertIdentity(identity("idn_a", "a@example.invalid"), login("idn_a", "google", "g-1"));
      const perDay = { identityId: "idn_a", since: "2026-11-01T10:00:00.000Z", limit: 3 };
      const owner = (tenant: string) => user(tenant, "a@example.invalid", { role: "owner", identityId: "idn_a" });
      await store.insertOrg({ ...org("gone", "idn_b"), deletedAt: at });
      await store.insertUser(user("configured", "ops@example.invalid", { role: "owner" }));

      // when
      const created = await store.createOrg(org("acme", "idn_a"), owner("acme"), "Acme Payments", perDay);
      const again = await store.createOrg(org("acme", "idn_a"), owner("acme"), "Acme Two", perDay);
      const tombstone = await store.createOrg(org("gone", "idn_a"), owner("gone"), "Gone", perDay);
      const ownedAlready = await store.createOrg(org("configured", "idn_a"), owner("configured"), "Configured", perDay);

      // then
      expect([created, again, tombstone, ownedAlready]).toEqual(["created", "taken", "taken", "taken"]);
      expect((await store.getUserByIdentity("acme", "idn_a"))?.role).toBe("owner");
      expect(await store.getSetting("acme", "org.name")).toBe("Acme Payments");
      expect(await store.getUserByIdentity("gone", "idn_a")).toBeNull();
      expect(await store.getOrg("configured")).toBeNull();
      expect(await store.getUserByIdentity("configured", "idn_a")).toBeNull();
      expect(await store.getSetting("configured", "org.name")).toBeNull();
    });
  });

  it("given a person at their day's limit less one, when they sign up two organizations at once, then one is created and the other is refused for the limit", async () => {
    await using(fresh, async (store) => {
      // given
      await store.insertIdentity(identity("idn_a", "a@example.invalid"), login("idn_a", "google", "g-1"));
      await store.insertOrg(org("first", "idn_a"));
      const perDay = { identityId: "idn_a", since: "2026-11-02T00:00:00.000Z", limit: 2 };
      const owner = (tenant: string) => user(tenant, "a@example.invalid", { role: "owner", identityId: "idn_a" });

      // when
      const both = await Promise.all([store.createOrg(org("acme", "idn_a"), owner("acme"), "Acme", perDay), store.createOrg(org("globex", "idn_a"), owner("globex"), "Globex", perDay)]);

      // then
      expect([...both].sort()).toEqual(["created", "limit"]);
      expect(await store.countOrgsCreatedSince("idn_a", perDay.since)).toBe(2);
    });
  });

  it("given invitations to one address in three organizations, one expired and one in a deleted organization, when that address's invitations are read, then only the live one in a live organization comes back, and another address's never", async () => {
    await using(fresh, async (store) => {
      // given
      const invite = (tenant: string, email: string, createdAt: string, expiresAt: string) => ({ tenant, id: `inv_${tenant}_${email}`, email, role: "member" as const, teams: [], tokenHash: `${tenant}-${email}`, invitedBy: "owner@example.invalid", createdAt, expiresAt });
      await store.saveInvite(invite("acme", "a@example.invalid", "2026-11-01T00:00:00.000Z", "2026-11-08T00:00:00.000Z"));
      await store.saveInvite(invite("globex", "a@example.invalid", "2026-10-01T00:00:00.000Z", "2026-10-08T00:00:00.000Z"));
      await store.saveInvite(invite("gone", "a@example.invalid", "2026-11-01T00:00:00.000Z", "2026-11-08T00:00:00.000Z"));
      await store.saveInvite(invite("acme", "b@example.invalid", "2026-11-01T00:00:00.000Z", "2026-11-08T00:00:00.000Z"));
      await store.insertOrg({ ...org("gone", "idn_b"), deletedAt: at });

      // when
      const found = await store.listInvitesByEmail("a@example.invalid", at);

      // then
      expect(found.map((i) => [i.tenant, i.email])).toEqual([["acme", "a@example.invalid"]]);
    });
  });

  it("given an organization, when it is created again, given quotas and deleted, then its slug stays taken, it leaves the list, its quotas read back with each missing one as none, and its creator's count keeps it", async () => {
    await using(fresh, async (store) => {
      // given
      expect(await store.insertOrg(org("acme", "idn_a"))).toBe(true);
      expect(await store.insertOrg(org("globex", "idn_a", "2026-11-01T10:00:00.000Z"))).toBe(true);

      // when
      const again = await store.insertOrg(org("acme", "idn_b"));
      await store.setOrgQuotas("acme", { members: 5, tasksPerMonth: null, concurrentTasks: 2 });
      const freeAtFirst = (await store.getOrg("acme"))?.plan;
      await store.setOrgPlan("acme", "pro");
      const deleted = await store.deleteOrg("globex", at);
      const twice = await store.deleteOrg("globex", at);

      // then
      expect([again, deleted, twice]).toEqual([false, true, false]);
      expect([freeAtFirst, (await store.getOrg("acme"))?.plan, (await store.getOrg("globex"))?.plan]).toEqual(["free", "pro", "free"]);
      expect((await store.listOrgs()).map((o) => [o.tenant, o.quotas])).toEqual([["acme", { members: 5, tasksPerMonth: null, concurrentTasks: 2 }]]);
      expect((await store.getOrg("globex"))?.deletedAt).toBe(at);
      expect(await store.insertOrg(org("globex", "idn_b"))).toBe(false);
      expect(await store.countOrgsCreatedSince("idn_a", "2026-11-01T00:00:00.000Z")).toBe(2);
      expect(await store.countOrgsCreatedSince("idn_a", "2026-11-02T00:00:00.000Z")).toBe(1);
    });
  });
});

// The tasks table as the first task runner created it, before its log counter.
const TASKS_BEFORE_LOG_SEQ = `CREATE TABLE tasks (
  tenant TEXT NOT NULL, id TEXT NOT NULL, repo_id TEXT NOT NULL, team TEXT NOT NULL, title TEXT NOT NULL,
  description TEXT NOT NULL, agent TEXT NOT NULL, status TEXT NOT NULL, created_by TEXT NOT NULL, created_at TEXT NOT NULL,
  started_at TEXT, finished_at TEXT, base_sha TEXT, tests TEXT, cost_usd REAL, input_tokens INTEGER, output_tokens INTEGER,
  request_number INTEGER, error TEXT, PRIMARY KEY (tenant, id)
)`;

const olderStores: [string, () => Promise<{ store: Store; dispose: () => Promise<void> }>][] = [
  [
    "sqlite",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "orchestrator-store-old-"));
      const file = join(dir, "orchestrator.db");
      const db = new DatabaseSync(file);
      db.exec(TASKS_BEFORE_LOG_SEQ);
      db.close();
      const store = openSqliteStore(file);
      return { store, dispose: async () => { await store.close(); rmSync(dir, { recursive: true, force: true }); } };
    },
  ],
  ...(PG_URL
    ? ([
        [
          "postgres",
          async () => {
            const name = `orchestrator_test_${randomBytes(6).toString("hex")}`;
            const admin = new pg.Client({ connectionString: PG_URL });
            await admin.connect();
            await admin.query(`CREATE DATABASE ${name}`);
            await admin.end();
            const url = new URL(PG_URL!);
            url.pathname = `/${name}`;
            const older = new pg.Client({ connectionString: url.toString() });
            await older.connect();
            await older.query(TASKS_BEFORE_LOG_SEQ);
            await older.end();
            const store = await openPostgresStore(url.toString(), ["a"], () => undefined);
            return {
              store,
              dispose: async () => {
                await store.close();
                const drop = new pg.Client({ connectionString: PG_URL });
                await drop.connect();
                await drop.query(`DROP DATABASE IF EXISTS ${name}`);
                await drop.end();
              },
            };
          },
        ],
      ] as [string, () => Promise<{ store: Store; dispose: () => Promise<void> }>][])
    : []),
];

describe.each(olderStores)("a %s database an older orchestrator created", (_name, open) => {
  it("given a tasks table from before the log counter, when the store opens and a task logs, then the missing column is added and the lines are numbered", async () => {
    // given
    const { store, dispose } = await open();
    try {
      await store.createTask(task("a", "aaaaaaaaaaaa", "running"));

      // when
      await store.appendTaskLog("a", "aaaaaaaaaaaa", ["one", "two"]);

      // then
      expect((await store.taskLog("a", "aaaaaaaaaaaa", 0)).map((l) => [l.seq, l.text])).toEqual([[1, "one"], [2, "two"]]);
    } finally {
      await dispose();
    }
  });

  it("given a tasks table from before the recorded branch, when a running task records its branch, then a start finds it", async () => {
    // given
    const { store, dispose } = await open();
    try {
      await store.createTask(task("a", "aaaaaaaaaaaa", "running"));

      // when
      await store.setTaskBranch("a", "aaaaaaaaaaaa", "task/aaaaaaaaaaaa");

      // then
      expect(await store.unfinishedTasks("a")).toEqual([{ id: "aaaaaaaaaaaa", repoId: "payments-skills", pgid: null, branch: "task/aaaaaaaaaaaa", targets: [] }]);
    } finally {
      await dispose();
    }
  });

  it("given a tasks table from before task templates, when a task from a template and one without are created, then each reads back as it was started", async () => {
    // given
    const { store, dispose } = await open();
    try {
      // when
      await store.createTask({ ...task("a", "aaaaaaaaaaaa", "queued"), template: { kind: "skill.write", skill: "on-call" } });
      await store.createTask(task("a", "bbbbbbbbbbbb", "queued"));

      // then
      expect((await store.getTask("a", "aaaaaaaaaaaa"))!.template).toEqual({ kind: "skill.write", skill: "on-call" });
      expect((await store.getTask("a", "bbbbbbbbbbbb"))!.template).toBeNull();
    } finally {
      await dispose();
    }
  });
});

/** A database that outlives one store: opened, closed, written to by hand, opened again. */
type Kept = { open: () => Promise<Store>; exec: (sql: string) => Promise<void>; versions: () => Promise<number[]>; floors: () => Promise<number[]>; has: (table: string) => Promise<boolean>; untenanted: () => Promise<string[]>; dispose: () => Promise<void> };

const keptStores: [string, () => Promise<Kept>][] = [
  [
    "sqlite",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "orchestrator-store-kept-"));
      const file = join(dir, "orchestrator.db");
      return {
        open: async () => openSqliteStore(file),
        exec: async (sql) => {
          const db = new DatabaseSync(file);
          db.exec(sql);
          db.close();
        },
        versions: async () => {
          const db = new DatabaseSync(file);
          const rows = db.prepare("SELECT version FROM schema_version").all() as { version: number }[];
          db.close();
          return rows.map((r) => Number(r.version));
        },
        floors: async () => {
          const db = new DatabaseSync(file);
          const rows = db.prepare("SELECT version FROM schema_floor").all() as { version: number }[];
          db.close();
          return rows.map((r) => Number(r.version));
        },
        has: async (table) => {
          const db = new DatabaseSync(file);
          const found = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) !== undefined;
          db.close();
          return found;
        },
        untenanted: async () => {
          const db = new DatabaseSync(file);
          const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[];
          const without = tables.filter(({ name }) => !(db.prepare(`PRAGMA table_info("${name}")`).all() as { name: string }[]).some((c) => c.name === "tenant")).map((t) => t.name);
          db.close();
          return without;
        },
        dispose: async () => rmSync(dir, { recursive: true, force: true }),
      };
    },
  ],
  ...(PG_URL
    ? ([
        [
          "postgres",
          async () => {
            const name = `orchestrator_test_${randomBytes(6).toString("hex")}`;
            const admin = new pg.Client({ connectionString: PG_URL });
            await admin.connect();
            await admin.query(`CREATE DATABASE ${name}`);
            await admin.end();
            const url = new URL(PG_URL!);
            url.pathname = `/${name}`;
            return {
              open: () => openPostgresStore(url.toString(), ["a"], () => undefined),
              exec: async (sql) => {
                const client = new pg.Client({ connectionString: url.toString() });
                await client.connect();
                await client.query(sql);
                await client.end();
              },
              versions: async () => {
                const client = new pg.Client({ connectionString: url.toString() });
                await client.connect();
                const { rows } = await client.query("SELECT version FROM schema_version");
                await client.end();
                return rows.map((r) => Number(r.version));
              },
              floors: async () => {
                const client = new pg.Client({ connectionString: url.toString() });
                await client.connect();
                const { rows } = await client.query("SELECT version FROM schema_floor");
                await client.end();
                return rows.map((r) => Number(r.version));
              },
              has: async (table) => {
                const client = new pg.Client({ connectionString: url.toString() });
                await client.connect();
                const { rows } = await client.query("SELECT to_regclass($1) AS found", [table]);
                await client.end();
                return rows[0].found !== null;
              },
              untenanted: async () => {
                const client = new pg.Client({ connectionString: url.toString() });
                await client.connect();
                const { rows } = await client.query(
                  "SELECT t.table_name AS name FROM information_schema.tables t WHERE t.table_schema = current_schema() AND t.table_type = 'BASE TABLE' AND NOT EXISTS (SELECT 1 FROM information_schema.columns c WHERE c.table_schema = t.table_schema AND c.table_name = t.table_name AND c.column_name = 'tenant') ORDER BY t.table_name",
                );
                await client.end();
                return rows.map((r) => String(r.name));
              },
              dispose: async () => {
                const drop = new pg.Client({ connectionString: PG_URL });
                await drop.connect();
                await drop.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
                await drop.end();
              },
            };
          },
        ],
      ] as [string, () => Promise<Kept>][])
    : []),
];

describe("a SQLite database's file modes", () => {
  it("given an open umask, a new database and one an earlier start left open, when each is opened and written, then the database and its journal files are the user's alone", async () => {
    const dir = mkdtempSync(join(tmpdir(), "th-db-mode-"));
    const umask = process.umask(0o022);
    try {
      // given
      const left = join(dir, "left.db");
      const before = openSqliteStore(left);
      await before.close();
      chmodSync(left, 0o644);

      // when
      const fresh = openSqliteStore(join(dir, "fresh.db"));
      await fresh.setSetting("default", "org.name", "Payments");
      const reopened = openSqliteStore(left);
      await reopened.setSetting("default", "org.name", "Payments");

      // then
      for (const file of ["fresh.db", "fresh.db-wal", "fresh.db-shm", "left.db", "left.db-wal"]) expect([file, statSync(join(dir, file)).mode & 0o777]).toEqual([file, 0o600]);
      await fresh.close();
      await reopened.close();
    } finally {
      process.umask(umask);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("a SQLite database that runs out of room", () => {
  it("given a transaction a full database ends on its own, when it fails, then the error says the database is full and the next transaction runs", async () => {
    // given
    const dir = mkdtempSync(join(tmpdir(), "orchestrator-store-full-"));
    const db = new DatabaseSync(join(dir, "full.db"));
    db.exec("CREATE TABLE t (x TEXT); PRAGMA max_page_count = 8;");
    const driver = sqliteDriver(db);

    // when
    const attempt = driver.transaction(async (tx) => {
      for (let i = 0; i < 100; i++) await tx.run("INSERT INTO t (x) VALUES (?)", ["x".repeat(4000)]);
    });

    // then
    try {
      await expect(attempt).rejects.toThrow(/database or disk is full/);
      await driver.transaction(async (tx) => {
        await tx.run("INSERT INTO t (x) VALUES (?)", ["small"]);
      });
      expect(await driver.all("SELECT x FROM t")).toEqual([{ x: "small" }]);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the schema's shape and the orchestrator that opens it", () => {
  it("given the migrations as written, when what each shipped one sends is compared with what it shipped with, then none has changed and they count up from one", async () => {
    // A failure here means a shipped migration was edited: put the change in a new migration
    // instead, so a database that already ran the old one gets it too. A new migration adds
    // its own line here.
    // What each step sends to each database, read by stand-ins that keep every statement.
    const said = async (m: (typeof MIGRATIONS)[number]) => {
      const sent: string[] = [];
      m.sqlite({ exec: (sql: string) => void sent.push(sql), prepare: () => ({ all: () => [] }) } as unknown as Parameters<typeof m.sqlite>[0]);
      await m.postgres({ exec: async (sql: string) => void sent.push(sql), all: async () => [], run: async () => 0 } as unknown as Parameters<typeof m.postgres>[0]);
      return createHash("sha256").update(sent.join("\n")).digest("hex").slice(0, 12);
    };
    const shipped = await Promise.all(MIGRATIONS.map(async (m) => [m.version, await said(m)]));
    expect(MIGRATIONS.map((m) => m.version)).toEqual(MIGRATIONS.map((_, i) => i + 1));
    expect(SCHEMA_VERSION).toBe(MIGRATIONS.length);
    expect(SCHEMA_VERSION_TABLE).toBe("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL);");
    expect(shipped).toEqual([
      [1, "fcb9552e7e50"],
      [2, "72fd731d5e37"],
      [3, "da74c73b274f"],
      [4, "fdf9acb7f648"],
      [5, "84f7d79b3151"],
      [6, "92227dceed57"],
      [7, "d2e50593eb36"],
      [8, "0dee2fdc6677"],
      [9, "a0f4769e6c15"],
      [10, "7aaf63457bc8"],
      [11, "f3b0675f3366"],
      [12, "c04e97b99170"],
      [13, "26a525738337"],
      [14, "ace324388c39"],
      [15, "a1d11a66674d"],
      [16, "0647c5e05899"],
      [17, "4028e2c8af01"],
      [18, "089c1587db26"],
      [19, "2174a05bb8a4"],
      [20, "3e9662cb8eaa"],
      [21, "73bd91e0cc30"],
      [22, "867435d220f9"],
      [23, "1d3c32afb2d8"],
      [24, "862870e1335e"],
      [25, "0e27ce0854d8"],
      [26, "f8ac1a3199c0"],
      [27, "925e969c3665"],
      [28, "04aae3a8a3f7"],
      [29, "cc27bc41f770"],
      [30, "93a84734f034"],
      [31, "6caf6d43090d"],
      [32, "0ec524a092f2"],
      [33, "7c15502210c0"],
      [34, "a06dadd45e73"],
      [35, "5223b4c4e7f0"],
      [36, "8f0e666aab59"],
      [37, "51b1b2ed5b50"],
      [38, "36ca2aabe733"],
      [39, "f27f1d8af8c7"],
      [40, "13272c5f783e"],
      [41, "413008c457f2"],
      [42, "6a2d1827c955"],
      [43, "491cde8f73a5"],
      [44, "37e009550004"],
      [45, "ea95434da31e"],
      [46, "78cbdff6dfff"],
      [47, "a97e538589ab"],
    ]);
  });
});

describe("expand and contract marks on the migrations", () => {
  it("given the migrations as written, when the floor is read for each version, then it is the last contract migration up to that version, and the first tables and the owner role are the contract ones so far", () => {
    expect(MIGRATIONS.filter((m) => m.kind === "contract").map((m) => m.version).slice(0, 2)).toEqual([1, 4]);
    expect(MIGRATIONS.every((m) => m.kind === "expand" || m.kind === "contract")).toBe(true);
    expect(readableFrom(0)).toBe(0);
    expect(readableFrom(3)).toBe(1);
    expect(readableFrom(4)).toBe(4);
    expect(readableFrom(SCHEMA_VERSION)).toBe(Math.max(...MIGRATIONS.filter((m) => m.kind === "contract").map((m) => m.version)));
  });
});

describe.each(keptStores)("a %s database with sessions from before they were listed", (_name, keep) => {
  it("given sessions written before sessions had ids, when this orchestrator opens the database, then each one gets its own id and is listed", async () => {
    // given
    const db = await keep();
    try {
      const store = await db.open();
      await store.saveSession({ tokenHash: "h1", tenant: "a", userId: "usr_ada", csrf: "c", expiresAt: "2026-11-03T10:00:00.000Z" });
      await store.saveSession({ tokenHash: "h2", tenant: "a", userId: "usr_ada", csrf: "c", expiresAt: "2026-11-03T10:00:00.000Z" });
      await store.close();
      await db.exec("DROP INDEX sessions_id; UPDATE sessions SET id = NULL, created_at = NULL, last_seen_at = NULL; DELETE FROM schema_version; INSERT INTO schema_version (version) VALUES (18);");

      // when
      const reopened = await db.open();
      const listed = await reopened.listSessions("a", "usr_ada");
      await reopened.close();

      // then
      expect(listed).toHaveLength(2);
      expect(new Set(listed.map((l) => l.id)).size).toBe(2);
      expect(listed.every((l) => /^ses_[0-9a-f]{26}$/.test(l.id) && l.createdAt === null)).toBe(true);
    } finally {
      await db.dispose();
    }
  });
});

describe.each(keptStores)("a %s database and which tables belong to an organization", (_name, keep) => {
  it("given every migration run, when the tables are listed, then each one carries a tenant but the identity tables, the signup steps and the schema's own, which belong to no one organization", async () => {
    // given
    const db = await keep();
    try {
      await (await db.open()).close();

      // when
      const untenanted = await db.untenanted();

      // then
      // A table added without a tenant lands here and fails this, so it is read per organization or named as global on purpose.
      expect(untenanted).toEqual(["identities", "identity_events", "identity_logins", "identity_sessions", "identity_sign_ins", "schema_floor", "schema_version"]);
    } finally {
      await db.dispose();
    }
  });
});

describe.each(keptStores)("a %s database and the schema shape", (_name, keep) => {
  it("given a database a newer orchestrator opened and left without a table this one knows, when this orchestrator opens it, then it stops with the reason and creates nothing", async () => {
    // given
    const db = await keep();
    try {
      await (await db.open()).close();
      await db.exec(`DROP TABLE usage_counts; DELETE FROM schema_version; INSERT INTO schema_version (version) VALUES (${SCHEMA_VERSION + 1}); DELETE FROM schema_floor; INSERT INTO schema_floor (version) VALUES (${SCHEMA_VERSION + 1});`);

      // when
      const opened = db.open();

      // then
      await expect(opened).rejects.toThrow(newerSchema(SCHEMA_VERSION + 1));
      expect(await db.versions()).toEqual([SCHEMA_VERSION + 1]);
      expect(await db.has("usage_counts")).toBe(false);
    } finally {
      await db.dispose();
    }
  });

  it("given a database a newer orchestrator moved with changes that only add, when this orchestrator opens it, then it reads it and leaves the newer version and floor as they are", async () => {
    // given
    const db = await keep();
    try {
      await (await db.open()).close();
      await db.exec(`CREATE TABLE added_later (tenant TEXT NOT NULL); DELETE FROM schema_version; INSERT INTO schema_version (version) VALUES (${SCHEMA_VERSION + 1});`);

      // when
      const store = await db.open();
      await store.upsertRepo({ tenant: "a", id: "payments-skills", team: "payments", name: "Payments skills", url: "file:///repos/payments-skills.git" });
      const repos = await store.listRepos("a");
      await store.close();

      // then
      expect(repos.map((r) => r.id)).toEqual(["payments-skills"]);
      expect(await db.versions()).toEqual([SCHEMA_VERSION + 1]);
      expect(await db.floors()).toEqual([readableFrom(SCHEMA_VERSION)]);
    } finally {
      await db.dispose();
    }
  });

  it("given a newer database that records no floor, as one an image from before the floor leaves, when this orchestrator opens it, then it stops as before", async () => {
    // given
    const db = await keep();
    try {
      await (await db.open()).close();
      await db.exec(`DELETE FROM schema_floor; DELETE FROM schema_version; INSERT INTO schema_version (version) VALUES (${SCHEMA_VERSION + 1});`);

      // when
      const opened = db.open();

      // then
      await expect(opened).rejects.toThrow(newerSchema(SCHEMA_VERSION + 1));
      expect(await db.floors()).toEqual([]);
    } finally {
      await db.dispose();
    }
  });

  it("given a database at this orchestrator's version that records no floor, when this orchestrator opens it, then the floor is written once", async () => {
    // given
    const db = await keep();
    try {
      await (await db.open()).close();
      await db.exec("DELETE FROM schema_floor;");

      // when
      await (await db.open()).close();
      await (await db.open()).close();

      // then
      expect(await db.versions()).toEqual([SCHEMA_VERSION]);
      expect(await db.floors()).toEqual([readableFrom(SCHEMA_VERSION)]);
    } finally {
      await db.dispose();
    }
  });

  it("given a database from before the shape was recorded, when this orchestrator opens it, then it is recorded at this orchestrator's shape, once", async () => {
    // given
    const db = await keep();
    try {
      await (await db.open()).close();
      await db.exec("DROP TABLE schema_version;");

      // when
      await (await db.open()).close();
      await (await db.open()).close();

      // then
      expect(await db.versions()).toEqual([SCHEMA_VERSION]);
    } finally {
      await db.dispose();
    }
  });
});

describe.each(keptStores)("a %s database from before roles were parted from team ownership", (_name, keep) => {
  it("given an admin, a team owner and a member written by the shape-3 orchestrator, when this orchestrator opens it, then the admin is an owner, the team owner a member who keeps the team, and opening again changes nothing", async () => {
    // given
    const db = await keep();
    try {
      await (await db.open()).close();
      const at = "2026-10-01T00:00:00.000Z";
      await db.exec(
        "DELETE FROM schema_version; INSERT INTO schema_version (version) VALUES (3);" +
          `INSERT INTO users (tenant, id, email, name, role, created_at) VALUES ('a', 'u1', 'ada@example.invalid', 'Ada', 'admin', '${at}'), ('a', 'u2', 'pat@example.invalid', 'Pat', 'owner', '${at}'), ('a', 'u3', 'max@example.invalid', 'Max', 'member', '${at}');` +
          "INSERT INTO team_owners (tenant, user_id, team) VALUES ('a', 'u2', 'Payments');",
      );

      // when
      await (await db.open()).close();
      const store = await db.open();

      // then
      try {
        expect((await store.listUsers("a")).map((u) => [u.id, u.role])).toEqual([
          ["u1", "owner"],
          ["u3", "member"],
          ["u2", "member"],
        ]);
        expect(await store.ownedTeams("a", "u2")).toEqual(["Payments"]);
        expect(await db.versions()).toEqual([SCHEMA_VERSION]);
      } finally {
        await store.close();
      }
    } finally {
      await db.dispose();
    }
  });
});

function task(tenant: string, id: string, status: TaskRecord["status"]): TaskRecord {
  return {
    tenant,
    id,
    repoId: "payments-skills",
    team: "Payments",
    title: "Add a note",
    description: "",
    issueUrl: null,
    issueKey: null,
    agent: "fake",
    status,
    createdBy: "ada@example.invalid",
    createdAt: "2026-10-23T10:00:00.000Z",
    startedAt: "2026-10-23T10:00:01.000Z",
    finishedAt: null,
    baseSha: null,
    tests: null,
    cost: { usd: null, inputTokens: null, outputTokens: null },
    requestNumber: null,
    error: null,
  };
}
