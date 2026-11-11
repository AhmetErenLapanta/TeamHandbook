import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { MiddlewareHandler } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { createUser } from "../accounts.js";
import { createApp } from "../app.js";
import { localMachine } from "../local.js";
import type { OrchestratorContext } from "../app.js";
import type { OrchestratorEnv, Principal } from "../auth.js";
import type { RunnerService } from "../runner-service.js";
import { seededContext, storePrincipals } from "../test-fixtures.js";
import { fakeAgentAdapter } from "./agents.js";
import { AUTO_CONTINUE_MAX, AUTO_CONTINUE_SETTING, createTaskRunner, DEFAULT_TASK_LIMITS, wentOnFromKey } from "./runner.js";
import { taskPaths } from "./isolation.js";

const ADMIN: Principal = { id: "a", name: "Ada Example", email: "ada@example.invalid", role: "admin", ownedTeams: [] };
const FAKE_AGENT = join(import.meta.dirname, "..", "..", "demo", "fake-agent.mjs");

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const as = (user: Principal): MiddlewareHandler<OrchestratorEnv> => async (c, next) => {
  c.set("user", user);
  await next();
};

/** An orchestrator with runners: what it asks of the runner service is kept for the test to read. */
async function withRunners({ serverTasks = false } = {}) {
  const { ctx, root } = await seededContext("orchestrator-local-start-", ["payments-skills"]);
  dirs.push(root);
  const asked = { wakes: 0, stops: [] as string[] };
  ctx.runnerService = { wake: () => void asked.wakes++, stop: (id: string) => void asked.stops.push(id) } as unknown as RunnerService;
  ctx.tasks = createTaskRunner(ctx, { agents: [fakeAgentAdapter(FAKE_AGENT)], isolation: { mode: "process", network: "open" }, testCommand: () => null, hostEnv: { PATH: process.env.PATH }, serverTasks });
  const app = createApp(ctx, as(ADMIN));
  const post = (path: string, body: unknown = {}) => app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const start = async () => (await (await post("/api/tasks", { repoId: "payments-skills", title: "Add a note", agent: "fake" })).json()).task as { id: string };
  const get = async (id: string) => (await (await app.request(`/api/tasks/${id}`)).json()).task as { waitingFor: string | null };
  return { ctx, app, asked, post, start, get };
}

const statusOf = async (ctx: OrchestratorContext, id: string) => (await ctx.store.getTask(ctx.tenant, id))!;

describe("a task for the starter's own machine", { timeout: 120_000 }, () => {
  it("given a team's orchestrator and a starter with no machine connected, when a task starts, then it waits for their machine and says so, the runners are woken, and this process runs nothing", async () => {
    // given
    const { ctx, asked, start, get } = await withRunners();

    // when
    const task = await start();
    await ctx.tasks!.idle();

    // then
    expect(await statusOf(ctx, task.id)).toMatchObject({ runner: "local", status: "queued", startedAt: null });
    expect((await get(task.id)).waitingFor).toBe("connect");
    expect(asked.wakes).toBe(1);
    expect((await ctx.store.taskLog(ctx.tenant, task.id, 0)).map((l) => l.text)).toEqual([`${ADMIN.name} has no machine connected to this orchestrator, so the task waits for one; it starts once they connect their machine.`]);
  });

  it.each([
    ["seen a moment ago", 1_000, null, []],
    ["away for ten minutes", 600_000, "machine", [`${ADMIN.name}'s machine is not reaching this orchestrator now, so the task waits for it; it starts once the machine is back.`]],
  ])("given a starter whose machine was %s, when a task starts, then the task says whether that machine can take it", async (_case, ago, waitingFor, said) => {
    // given
    const { ctx, start, get } = await withRunners();
    const owner = { id: "owner", name: "Owner", email: "owner@example.invalid", role: "owner" as const, ownedTeams: [] };
    const account = await createUser(ctx.store, ctx.tenant, new Set(), { email: ADMIN.email, name: ADMIN.name, role: "admin" }, owner);
    const seen = new Date(Date.now() - ago).toISOString();
    await ctx.store.insertMachine({ tenant: ctx.tenant, id: "mch_laptop", userId: account.id, name: "laptop", platform: "darwin", publicKey: "", agents: [], createdAt: seen, lastSeenAt: seen, revokedAt: null, tokenHash: "0".repeat(64) }, null);

    // when
    const task = await start();

    // then
    expect((await get(task.id)).waitingFor).toBe(waitingFor);
    expect((await ctx.store.taskLog(ctx.tenant, task.id, 0)).map((l) => l.text)).toEqual(said);
  });

  it("given a starter whose machine reports Claude Code alone, when the form asks what can run and tasks start, then only Claude Code is offered, a start with another agent is refused before a task exists, and one with Claude Code starts", async () => {
    // given
    const { ctx, app, post } = await withRunners();
    const seen = new Date().toISOString();
    await ctx.store.insertMachine({ tenant: ctx.tenant, id: "mch_laptop", userId: ADMIN.id, name: "laptop", platform: "darwin", publicKey: "", agents: [{ id: "claude-code", installed: true, version: "2.1.0", supported: "ok", signIn: "signed-in" }], createdAt: seen, lastSeenAt: seen, revokedAt: null, tokenHash: "0".repeat(64) }, null);

    // when
    const options = (await (await app.request("/api/tasks/options")).json()) as { agents: { id: string; readiness: { ready: boolean } }[] };
    const refused = await post("/api/tasks", { repoId: "payments-skills", title: "Add a note", agent: "fake" });
    const refusedBody = await refused.json();
    const kept = (await ctx.store.listTasks(ctx.tenant)).length;
    const started = await post("/api/tasks", { repoId: "payments-skills", title: "Add a note", agent: "claude-code" });

    // then
    expect(options.agents.map((a) => [a.id, a.readiness.ready])).toEqual([["claude-code", true]]);
    expect([refused.status, refusedBody.code, kept]).toEqual([409, "agent-not-on-machine", 0]);
    expect([started.status, started.ok ? null : await started.json()]).toEqual([201, null]);
    expect((await ctx.store.listTasks(ctx.tenant)).map((t) => t.agent)).toEqual(["claude-code"]);
  });

  it("given one person's orchestrator with its own machine row, which reports no agents, when a task starts, then its own agents are offered, its own runner takes it and nothing says it waits for a machine", async () => {
    // given
    const { ctx, app, start, get } = await withRunners();
    ctx.mode = "local";
    await localMachine(ctx.store, ctx.tenant, ADMIN);

    // when
    const offered = (await (await app.request("/api/tasks/options")).json()).agents as { id: string }[];
    const task = await start();

    // then
    expect(offered.map((a) => a.id)).toContain("fake");
    expect((await get(task.id)).waitingFor).toBeNull();
    expect(await ctx.store.taskLog(ctx.tenant, task.id, 0)).toEqual([]);
  });

  it("given such tasks waiting, running and interrupted, when each is cancelled, then the waiting and the interrupted end here and the running one's runner is asked to stop it", async () => {
    // given
    const { ctx, asked, post, start } = await withRunners();
    const [waiting, running, interrupted] = [await start(), await start(), await start()];
    await ctx.store.updateTask(ctx.tenant, running.id, { status: "running" });
    await ctx.store.updateTask(ctx.tenant, interrupted.id, { status: "interrupted" });

    // when
    const answers = await Promise.all([waiting, running, interrupted].map((t) => post(`/api/tasks/${t.id}/cancel`)));

    // then
    expect(answers.map((r) => r.status)).toEqual([200, 200, 200]);
    expect((await statusOf(ctx, waiting.id)).status).toBe("cancelled");
    expect((await statusOf(ctx, interrupted.id)).status).toBe("cancelled");
    expect((await statusOf(ctx, running.id)).status).toBe("running");
    expect(asked.stops).toEqual([running.id]);
  });

  it("given a task interrupted on its starter's laptop with the agent's session kept, when the starter asks it to go on and asks again, then it waits in line again for that laptop alone with its session, the second ask gets the same answer, and a later ask, another person's or one on a disconnected machine is refused", async () => {
    // given
    const { ctx, app, start } = await withRunners();
    const seen = new Date().toISOString();
    const later = (s: number) => new Date(Date.now() + s * 1000).toISOString();
    const machine = (id: string) => ctx.store.insertMachine({ tenant: ctx.tenant, id, userId: ADMIN.id, name: id, platform: "darwin", publicKey: "", agents: [], createdAt: seen, lastSeenAt: seen, revokedAt: null, tokenHash: id.padEnd(64, "0") }, null);
    await machine("mch_laptop");
    await machine("mch_desktop");
    const cutOff = async (holder: string) => {
      const task = await start();
      const lease = `lease_${holder}`;
      expect((await ctx.store.claimLocalTask(ctx.tenant, ADMIN.email, holder, lease, later(90), seen))?.task.id).toBe(task.id);
      await ctx.store.updateLeasedTask(ctx.tenant, task.id, lease, { nativeSession: `session-${holder}` });
      await ctx.store.finishLeasedTask(ctx.tenant, task.id, lease, { status: "interrupted", error: "The machine stopped.", nativeSession: null, branch: null }, seen);
      return task;
    };
    const task = await cutOff("mch_laptop");
    const continued = (id: string, commandId: string, from = app) => from.request(`/api/tasks/${id}/continue`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ commandId }) });

    // when
    const first = await continued(task.id, "continue-0001");
    const again = await continued(task.id, "continue-0001");
    const another = await continued(task.id, "continue-0002");
    const byOther = await continued(task.id, "continue-0003", createApp(ctx, as({ ...ADMIN, id: "b", email: "bo@example.invalid", name: "Bo Example" })));
    const elsewhere = await ctx.store.claimLocalTask(ctx.tenant, ADMIN.email, "mch_desktop", "lease_2", later(90), later(1));
    const there = await ctx.store.claimLocalTask(ctx.tenant, ADMIN.email, "mch_laptop", "lease_3", later(90), later(1));
    const gone = await cutOff("mch_desktop");
    await ctx.store.revokeMachine(ctx.tenant, "mch_desktop", later(2));
    const onGone = await continued(gone.id, "continue-0004");

    // then
    expect([first.status, (await first.json()).task.status]).toEqual([200, "queued"]);
    expect([again.status, (await again.json()).task.status]).toEqual([200, "queued"]);
    expect(await ctx.store.taskLog(ctx.tenant, task.id, 0).then((lines) => lines.filter((l) => l.text.includes("go on where it stopped")).length)).toBe(1);
    expect([another.status, (await another.json()).code]).toEqual([409, "not-interrupted"]);
    expect(byOther.status).toBe(404);
    expect(elsewhere).toBeNull();
    expect(there?.task.id).toBe(task.id);
    expect((await ctx.store.taskLease(ctx.tenant, task.id))?.nativeSession).toBe("session-mch_laptop");
    expect([onGone.status, (await onGone.json()).code]).toEqual([409, "machine-gone"]);
    expect((await statusOf(ctx, gone.id)).status).toBe("interrupted");
  });

  it("given a task its machine ran when the orchestrator restarted, when restarts cut it off again and again and its starter continues it, then it goes back in line by itself three times in a row, waits for Continue after that, counts again from its starter's Continue, and stays put while the setting is off", async () => {
    // given
    const { ctx, app, start } = await withRunners();
    const seen = new Date().toISOString();
    const later = (s: number) => new Date(Date.now() + s * 1000).toISOString();
    await ctx.store.insertMachine({ tenant: ctx.tenant, id: "mch_here", userId: ADMIN.id, name: "here", platform: "darwin", publicKey: "", agents: [], createdAt: seen, lastSeenAt: seen, revokedAt: null, tokenHash: "1".repeat(64) }, null);
    const task = await start();
    let n = 0;
    const restart = async () => {
      const lease = `lease_${++n}`;
      expect((await ctx.store.claimLocalTask(ctx.tenant, ADMIN.email, "mch_here", lease, later(90), seen))?.task.id).toBe(task.id);
      await ctx.store.finishLeasedTask(ctx.tenant, task.id, lease, { status: "interrupted", error: "The orchestrator stopped before this task finished.", nativeSession: null, branch: null }, seen);
      return ctx.tasks!.autoContinue("mch_here");
    };

    // when
    const byItself = [await restart(), await restart(), await restart()];
    const fourth = await restart();
    const waiting = (await statusOf(ctx, task.id)).status;
    const continued = await app.request(`/api/tasks/${task.id}/continue`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ commandId: "continue-0001" }) });
    const continuedAs = [continued.status, (await continued.json()).task?.status];
    const afterContinue = await restart();
    await ctx.store.setSetting(ctx.tenant, AUTO_CONTINUE_SETTING, "off");
    const turnedOff = await restart();

    // then
    expect(byItself).toEqual([[task.id], [task.id], [task.id]]);
    expect(fourth).toEqual([]);
    expect(waiting).toBe("interrupted");
    expect(continuedAs).toEqual([200, "queued"]);
    expect(afterContinue).toEqual([task.id]);
    expect(turnedOff).toEqual([]);
    expect((await statusOf(ctx, task.id)).status).toBe("interrupted");
    const lines = (await ctx.store.taskLog(ctx.tenant, task.id, 0)).map((l) => l.text);
    expect(lines.filter((l) => l.startsWith("The task's machine stopped running it; it goes on by itself"))).toHaveLength(4);
    expect(lines.filter((l) => l === `The task's machine stopped running it ${AUTO_CONTINUE_MAX} times in a row, so it waits for Continue.`)).toHaveLength(1);
  });

  it("given a task cut off on its machine while going on from its request, and a push to that request since, when its machine calls in again, then it does not go on by itself and says why, once", async () => {
    // given
    const { ctx, start } = await withRunners();
    const now = new Date().toISOString();
    await ctx.store.insertMachine({ tenant: ctx.tenant, id: "mch_laptop", userId: ADMIN.id, name: "laptop", platform: "darwin", publicKey: "", agents: [], createdAt: now, lastSeenAt: now, revokedAt: null, tokenHash: "3".repeat(64) }, null);
    const task = await start();
    await ctx.store.saveRequest({ tenant: ctx.tenant, repoId: "payments-skills", number: 7, provider: "local", url: "local://requests/payments-skills/7", branch: "handbook/add-a-note", headSha: "b".repeat(40), title: "Add a note", status: "open", createdAt: now, createdBy: ADMIN.email });
    await ctx.store.recordRequestCheck(ctx.tenant, "payments-skills", 7, { head: "b".repeat(40), passed: true });
    await ctx.store.updateTask(ctx.tenant, task.id, { requestNumber: 7 });
    await ctx.store.setSetting(ctx.tenant, wentOnFromKey(task.id), "a".repeat(40));
    expect((await ctx.store.claimLocalTask(ctx.tenant, ADMIN.email, "mch_laptop", "lease_1", new Date(Date.now() + 90_000).toISOString(), now))?.task.id).toBe(task.id);
    await ctx.store.finishLeasedTask(ctx.tenant, task.id, "lease_1", { status: "interrupted", error: "The machine stopped.", nativeSession: "session-1", branch: null }, now);

    // when
    const first = await ctx.tasks!.autoContinueAlive();
    const second = await ctx.tasks!.autoContinueAlive();

    // then
    expect([first, second]).toEqual([[], []]);
    expect((await statusOf(ctx, task.id)).status).toBe("interrupted");
    const said = (await ctx.store.taskLog(ctx.tenant, task.id, 0)).map((l) => l.text).filter((l) => l.includes("its request's branch moved"));
    expect(said).toEqual(["The task's machine stopped running it, and its request's branch moved since the run went on from it, so it waits for Continue."]);
  });

  it("given tasks running on a machine, one past its cost and one whose run passed its time, one continued long after it first started and one past its time waiting on its starter's card, when the limits are held, then the two stop as cancelled with the limit as their one reason and the other two run on", async () => {
    // given
    const { ctx, app, start } = await withRunners();
    const now = new Date();
    const at = (minutesAgo: number) => new Date(now.getTime() - minutesAgo * 60_000).toISOString();
    await ctx.store.insertMachine({ tenant: ctx.tenant, id: "mch_laptop", userId: ADMIN.id, name: "laptop", platform: "darwin", publicKey: "", agents: [], createdAt: at(300), lastSeenAt: at(0), revokedAt: null, tokenHash: "4".repeat(64) }, null);
    const put = (body: unknown) => app.request("/api/settings/task-limits", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const defaults = await (await app.request("/api/settings/task-limits")).json();
    const refused = await put({ maxUsd: -1, maxMinutes: 60 });
    const set = await (await put({ maxUsd: 2, maxMinutes: 30 })).json();
    const claimed = async (lease: string, startedMinutesAgo: number) => {
      const task = await start();
      expect((await ctx.store.claimLocalTask(ctx.tenant, ADMIN.email, "mch_laptop", lease, new Date(now.getTime() + 90_000).toISOString(), at(startedMinutesAgo)))?.task.id).toBe(task.id);
      return task;
    };
    const costly = await claimed("lease_cost", 1);
    await ctx.store.updateLeasedTask(ctx.tenant, costly.id, "lease_cost", { addCost: { usd: 2.4, inputTokens: null, outputTokens: null } });
    const slow = await claimed("lease_slow", 45);
    const continued = await claimed("lease_cont", 2);
    await ctx.store.updateTask(ctx.tenant, continued.id, { startedAt: at(600) });
    const waiting = await claimed("lease_wait", 45);
    await ctx.store.recordTaskRequest({ tenant: ctx.tenant, id: "req_waiting", taskId: waiting.id, targetPosition: null, sourceKey: "req_waiting", kind: "command", payload: { tool: "WebFetch", target: "https://example.invalid" }, createdAt: at(5), expiresAt: new Date(now.getTime() + 600_000).toISOString() });

    // when
    const stopped = await ctx.tasks!.enforceLimits();
    await ctx.store.finishLeasedTask(ctx.tenant, costly.id, "lease_cost", { status: "interrupted", error: "Stopped by the person who started the task.", nativeSession: null, branch: null }, now.toISOString());
    await ctx.store.finishLeasedTask(ctx.tenant, slow.id, "lease_slow", { status: "interrupted", error: "Stopped by the person who started the task.", nativeSession: null, branch: null }, now.toISOString());

    // then
    expect(defaults).toEqual(DEFAULT_TASK_LIMITS);
    expect(refused.status).toBe(400);
    expect(set).toEqual({ maxUsd: 2, maxMinutes: 30 });
    expect(stopped.sort()).toEqual([costly.id, slow.id].sort());
    expect(await statusOf(ctx, costly.id)).toMatchObject({ status: "cancelled", error: "Stopped at the $2.00 cost cap for this task." });
    expect(await statusOf(ctx, slow.id)).toMatchObject({ status: "cancelled", error: "Stopped at the 30-minute cap for this task." });
    expect((await statusOf(ctx, continued.id)).status).toBe("running");
    expect((await statusOf(ctx, waiting.id)).status).toBe("running");
  });

  it("given an interrupted task whose run put a plan to its starter that nobody answered, when they continue it approving the plan, and continue one with no plan the same way, then the next run gets the plan as approved and the log keeps it, and the other is refused", async () => {
    // given
    const { ctx, app, start } = await withRunners();
    const now = new Date();
    await ctx.store.insertMachine({ tenant: ctx.tenant, id: "mch_plan", userId: ADMIN.id, name: "laptop", platform: "darwin", publicKey: "", agents: [], createdAt: now.toISOString(), lastSeenAt: now.toISOString(), revokedAt: null, tokenHash: "6".repeat(64) }, null);
    const stopped = async (lease: string) => {
      const task = await start();
      await ctx.store.claimLocalTask(ctx.tenant, ADMIN.email, "mch_plan", lease, new Date(now.getTime() + 90_000).toISOString(), now.toISOString());
      return task;
    };
    const planned = await stopped("lease_plan");
    await ctx.store.recordTaskRequest({ tenant: ctx.tenant, id: "req_plan", taskId: planned.id, targetPosition: null, sourceKey: "plan-1", kind: "plan", payload: { tool: "ExitPlanMode", summary: "Add the note", plan: "# Add the note\n1. Edit README.md" }, createdAt: now.toISOString(), expiresAt: null });
    await ctx.store.finishLeasedTask(ctx.tenant, planned.id, "lease_plan", { status: "interrupted", error: "The orchestrator stopped before this task finished.", nativeSession: null, branch: null }, now.toISOString());
    const plain = await stopped("lease_plain");
    await ctx.store.finishLeasedTask(ctx.tenant, plain.id, "lease_plain", { status: "interrupted", error: "The orchestrator stopped before this task finished.", nativeSession: null, branch: null }, now.toISOString());
    const go = (id: string, commandId: string) => app.request(`/api/tasks/${id}/continue`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ commandId, approvePlan: true }) });

    // when
    const approved = await go(planned.id, "continue-plan-01");
    const refused = await go(plain.id, "continue-plan-02");

    // then
    expect(approved.status).toBe(200);
    expect((await ctx.store.pendingFollowUps(ctx.tenant, planned.id)).map((f) => f.text)).toEqual([expect.stringContaining("1. Edit README.md")]);
    expect((await ctx.store.taskLog(ctx.tenant, planned.id, 0)).map((l) => l.text)).toEqual(expect.arrayContaining(["## Plan", "1. Edit README.md"]));
    expect([refused.status, (await refused.json()).code]).toEqual([409, "no-plan"]);
  });

  it("given a task that failed before its plan was answered, its plan asked for in the older way with no text, when it is read, approved with nothing to read, then with its plan file on disk, and with the plan its page shows, then it offers the plan once the file is there and goes back in line from the plan the page sent", async () => {
    // given
    const { ctx, app, start } = await withRunners();
    const now = new Date();
    await ctx.store.insertMachine({ tenant: ctx.tenant, id: "mch_old", userId: ADMIN.id, name: "laptop", platform: "darwin", publicKey: "", agents: [], createdAt: now.toISOString(), lastSeenAt: now.toISOString(), revokedAt: null, tokenHash: "7".repeat(64) }, null);
    const task = await start();
    await ctx.store.claimLocalTask(ctx.tenant, ADMIN.email, "mch_old", "lease_old", new Date(now.getTime() + 90_000).toISOString(), now.toISOString());
    await ctx.store.recordTaskRequest({ tenant: ctx.tenant, id: "req_old", taskId: task.id, targetPosition: null, sourceKey: "old-1", kind: "permission", payload: { tool: "ExitPlanMode", summary: "ExitPlanMode" }, createdAt: now.toISOString(), expiresAt: null });
    await ctx.store.finishLeasedTask(ctx.tenant, task.id, "lease_old", { status: "failed", error: "The agent ran past its time limit of 30 minutes and was stopped.", nativeSession: null, branch: null }, now.toISOString());
    const go = (commandId: string, plan?: string) => app.request(`/api/tasks/${task.id}/continue`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ commandId, approvePlan: true, ...(plan ? { plan } : {}) }) });
    const offered = async () => (await (await app.request(`/api/tasks/${task.id}`)).json()).task.planToApprove;

    // when
    const before = await offered();
    const nothing = await go("continue-old-01");
    const plans = join(taskPaths(ctx.dataDir, ctx.tenant, task.id).work, ".orchestrator-plans");
    mkdirSync(plans, { recursive: true });
    writeFileSync(join(plans, "add-the-note.md"), "# Add the note\n1. Edit README.md\n");
    const withFile = await offered();
    const shown = await go("continue-old-02", "# Add the note\n1. Edit README.md, then the changelog");

    // then
    expect([before, (await nothing.json()).code, withFile]).toEqual([false, "no-plan", true]);
    expect(shown.status).toBe(200);
    expect(await statusOf(ctx, task.id)).toMatchObject({ status: "queued", error: null });
    expect((await ctx.store.pendingFollowUps(ctx.tenant, task.id)).map((f) => f.text)).toEqual([expect.stringContaining("1. Edit README.md, then the changelog")]);
  });

  it("given a task running on a machine that has spent $0.10 and a cap of $0.30, when its turn's estimate comes at $0.15 and then at $0.25, then the first leaves it running and the second stops it at the cap, saying the cost was an estimate", async () => {
    // given
    const { ctx, app, start } = await withRunners();
    const now = new Date();
    await ctx.store.insertMachine({ tenant: ctx.tenant, id: "mch_laptop", userId: ADMIN.id, name: "laptop", platform: "darwin", publicKey: "", agents: [], createdAt: now.toISOString(), lastSeenAt: now.toISOString(), revokedAt: null, tokenHash: "5".repeat(64) }, null);
    await app.request("/api/settings/task-limits", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ maxUsd: 0.3, maxMinutes: 60 }) });
    const task = await start();
    await ctx.store.claimLocalTask(ctx.tenant, ADMIN.email, "mch_laptop", "lease_spend", new Date(now.getTime() + 90_000).toISOString(), now.toISOString());
    await ctx.store.updateLeasedTask(ctx.tenant, task.id, "lease_spend", { addCost: { usd: 0.1, inputTokens: null, outputTokens: null } });

    // when
    const under = await ctx.tasks!.holdSpend(task.id, 0.15);
    const over = await ctx.tasks!.holdSpend(task.id, 0.25);
    await ctx.store.finishLeasedTask(ctx.tenant, task.id, "lease_spend", { status: "interrupted", error: "Stopped by the person who started the task.", nativeSession: null, branch: null }, now.toISOString());

    // then
    expect([under, over]).toEqual([false, true]);
    expect(await statusOf(ctx, task.id)).toMatchObject({ status: "cancelled", error: "Stopped at the $0.30 cost cap for this task. The cost so far is an estimate made while it ran." });
  });

  it("given a task on its starter's machine that stopped to ask, when the starter answers, answers again and someone else answers, then the first answer is kept masked and the task goes back in line, and the others are refused", async () => {
    // given
    const { ctx, app, start } = await withRunners();
    const task = await start();
    await ctx.store.updateTask(ctx.tenant, task.id, { status: "failed", error: "The agent stopped to ask you: Can you paste the issue's text?", question: { text: "Can you paste the issue's text?", options: ["Paste it here", "Skip the issue"] } });
    const answer = (words: string, from = app) => from.request(`/api/tasks/${task.id}/answer`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ answer: words }) });

    // when
    const first = await answer("The refund lookup takes an order id.\nIts token is ghp_0123456789abcdefghijklmnopqrstuvwxyzAB");
    const again = await answer("Another answer");
    const other = await answer("From someone else", createApp(ctx, as({ ...ADMIN, id: "b", email: "bo@example.invalid", name: "Bo Example" })));

    // then
    expect(first.status).toBe(200);
    const now = await statusOf(ctx, task.id);
    expect(now).toMatchObject({ status: "queued", error: null, question: { text: "Can you paste the issue's text?", answer: expect.stringContaining("The refund lookup takes an order id") } });
    expect(now.question!.answer).not.toContain("ghp_0123456789");
    expect([again.status, (await again.json()).code]).toEqual([409, "no-question"]);
    expect(other.status).toBe(404);
    expect((await ctx.store.taskLog(ctx.tenant, task.id, 0)).map((l) => l.text).some((l) => l.startsWith("Ada Example answered the agent's question:"))).toBe(true);
  });

  it("given a task whose laptop slept past its lease and one whose machine stays away, when the leases run out and the laptop calls in again, then the laptop's task goes on by itself and the other waits", async () => {
    // given
    const { ctx, start } = await withRunners();
    const longAgo = new Date(Date.now() - 10 * 60_000).toISOString();
    const now = new Date().toISOString();
    const machine = (id: string, lastSeenAt: string) => ctx.store.insertMachine({ tenant: ctx.tenant, id, userId: ADMIN.id, name: id, platform: "darwin", publicKey: "", agents: [], createdAt: longAgo, lastSeenAt, revokedAt: null, tokenHash: id.padEnd(64, "0") }, null);
    await machine("mch_laptop", longAgo);
    await machine("mch_desktop", longAgo);
    const held = async (holder: string) => {
      const task = await start();
      // A lease that ran out a minute ago: its runner never reported a stop.
      expect((await ctx.store.claimLocalTask(ctx.tenant, ADMIN.email, holder, `lease_${holder}`, new Date(Date.now() - 60_000).toISOString(), longAgo))?.task.id).toBe(task.id);
      return task;
    };
    const slept = await held("mch_laptop");
    const away = await held("mch_desktop");
    await ctx.store.expireLeases(now);
    await ctx.store.touchMachine(ctx.tenant, "mch_laptop", now);

    // when
    const going = await ctx.tasks!.autoContinueAlive();

    // then
    expect(going).toEqual([slept.id]);
    expect([(await statusOf(ctx, slept.id)).status, (await statusOf(ctx, away.id)).status]).toEqual(["queued", "interrupted"]);
    expect((await ctx.store.taskLog(ctx.tenant, slept.id, 0)).map((l) => l.text)).toContain(`The task's machine stopped running it; it goes on by itself (1 of ${AUTO_CONTINUE_MAX} in a row).`);
  });

  it("given tasks stopped cleanly with this orchestrator's own runner, and one on a person's machine that went away, when the orchestrator starts again, then its own go on by themselves and each says what stopped it", async () => {
    // given
    const { ctx, app, start } = await withRunners();
    ctx.mode = "local";
    const own = await localMachine(ctx.store, ctx.tenant, ADMIN);
    const seen = new Date().toISOString();
    await ctx.store.insertMachine({ tenant: ctx.tenant, id: "mch_laptop", userId: ADMIN.id, name: "laptop", platform: "darwin", publicKey: "", agents: [], createdAt: seen, lastSeenAt: seen, revokedAt: null, tokenHash: "2".repeat(64) }, null);
    const later = new Date(Date.now() + 90_000).toISOString();
    const cutOff = async (holder: string) => {
      const task = await start();
      const lease = `lease_${task.id}`;
      expect((await ctx.store.claimLocalTask(ctx.tenant, ADMIN.email, holder, lease, later, seen))?.task.id).toBe(task.id);
      await ctx.store.finishLeasedTask(ctx.tenant, task.id, lease, { status: "interrupted", error: "The task stopped when its runner stopped.", nativeSession: null, branch: null }, seen);
      return task;
    };
    const here = await cutOff(own.id);
    const away = await cutOff("mch_laptop");
    const shownBefore = async (id: string) => (await (await app.request(`/api/tasks/${id}`)).json()).task.interruptedBy;
    const before = [await shownBefore(here.id), await shownBefore(away.id)];

    // when
    const going = await ctx.tasks!.autoContinue(own.id);

    // then
    expect(before).toEqual(["restart", "machine"]);
    expect(going).toEqual([here.id]);
    expect([(await statusOf(ctx, here.id)).status, (await statusOf(ctx, away.id)).status]).toEqual(["queued", "interrupted"]);
  });

  it("given a team's orchestrator that keeps tasks for machines, when a task over several repositories starts, then it is refused with what to do instead and no task is kept", async () => {
    // given
    const { ctx, post } = await withRunners();

    // when
    const res = await post("/api/tasks", { repoId: "payments-skills", title: "Show the order total", agent: "fake", targets: "orchestrator", issueUrl: "https://tracker.example.com/browse/PAY-142" });

    // then
    expect([res.status, await res.json()]).toEqual([409, { error: "This kind of task runs on the orchestrator itself, which this one does not do; start it as one task per project, or ask an owner to turn on server tasks.", code: "runs-on-orchestrator" }]);
    expect(await ctx.store.listTasks(ctx.tenant)).toEqual([]);
  });

  it("given an orchestrator set to run tasks itself, when a task starts, then it runs here as before", async () => {
    // given
    const { ctx, asked, start } = await withRunners({ serverTasks: true });
    await storePrincipals(ctx, ADMIN);

    // when
    const task = await start();
    await ctx.tasks!.idle();

    // then
    expect(await statusOf(ctx, task.id)).toMatchObject({ status: "needs-review" });
    expect((await statusOf(ctx, task.id)).runner).toBeUndefined();
    expect(asked.wakes).toBe(0);
  });
});
