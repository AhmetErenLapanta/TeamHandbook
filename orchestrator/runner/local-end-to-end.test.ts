import { rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createUser } from "../server/accounts.js";
import type { Principal } from "../server/auth.js";
import { localRepoPath } from "../server/forge/local.js";
import { gitMaybe } from "../server/git.js";
import { newId } from "../server/ids.js";
import { createRunnerService } from "../server/runner-service.js";
import { openPushedRequest } from "../server/tasks/leased.js";
import { fakeAgentAdapter } from "../server/tasks/agents.js";
import { createTaskRunner } from "../server/tasks/runner.js";
import { UNKNOWN_COST } from "../server/tasks/types.js";
import type { TaskRecord } from "../server/tasks/types.js";
import { seededContext } from "../server/test-fixtures.js";
import { startEmbeddedRunner } from "./embedded.js";

const OWNER: Principal = { id: "owner", name: "Owner", email: "owner@example.invalid", role: "owner", ownedTeams: [] };
const ADA = "ada@example.invalid";
const FAKE_AGENT = join(import.meta.dirname, "..", "demo", "fake-agent.mjs");

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const until = async (check: () => Promise<boolean>, ms = 30_000) => {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 100));
  }
};

describe("a local orchestrator with its embedded runner", { timeout: 120_000 }, () => {
  it("given a task its person starts on a repository on this machine, when the embedded runner takes it, then the branch lands in that repository, the request opens and the task waits for review", async () => {
    // given
    const { ctx, root } = await seededContext("orchestrator-local-e2e-", ["payments-skills"]);
    dirs.push(root);
    await createUser(ctx.store, ctx.tenant, new Set(["Payments"]), { email: ADA, name: "Ada Example", role: "admin" }, OWNER);
    ctx.tasks = createTaskRunner(ctx, { agents: [fakeAgentAdapter(FAKE_AGENT)], isolation: { mode: "process", network: "open" }, testCommand: () => null, hostEnv: { PATH: process.env.PATH } });
    await ctx.tasks.ready();
    const service = createRunnerService({ tenant: ctx.tenant, store: ctx.store, onFinished: (id, outcome) => openPushedRequest(ctx, id, outcome) });
    const runner = await startEmbeddedRunner({ service, person: ADA, holder: "this-machine", executor: ctx.tasks.leased(), dataDir: ctx.dataDir, mask: (t) => t });
    const repo = (await ctx.store.getRepo(ctx.tenant, "payments-skills"))!;
    const task: TaskRecord = { tenant: ctx.tenant, id: newId("tsk"), repoId: repo.id, team: repo.team, title: "Add an on-call note", description: "", issueUrl: null, issueKey: null, agent: "fake", status: "queued", createdBy: ADA, createdAt: new Date().toISOString(), startedAt: null, finishedAt: null, baseSha: null, tests: null, cost: UNKNOWN_COST, requestNumber: null, error: null, template: null, mode: "auto", runner: "local" };

    // when
    await ctx.store.createTask(task);
    service.wake();
    await until(async () => (await ctx.store.getTask(ctx.tenant, task.id))!.requestNumber !== null);

    // then
    const done = (await ctx.store.getTask(ctx.tenant, task.id))!;
    expect(done).toMatchObject({ status: "needs-review", runner: "local" });
    expect(await ctx.store.taskLease(ctx.tenant, task.id)).toMatchObject({ leaseId: null });
    const request = (await ctx.store.getRequest(ctx.tenant, repo.id, done.requestNumber!))!;
    expect(request).toMatchObject({ status: "open", provider: "local", createdBy: ADA });
    expect(gitMaybe(["rev-parse", "--verify", `refs/heads/${request.branch}`], localRepoPath(repo.url)!)).not.toBeNull();
    const log = (await ctx.store.taskLog(ctx.tenant, task.id, 0)).map((l) => l.text);
    expect(log).toEqual(expect.arrayContaining([expect.stringContaining("Checked out payments-skills"), expect.stringContaining(`Pushed ${request.branch}`), expect.stringContaining(`Opened request #${done.requestNumber}`)]));
    await runner.loop.stop();
  });

  it("given a task in approval-required, when the agent asks to run a command and its person allows it once in the browser, then the agent goes on, the branch lands and the request opens", async () => {
    // given
    const { ctx, root } = await seededContext("orchestrator-local-e2e-", ["payments-skills"]);
    dirs.push(root);
    await createUser(ctx.store, ctx.tenant, new Set(["Payments"]), { email: ADA, name: "Ada Example", role: "admin" }, OWNER);
    ctx.tasks = createTaskRunner(ctx, { agents: [fakeAgentAdapter(FAKE_AGENT)], isolation: { mode: "process", network: "open" }, testCommand: () => null, hostEnv: { PATH: process.env.PATH } });
    await ctx.tasks.ready();
    const service = createRunnerService({ tenant: ctx.tenant, store: ctx.store, onFinished: (id, outcome) => openPushedRequest(ctx, id, outcome) });
    const runner = await startEmbeddedRunner({ service, person: ADA, holder: "this-machine", executor: ctx.tasks.leased(), dataDir: ctx.dataDir, mask: (t) => t });
    const repo = (await ctx.store.getRepo(ctx.tenant, "payments-skills"))!;
    const task: TaskRecord = { tenant: ctx.tenant, id: newId("tsk"), repoId: repo.id, team: repo.team, title: "Add an on-call note", description: "stand-in: ask Bash npm test", issueUrl: null, issueKey: null, agent: "fake", status: "queued", createdBy: ADA, createdAt: new Date().toISOString(), startedAt: null, finishedAt: null, baseSha: null, tests: null, cost: UNKNOWN_COST, requestNumber: null, error: null, template: null, mode: "approval-required", runner: "local" };

    // when
    await ctx.store.createTask(task);
    service.wake();
    await until(async () => (await ctx.store.taskRequests(ctx.tenant, task.id)).some((r) => r.status === "pending"), 20_000).catch(async (e) => {
      console.error(JSON.stringify({ task: await ctx.store.getTask(ctx.tenant, task.id), log: (await ctx.store.taskLog(ctx.tenant, task.id, 0)).map((l) => l.text), requests: await ctx.store.taskRequests(ctx.tenant, task.id) }, null, 1));
      throw e;
    });
    const [asked] = await ctx.store.taskRequests(ctx.tenant, task.id);
    await ctx.store.answerTaskRequest(ctx.tenant, asked!.id, { decision: "allow_once" }, ADA, "web", new Date().toISOString());
    service.wake();
    await until(async () => (await ctx.store.getTask(ctx.tenant, task.id))!.requestNumber !== null, 20_000).catch(async (e) => {
      console.error(JSON.stringify({ task: await ctx.store.getTask(ctx.tenant, task.id), log: (await ctx.store.taskLog(ctx.tenant, task.id, 0)).map((l) => l.text), requests: await ctx.store.taskRequests(ctx.tenant, task.id) }, null, 1));
      throw e;
    });

    // then
    const done = (await ctx.store.getTask(ctx.tenant, task.id))!;
    expect(done.status).toBe("needs-review");
    expect(asked).toMatchObject({ payload: { tool: "Bash", summary: "npm test" } });
    const request = (await ctx.store.getRequest(ctx.tenant, repo.id, done.requestNumber!))!;
    expect(gitMaybe(["rev-parse", "--verify", `refs/heads/${request.branch}`], localRepoPath(repo.url)!)).not.toBeNull();
    const log = (await ctx.store.taskLog(ctx.tenant, task.id, 0)).map((l) => l.text);
    expect(log).toEqual(expect.arrayContaining([expect.stringContaining("The agent asks to use Bash on npm test"), "Ada Example answered the agent's Bash call: allow-once.", "allowed Bash npm test"]));
    await runner.loop.stop();
  });
});
