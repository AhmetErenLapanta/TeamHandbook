import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MiddlewareHandler } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { seed } from "../../demo/seed.js";
import { createApp, syncRepo } from "../app.js";
import type { OrchestratorContext } from "../app.js";
import type { OrchestratorEnv, Principal } from "../auth.js";
import { openSqliteStore } from "../store.js";
import { fakeAgentAdapter } from "./agents.js";
import { seesTask } from "./guards.js";
import { STREAM_TICK_MS, TASKS_PER_PAGE } from "./routes.js";
import { createTaskRunner } from "./runner.js";
import { seededContext, storePrincipals } from "../test-fixtures.js";

const ADMIN: Principal = { id: "a", name: "Ada Example", email: "ada@example.invalid", role: "admin", ownedTeams: [] };
const OWNER_OF_PAYMENTS: Principal = { id: "p", name: "Pat Example", email: "pat@example.invalid", role: "member", ownedTeams: ["Payments"] };
const OWNER_OF_PLATFORM: Principal = { id: "l", name: "Lin Example", email: "lin@example.invalid", role: "member", ownedTeams: ["Platform"] };
const MEMBER: Principal = { id: "m", name: "Max Example", email: "max@example.invalid", role: "member", ownedTeams: [] };
const FAKE_AGENT = join(import.meta.dirname, "..", "..", "demo", "fake-agent.mjs");

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const as = (user: Principal): MiddlewareHandler<OrchestratorEnv> => async (c, next) => {
  c.set("user", user);
  await next();
};

/** One finished Payments task started by the admin and one by a Payments owner, and a way to read as anyone. */
async function twoTasks() {
  const root = mkdtempSync(join(tmpdir(), "orchestrator-task-visibility-"));
  dirs.push(root);
  const { configFile } = seed(join(root, "demo"));
  const config = JSON.parse(readFileSync(configFile, "utf8"));
  const ctx: OrchestratorContext = { store: openSqliteStore(":memory:"), dataDir: join(root, "data"), tenant: config.tenant };
  await storePrincipals(ctx, ADMIN, OWNER_OF_PAYMENTS);
  const entry = config.repos.find((r: { id: string }) => r.id === "payments-skills");
  await ctx.store.upsertRepo({ ...entry, tenant: config.tenant });
  await syncRepo(ctx, "payments-skills");
  ctx.tasks = createTaskRunner(ctx, { agents: [fakeAgentAdapter(FAKE_AGENT)], isolation: { mode: "process", network: "open" }, testCommand: () => null, hostEnv: { PATH: process.env.PATH } });
  const repo = (await ctx.store.getRepo(ctx.tenant, "payments-skills"))!;
  const byAdmin = await ctx.tasks.start({ repo, title: "Admin's task", description: "", agent: "fake", user: ADMIN });
  await ctx.tasks.idle();
  const byOwner = await ctx.tasks.start({ repo, title: "Owner's task", description: "", agent: "fake", user: OWNER_OF_PAYMENTS });
  await ctx.tasks.idle();
  return { ctx, reader: (user: Principal) => createApp(ctx, as(user)), byAdmin: byAdmin.id, byOwner: byOwner.id };
}

describe("seesTask", () => {
  it("given a Payments task, when each role asks, then the organization's owners and admins, Payments' owners and its starter read it, and nobody else", () => {
    // given
    const task = { team: "Payments", createdBy: MEMBER.email };

    // when
    const seen = [ADMIN, { ...ADMIN, role: "owner" as const }, OWNER_OF_PAYMENTS, OWNER_OF_PLATFORM, MEMBER, { ...MEMBER, email: "someone@example.invalid" }].map((u) => seesTask(u, task));

    // then
    expect(seen).toEqual([true, true, true, false, true, false]);
  });

  it("given a task a service account started, when that account asks by its id, then it reads it", () => {
    // given
    const task = { team: "Payments", createdBy: "service:ci" };

    // when
    const seen = seesTask({ id: "service:ci", name: "CI", email: "ci@service.invalid", role: "member", ownedTeams: [] }, task);

    // then
    expect(seen).toBe(true);
  });
});

describe("reading tasks over the API", () => {
  it("given tasks on Payments, when another team's owner and a member who started none read them, then the list is empty and each task, log, stream and cancel answers as unknown", async () => {
    // given
    const { reader, byAdmin } = await twoTasks();

    // when
    const answers = await Promise.all(
      [OWNER_OF_PLATFORM, MEMBER].flatMap((user) => {
        const app = reader(user);
        return [app.request("/api/tasks"), app.request(`/api/tasks/${byAdmin}?after=0`), app.request(`/api/tasks/${byAdmin}/events`), app.request(`/api/tasks/${byAdmin}/cancel`, { method: "POST" })];
      }),
    );

    // then
    expect(answers.map((r) => r.status)).toEqual([200, 404, 404, 404, 200, 404, 404, 404]);
    expect((await answers[0]!.json()).tasks).toEqual([]);
    expect((await answers[4]!.json()).tasks).toEqual([]);
    expect((await answers[3]!.json()).error).toBe("unknown task");
    expect(await answers[1]!.text()).not.toContain("Admin's task");
  });

  it("given a Payments task shared with a member who did not start it, when they read it and act on it, then the list, the task, its events, its requests and its changes answer them, the same masked text the starter gets, and every action answers as unknown", async () => {
    // given
    const { ctx, reader, byAdmin } = await twoTasks();
    await ctx.store.addTaskShare({ tenant: ctx.tenant, taskId: byAdmin, userId: MEMBER.id, sharedBy: ADMIN.email, at: new Date().toISOString() });
    const app = reader(MEMBER);
    const post = (path: string) => app.request(`/api/tasks/${byAdmin}/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ commandId: "cmd-shared-0001", text: "Use our logger." }) });

    // when
    const reads = await Promise.all([app.request("/api/tasks"), app.request(`/api/tasks/${byAdmin}?after=0`), app.request(`/api/tasks/${byAdmin}/events`), app.request(`/api/tasks/${byAdmin}/requests`)]);
    const actions = await Promise.all(["cancel", "keep", "undo", "messages", "requests/req_any"].map(post));

    // then
    expect(reads.map((r) => r.status)).toEqual([200, 200, 200, 200]);
    expect((await reads[0]!.json()).tasks.map((t: { id: string }) => t.id)).toEqual([byAdmin]);
    expect((await reads[1]!.json()).log).toEqual((await (await reader(ADMIN).request(`/api/tasks/${byAdmin}?after=0`)).json()).log);
    expect(actions.map((r) => r.status)).toEqual([404, 404, 404, 404, 404]);
  });

  it("given a running task shared with a member whose page follows its events, when the share is taken back, then the stream ends and a line logged after it never reaches them", async () => {
    // given
    const { ctx, reader, byAdmin } = await twoTasks();
    await ctx.store.updateTask(ctx.tenant, byAdmin, { status: "running" });
    await ctx.store.addTaskShare({ tenant: ctx.tenant, taskId: byAdmin, userId: MEMBER.id, sharedBy: ADMIN.email, at: new Date().toISOString() });
    const stream = (await reader(MEMBER).request(`/api/tasks/${byAdmin}/events`)).body!.getReader();
    await stream.read();

    // when
    await ctx.store.removeTaskShare(ctx.tenant, byAdmin, MEMBER.id);
    await new Promise((r) => setTimeout(r, STREAM_TICK_MS * 2));
    await ctx.store.appendTaskLog(ctx.tenant, byAdmin, ["Said after the share was taken back."]);
    let heard = "";
    for (let part = await stream.read(); !part.done; part = await stream.read()) heard += new TextDecoder().decode(part.value);

    // then
    expect(heard).not.toContain("Said after the share was taken back.");
  });

  it("given tasks on Payments, when the admin, the Payments owner and the starter read them, then each sees what the rule allows", async () => {
    // given
    const { reader, byAdmin, byOwner } = await twoTasks();

    // when
    const titles = async (user: Principal) => ((await (await reader(user).request("/api/tasks")).json()).tasks as { title: string }[]).map((t) => t.title).sort();
    const ownerReadsAdmins = await reader(OWNER_OF_PAYMENTS).request(`/api/tasks/${byAdmin}?after=0`);

    // then
    expect(await titles(ADMIN)).toEqual(["Admin's task", "Owner's task"]);
    expect(await titles(OWNER_OF_PAYMENTS)).toEqual(["Admin's task", "Owner's task"]);
    expect(ownerReadsAdmins.status).toBe(200);
    expect((await ownerReadsAdmins.json()).log.length).toBeGreaterThan(0);
    expect((await reader(ADMIN).request(`/api/tasks/${byOwner}?after=0`)).status).toBe(200);
  });
});

describe("the task list a page at a time", () => {
  it("given more tasks than a page, most of them another team's, when a member pages through the list, then every page is full of their own tasks and each is read once, newest first", async () => {
    // given
    const { ctx, reader } = await twoTasks();
    const template = (await ctx.store.getTask(ctx.tenant, (await ctx.store.taskPage(ctx.tenant, {}, null, 1)).tasks[0]!.id))!;
    const minute = (n: number) => new Date(Date.parse("2026-10-01T00:00:00.000Z") + n * 60_000).toISOString();
    for (let n = 0; n < TASKS_PER_PAGE + 10; n++) {
      await ctx.store.createTask({ ...template, id: `tsk_mine${String(n).padStart(4, "0")}`, title: `Mine ${n}`, createdBy: MEMBER.email, createdAt: minute(n) });
      await ctx.store.createTask({ ...template, id: `tsk_other${String(n).padStart(4, "0")}`, title: `Other ${n}`, team: "Platform", createdBy: "someone@example.invalid", createdAt: minute(n) });
    }

    // when
    const pages: { tasks: { title: string }[]; next: string | null }[] = [];
    for (let after: string | null = null; pages.length < 5 && (!pages.length || after); after = pages.at(-1)!.next) {
      pages.push(await (await reader(MEMBER).request(`/api/tasks${after ? `?after=${after}` : ""}`)).json());
    }

    // then
    expect(pages.map((p) => p.tasks.length)).toEqual([TASKS_PER_PAGE, 10]);
    expect(pages.at(-1)!.next).toBeNull();
    expect(pages.flatMap((p) => p.tasks.map((t) => t.title))).toEqual(Array.from({ length: TASKS_PER_PAGE + 10 }, (_, n) => `Mine ${TASKS_PER_PAGE + 9 - n}`));
  });

  it("given a time to start from and a cursor that is not one, when the list is read, then only tasks since the time come back and the cursor is refused", async () => {
    // given
    const { reader } = await twoTasks();

    // when
    const later = await (await reader(ADMIN).request(`/api/tasks?since=${encodeURIComponent(new Date(Date.now() + 60_000).toISOString())}`)).json();
    const earlier = await (await reader(ADMIN).request("/api/tasks?since=2026-01-01T00:00:00.000Z")).json();
    const badCursor = await reader(ADMIN).request("/api/tasks?after=not-a-cursor");
    const badSince = await reader(ADMIN).request("/api/tasks?since=yesterday");

    // then
    expect(later).toEqual({ tasks: [], next: null });
    expect(earlier.tasks).toHaveLength(2);
    expect(badCursor.status).toBe(400);
    expect(badSince.status).toBe(400);
  });
});

describe("a member and their organization's teams", { timeout: 120_000 }, () => {
  /** The demo's repositories with one task on each team by someone else, read and started through the API by `user`. */
  async function teams(user: Principal) {
    const { ctx, root } = await seededContext("orchestrator-team-tasks-");
    await storePrincipals(ctx, user);
    dirs.push(root);
    ctx.tasks = createTaskRunner(ctx, { agents: [fakeAgentAdapter(FAKE_AGENT)], isolation: { mode: "process", network: "open" }, testCommand: () => null, hostEnv: { PATH: process.env.PATH } });
    const base = { tenant: ctx.tenant, description: "", issueUrl: null, issueKey: null, agent: "fake", status: "needs-review" as const, createdBy: "someone@example.invalid", createdAt: "2026-11-01T10:00:00.000Z", startedAt: null, finishedAt: null, baseSha: null, tests: null, cost: { usd: null, inputTokens: null, outputTokens: null }, requestNumber: null, error: null };
    await ctx.store.createTask({ ...base, id: "tsk_paymentsonly0", repoId: "payments-skills", team: "Payments", title: "A Payments task" });
    await ctx.store.createTask({ ...base, id: "tsk_platformonly0", repoId: "platform-skills", team: "Platform", title: "A Platform task" });
    const app = createApp(ctx, as(user));
    const listed = async () => ((await (await app.request("/api/tasks")).json()).tasks as { title: string }[]).map((t) => t.title).sort();
    const opened = async (id: string) => (await app.request(`/api/tasks/${id}`)).status;
    const start = (repoId: string) => app.request("/api/tasks", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ repoId, title: "Add a note", agent: "fake", description: "stand-in: fail" }) });
    return { ctx, listed, opened, start };
  }

  it("given a member of an organization whose teams are open, when they list tasks and open one someone else started, then neither is theirs to read: a task's page is its team owners', the admins' and its starter's", async () => {
    // given
    const { listed, opened } = await teams({ ...MEMBER, restrictedTeams: [] });

    // when
    const titles = await listed();
    const status = await opened("tsk_paymentsonly0");

    // then
    expect(titles).toEqual([]);
    expect(status).toBe(404);
  });

  it("given a member of an organization whose teams are open, when they open the task form and start a task on a team they do not own, then the form offers that team's repository and the start is taken", async () => {
    // given
    const { ctx, start } = await teams({ ...MEMBER, restrictedTeams: [] });

    // when
    const form = await (await createApp(ctx, as({ ...MEMBER, restrictedTeams: [] })).request("/api/tasks/options")).json();
    const started = await start("payments-skills");
    await ctx.tasks!.idle();

    // then
    expect((form.repos as { id: string }[]).map((r) => r.id)).toContain("payments-skills");
    expect(started.status).toBe(201);
  });

  it("given a member and a team kept to its owners, when they list tasks and start one there, then no task of someone else's is listed and the start is refused", async () => {
    // given
    const { listed, start } = await teams({ ...MEMBER, restrictedTeams: ["Payments"] });

    // when
    const titles = await listed();
    const refused = await start("payments-skills");

    // then
    expect(titles).toEqual([]);
    expect([refused.status, (await refused.json()).error]).toEqual([403, "this team keeps its tasks to its owners"]);
  });
});
