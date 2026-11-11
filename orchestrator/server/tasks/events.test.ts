import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MiddlewareHandler } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { seed } from "../../demo/seed.js";
import { createApp, syncRepo } from "../app.js";
import type { OrchestratorContext } from "../app.js";
import { principalOf, setupFirstOwner } from "../accounts.js";
import type { OrchestratorEnv, Principal } from "../auth.js";
import { newId } from "../ids.js";
import { openSqliteStore } from "../store.js";
import { storePrincipals } from "../test-fixtures.js";
import { fakeAgentAdapter } from "./agents.js";
import { AUTH_RECHECK_MS, LOG_PAGE, STREAM_RETRY_MS, STREAM_TICK_MS, STREAMS_PER_PERSON } from "./routes.js";
import { createTaskRunner } from "./runner.js";

const ADMIN: Principal = { id: "a", name: "Ada Example", email: "ada@example.invalid", role: "admin", ownedTeams: [] };
const FAKE_AGENT = join(import.meta.dirname, "..", "..", "demo", "fake-agent.mjs");

const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const as = (user: Principal): MiddlewareHandler<OrchestratorEnv> => async (c, next) => {
  c.set("user", user);
  await next();
};

/** A finished task on the seeded Payments repository, and the app that serves it. */
async function finished() {
  const root = mkdtempSync(join(tmpdir(), "orchestrator-task-events-"));
  dirs.push(root);
  const { configFile } = seed(join(root, "demo"));
  const config = JSON.parse(readFileSync(configFile, "utf8"));
  const ctx: OrchestratorContext = { store: openSqliteStore(":memory:"), dataDir: join(root, "data"), tenant: config.tenant };
  await storePrincipals(ctx, ADMIN);
  const entry = config.repos.find((r: { id: string }) => r.id === "payments-skills");
  await ctx.store.upsertRepo({ ...entry, tenant: config.tenant });
  await syncRepo(ctx, "payments-skills");
  ctx.tasks = createTaskRunner(ctx, { agents: [fakeAgentAdapter(FAKE_AGENT)], isolation: { mode: "process", network: "open" }, testCommand: () => null, hostEnv: { PATH: process.env.PATH } });
  const repo = (await ctx.store.getRepo(ctx.tenant, "payments-skills"))!;
  const task = await ctx.tasks.start({ repo, title: "Add a note", description: "", agent: "fake", user: ADMIN });
  await ctx.tasks.idle();
  return { ctx, app: createApp(ctx, as(ADMIN)), id: task.id };
}

/** The stream's events in order, read until the orchestrator closes it. */
async function events(res: Response): Promise<{ event: string; id?: string; data: unknown }[]> {
  const text = await res.text();
  return text
    .split("\n\n")
    .filter((block) => block.includes("event:"))
    .map((block) => {
      const field = (name: string) => block.split("\n").find((l) => l.startsWith(`${name}: `))?.slice(name.length + 2);
      const id = field("id");
      return { event: field("event")!, ...(id ? { id } : {}), data: JSON.parse(field("data")!) };
    });
}

describe("following a task's log as a stream", () => {
  it("given a finished task, when its stream is opened, then it says it is connected, carries every line and the task, and closes", async () => {
    // given
    const { ctx, app, id } = await finished();
    const lines = await ctx.store.taskLog(ctx.tenant, id, 0);

    // when
    const res = await app.request(`/api/tasks/${id}/events?after=0`);

    // then
    expect(res.headers.get("content-type")).toMatch(/^text\/event-stream/);
    const got = await events(res);
    expect(got.map((e) => e.event)).toEqual(["connected", "log", "task"]);
    expect(got[1]).toEqual({ event: "log", id: String(lines.at(-1)!.seq), data: { log: lines, outputCut: false } });
    expect(got[2]!.data).toMatchObject({ id, status: "needs-review" });
  });

  it("given a task interrupted on its runner, when its stream is opened, then it carries the task as it stands and closes", async () => {
    // given
    const { ctx, app, id } = await finished();
    await ctx.store.updateTask(ctx.tenant, id, { status: "interrupted" });

    // when
    const got = await events(await app.request(`/api/tasks/${id}/events?after=0`));

    // then
    expect(got.map((e) => e.event)).toEqual(["connected", "log", "task"]);
    expect(got[2]!.data).toMatchObject({ id, status: "interrupted" });
  });

  it("given a page that saw part of the log, when it opens the stream again with the last id it saw, then only the lines after it come", async () => {
    // given
    const { ctx, app, id } = await finished();
    const lines = await ctx.store.taskLog(ctx.tenant, id, 0);
    const seen = lines[2]!.seq;

    // when
    const got = await events(await app.request(`/api/tasks/${id}/events`, { headers: { "last-event-id": String(seen) } }));

    // then
    expect((got[1]!.data as { log: { seq: number }[] }).log.map((l) => l.seq)).toEqual(lines.filter((l) => l.seq > seen).map((l) => l.seq));
  });

  it("given an id that is no task, when its stream is asked for, then the answer is 404", async () => {
    const { app } = await finished();
    expect((await app.request("/api/tasks/000000000000/events")).status).toBe(404);
  });
});

describe("a stream opened by someone who no longer holds what let them in", () => {
  /** Ada signed in with a session, following a task still running, with the clock able to jump past the next check. */
  async function following() {
    const store = openSqliteStore(":memory:");
    const ada = await principalOf(store, await setupFirstOwner(store, "acme", "code", { code: "code", email: "ada@example.invalid", password: "correct horse battery" }));
    const root = mkdtempSync(join(tmpdir(), "orchestrator-task-events-"));
    dirs.push(root);
    const ctx: OrchestratorContext = { store, dataDir: root, tenant: "acme" };
    ctx.tasks = createTaskRunner(ctx, { agents: [fakeAgentAdapter(FAKE_AGENT)], isolation: { mode: "process", network: "open" }, testCommand: () => null, hostEnv: { PATH: process.env.PATH } });
    const app = createApp(ctx);
    const login = await app.request("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: ada.email, password: "correct horse battery" }) });
    const cookie = login.headers.getSetCookie()[0]!.split(";")[0]!;
    const at = new Date().toISOString();
    const id = newId("tsk");
    await store.createTask({ tenant: "acme", id, repoId: "payments-skills", team: "Payments", title: "t", description: "", issueUrl: null, issueKey: null, agent: "fake", status: "running", createdBy: ada.id, createdAt: at, startedAt: at, finishedAt: null, baseSha: null, tests: null, cost: { usd: null, inputTokens: null, outputTokens: null }, requestNumber: null, error: null });
    const res = await app.request(`/api/tasks/${id}/events`, { headers: { cookie } });
    const now = Date.now.bind(Date);
    const later = () => vi.spyOn(Date, "now").mockImplementation(() => now() + AUTH_RECHECK_MS + 1);
    return { store, ada, id, res, later };
  }

  it("given Ada following a running task, when her session is ended, then her stream closes at the next check though the task still runs", { timeout: 10_000 }, async () => {
    // given
    const { store, ada, res, later } = await following();

    // when
    await store.deleteSessions("acme", ada.id);
    later();

    // then
    expect((await events(res)).map((e) => e.event)).toEqual(["connected", "task"]);
  });

  it("given Ada following a running task and still signed in, when the check comes and the task then finishes, then her stream carries it to the end", { timeout: 10_000 }, async () => {
    // given
    const { store, id, res, later } = await following();

    // when
    later();
    await store.updateTask("acme", id, { status: "needs-review" });

    // then
    expect((await events(res)).map((e) => [e.event, (e.data as { status?: string }).status])).toEqual([["connected", undefined], ["task", "running"], ["task", "needs-review"]]);
  });

  /** A task running on the seeded repository, its stream readable as it comes. */
  async function running() {
    const { ctx, app, id } = await finished();
    await ctx.store.updateTask(ctx.tenant, id, { status: "running", finishedAt: null });
    return { ctx, app, id };
  }

  it("given a running task followed by a page, when a line is written, then the page has it well before the store's next look", async () => {
    // given
    const { ctx, app, id } = await running();
    const stop = new AbortController();
    const res = await app.request(`/api/tasks/${id}/events?after=${(await ctx.store.taskLog(ctx.tenant, id, 0)).at(-1)!.seq}`, { signal: stop.signal });
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let seen = "";
    const until = async (text: string) => {
      while (!seen.includes(text)) seen += decoder.decode((await reader.read()).value ?? new Uint8Array());
    };
    await until("event: task");

    // when
    const written = Date.now();
    await ctx.store.appendTaskLog(ctx.tenant, id, ["the agent edited runbook.md"]);
    await until("the agent edited runbook.md");
    const took = Date.now() - written;
    stop.abort();

    // then
    expect(seen).toContain(`retry: ${STREAM_RETRY_MS}`);
    expect(took).toBeLessThan(STREAM_TICK_MS / 2);
  });

  it("given one person with a page per tab on a running task, when one tab past the limit opens, then it is told to read the log instead, and a tab closed gives its place back", async () => {
    // given
    const { app, id } = await running();
    // A closed tab drops its connection: the page stops reading and the stream's next write ends it.
    const close = async (tab: Response) => void (await tab.body?.cancel());
    const tabs: Response[] = [];
    for (let n = 0; n < STREAMS_PER_PERSON; n++) tabs.push(await app.request(`/api/tasks/${id}/events`));

    // when
    const past = await app.request(`/api/tasks/${id}/events`);
    await close(tabs[0]!);
    await vi.waitFor(async () => {
      const again = await app.request(`/api/tasks/${id}/events`);
      await close(again);
      expect(again.status).toBe(200);
    }, { timeout: 5_000 });
    for (const tab of tabs.slice(1)) await close(tab);

    // then
    expect(past.status).toBe(503);
  });

  it("given a finished task with a log longer than one page, when it is read as its record, then it comes in pages, each saying where the next starts", async () => {
    // given
    const { ctx, app, id } = await finished();
    await ctx.store.appendTaskLog(ctx.tenant, id, Array.from({ length: LOG_PAGE + 5 }, (_, n) => `line ${n}`));
    const total = (await ctx.store.taskLog(ctx.tenant, id, 0)).length;

    // when
    const first = await (await app.request(`/api/tasks/${id}`)).json();
    const second = await (await app.request(`/api/tasks/${id}?after=${first.next}`)).json();

    // then
    expect([first.log.length, second.log.length, second.next]).toEqual([LOG_PAGE, total - LOG_PAGE, null]);
    expect(second.log[0].seq).toBe(first.next + 1);
  });
});
