import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { OrchestratorContext } from "../app.js";
import type { Principal } from "../auth.js";
import { saveEnabled } from "../integrations/records.js";
import { TRACKER, TRACKER_TOKEN_SECRET } from "../integrations/tracker.js";
import { openSqliteStore } from "../store.js";
import type { TaskRecord } from "../tasks/types.js";
import { UNKNOWN_COST } from "../tasks/types.js";
import { createVault, storeSecret } from "../vault.js";
import { WorkCache, FRESH_EVERY_MS, WORK_TTL_MS } from "./cache.js";
import { parseBoardId, parseSprintId } from "./ids.js";
import { taskLinks } from "./links.js";
import { sourceView, workSources } from "./sources.js";

const ADA: Principal = { id: "u-ada", name: "Ada Admin", email: "ada@example.invalid", role: "admin", ownedTeams: [] };
const PAT: Principal = { id: "u-pat", name: "Pat Owner", email: "pat@example.invalid", role: "member", ownedTeams: ["Payments"] };
const SAM: Principal = { id: "u-sam", name: "Sam Member", email: "sam@example.invalid", role: "member", ownedTeams: [] };

function orchestrator_(): OrchestratorContext {
  return { store: openSqliteStore(":memory:"), dataDir: "unused", tenant: "acme", vault: createVault(randomBytes(32)) };
}

function task(id: string, over: Partial<TaskRecord>): TaskRecord {
  return {
    tenant: "acme", id, repoId: "payments-skills", team: "Payments", title: id, description: "", issueUrl: null, issueKey: null, agent: "claude", status: "running",
    createdBy: PAT.email, createdAt: "2026-11-01T10:00:00.000Z", startedAt: null, finishedAt: null, baseSha: null, tests: null, cost: UNKNOWN_COST, requestNumber: null, error: null, ...over,
  };
}

describe("the trackers a person reads work from", () => {
  it("given the organization's Jira with its token and Sam's own server allowed to read Jira issues, when Sam lists sources, then both are there, the token one as the organization's", async () => {
    // given
    const ctx = orchestrator_();
    await saveEnabled(ctx, TRACKER, { kind: "jira", url: "https://acme.atlassian.example", email: "bot@example.invalid" }, ADA);
    await storeSecret(ctx.store, ctx.vault!, ctx.tenant, TRACKER_TOKEN_SECRET, "stand-in-token-0001", ADA.email);
    await ctx.store.setSetting(ctx.tenant, `mcp.personal.${SAM.id}`, JSON.stringify([
      { name: "atlassian", description: "", transport: "http", url: "https://mcp.atlassian.example/mcp", auth: "oauth", tools: ["getJiraIssue"], addedAt: "2026-11-01T00:00:00.000Z" },
      { name: "notes", description: "", transport: "http", url: "https://notes.example/mcp", auth: "none", tools: ["read_note"], addedAt: "2026-11-01T00:00:00.000Z" },
    ]));

    // when
    const listed = (await workSources(ctx, SAM)).map((s) => sourceView(s, null, null));

    // then
    expect(listed.map((s) => [s.id, s.kind, s.name, s.via, s.as])).toEqual([
      ["tracker", "jira", "Jira (acme.atlassian.example)", "token", "organization"],
      ["mcp:atlassian", "jira", "atlassian", "mcp", "you"],
    ]);
    expect(JSON.stringify(listed)).not.toContain("stand-in-token-0001");
  });

  it("given a tracker connected with no token, when anyone lists sources, then it is not one", async () => {
    // given
    const ctx = orchestrator_();
    await saveEnabled(ctx, TRACKER, { kind: "gitlab", url: "https://gitlab.example" }, ADA);

    // when
    const listed = await workSources(ctx, ADA);

    // then
    expect(listed).toEqual([]);
  });
});

describe("the orchestrator tasks an issue was started from", () => {
  it("given tasks on PAY-142 by two teams, when the Payments owner and a member with no team read the links, then each sees only the tasks they may read, newest first, with the requests they opened", async () => {
    // given
    const ctx = orchestrator_();
    await ctx.store.createTask(task("tsk_older000001", { issueKey: "PAY-142", createdAt: "2026-11-01T09:00:00.000Z", status: "needs-review", requestNumber: 7 }));
    await ctx.store.createTask(task("tsk_newer000001", { issueKey: "PAY-142", createdAt: "2026-11-01T11:00:00.000Z" }));
    await ctx.store.createTask(task("tsk_other000001", { issueKey: "PAY-142", team: "Lending", repoId: "lending-skills", createdBy: "lin@example.invalid" }));
    await ctx.store.createTask(task("tsk_unrel000001", { issueKey: "PAY-9" }));
    await ctx.store.saveRequest({ tenant: "acme", repoId: "payments-skills", number: 7, provider: "gitlab", url: "https://gitlab.example/acme/payments-skills/-/merge_requests/7", branch: "b", headSha: "a".repeat(40), title: "t", status: "open", createdAt: "2026-11-01T09:30:00.000Z", createdBy: "x" });

    // when
    const forPat = await taskLinks(ctx, PAT, ["PAY-142", "PAY-142", "PAY-500"]);
    const forSam = await taskLinks(ctx, SAM, ["PAY-142"]);

    // then
    expect(forPat.get("PAY-142")!.map((l) => l.taskId)).toEqual(["tsk_newer000001", "tsk_older000001"]);
    expect(forPat.get("PAY-142")![1]).toEqual({ taskId: "tsk_older000001", status: "needs-review", phase: "review", result: null, targets: [], requests: [{ repoId: "payments-skills", number: 7, status: "open", url: "https://gitlab.example/acme/payments-skills/-/merge_requests/7", name: "Merge request !7 on GitLab" }], startedBy: PAT.email, costUsd: null });
    expect(forPat.has("PAY-500")).toBe(false);
    expect(forSam.size).toBe(0);
    expect((await taskLinks(ctx, ADA, ["PAY-142"])).get("PAY-142")).toHaveLength(3);
  });

  it("given a failed task with a multi-line error and a running one, when the links are read, then the failed one says why in one line and the running one says nothing", async () => {
    // given
    const ctx = orchestrator_();
    await ctx.store.createTask(task("tsk_failed000001", { issueKey: "PAY-142", createdAt: "2026-11-01T09:00:00.000Z", status: "failed", error: "The plan waited too long.\nat step 4" }));
    await ctx.store.createTask(task("tsk_running00001", { issueKey: "PAY-142", createdAt: "2026-11-01T11:00:00.000Z", status: "running" }));

    // when
    const links = (await taskLinks(ctx, PAT, ["PAY-142"])).get("PAY-142")!;

    // then
    expect(links.find((l) => l.taskId === "tsk_failed000001")?.reason).toBe("The plan waited too long.");
    expect(links.find((l) => l.taskId === "tsk_running00001")).not.toHaveProperty("reason");
  });

  it("given a task whose request stays on this machine and one whose request is on GitHub, when the links are read, then the local one is named by its repository's own name, not its id, and reviewed on the task's page, and the GitHub one by GitHub's own word", async () => {
    // given
    const ctx = orchestrator_();
    await ctx.store.upsertRepo({ tenant: "acme", id: "payments-skills", team: "Payments", name: "refund-service", url: "/stand-in/code/refund-service" });
    await ctx.store.createTask(task("tsk_local000001", { issueKey: "PAY-7", status: "needs-review", requestNumber: 1 }));
    await ctx.store.createTask(task("tsk_hub00000001", { issueKey: "PAY-8", status: "needs-review", requestNumber: 12 }));
    const request = { tenant: "acme", repoId: "payments-skills", branch: "b", headSha: "a".repeat(40), title: "t", status: "open" as const, createdAt: "2026-11-01T09:00:00.000Z", createdBy: PAT.email };
    await ctx.store.saveRequest({ ...request, number: 1, provider: "local", url: "local://requests/payments-skills/1" });
    await ctx.store.saveRequest({ ...request, number: 12, provider: "github", url: "https://github.com/acme/payments-skills/pull/12" });

    // when
    const links = await taskLinks(ctx, PAT, ["PAY-7", "PAY-8"]);

    // then
    expect(links.get("PAY-7")![0]!.requests).toEqual([{ repoId: "payments-skills", number: 1, status: "open", url: null, name: "refund-service #1" }]);
    expect(links.get("PAY-8")![0]!.requests).toEqual([{ repoId: "payments-skills", number: 12, status: "open", url: "https://github.com/acme/payments-skills/pull/12", name: "Pull request #12 on GitHub" }]);
  });
});

describe("a tracker's answers kept for a minute", () => {
  it("given an answer read, when it is asked again within the minute, after it, and freshly, then the tracker is asked once, then behind a stale answer, then again", async () => {
    // given
    let now = 0;
    const cache = new WorkCache(() => now);
    let reads = 0;
    const load = async () => ++reads;
    await cache.read("acme:tracker:boards", load);

    // when
    const within = await cache.read("acme:tracker:boards", load);
    now = WORK_TTL_MS + 1;
    const past = await cache.read("acme:tracker:boards", load);
    await Promise.resolve();
    now += FRESH_EVERY_MS;
    const fresh = await cache.read("acme:tracker:boards", load, true);

    // then
    expect([within.value, within.stale]).toEqual([1, false]);
    expect([past.value, past.stale]).toEqual([1, true]);
    expect([fresh.value, fresh.stale]).toEqual([3, false]);
  });

  it("given two tenants' answers, when one tenant's are dropped, then only theirs are read again", async () => {
    // given
    const cache = new WorkCache();
    let reads = 0;
    const load = async () => ++reads;
    await cache.read("acme:tracker:boards", load);
    await cache.read("beta:tracker:boards", load);

    // when
    cache.evict("acme:tracker:");

    // then
    expect((await cache.read("acme:tracker:boards", load)).value).toBe(3);
    expect((await cache.read("beta:tracker:boards", load)).value).toBe(2);
  });
});

describe("a board or sprint id the screen sends back", () => {
  it("given ids in their shapes and made-up ones, when they are read, then only the shapes pass", () => {
    // given
    const given = ["tracker~12", "mcp:atlassian~PAY", "tracker~acme/payments-api", "tracker~12~34", "github~12", "tracker~../x", "tracker~12~3~4", "tracker~a b", "mcp:a~b~c/d"];

    // when
    const boards = given.map((id) => parseBoardId(id));
    const sprints = given.map((id) => parseSprintId(id));

    // then
    expect(boards).toEqual([{ source: "tracker", board: "12" }, { source: "mcp:atlassian", board: "PAY" }, { source: "tracker", board: "acme/payments-api" }, null, null, null, null, null, null]);
    expect(sprints).toEqual([null, null, null, { source: "tracker", board: "12", sprint: "34" }, null, null, null, null, null]);
  });
});
