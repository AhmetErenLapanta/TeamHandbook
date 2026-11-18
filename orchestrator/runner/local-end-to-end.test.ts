import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { MiddlewareHandler } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { createUser, principalOf } from "../server/accounts.js";
import { createApp } from "../server/app.js";
import type { OrchestratorContext } from "../server/app.js";
import type { OrchestratorEnv, Principal } from "../server/auth.js";
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


const as = (user: Principal): MiddlewareHandler<OrchestratorEnv> => async (c, next) => {
  c.set("user", user);
  await next();
};

/**
 * A person's own orchestrator as its start wires it, the embedded runner taking the person's tasks, with a stand-in
 * agent that runs `body` in its checkout and answers `answer`; what it was told lands in `heard`, one prompt a run.
 */
async function personal(body: string, answer: string) {
  const { ctx, root } = await seededContext("orchestrator-local-e2e-", ["payments-skills"]);
  dirs.push(root);
  const account = await createUser(ctx.store, ctx.tenant, new Set(["Payments"]), { email: ADA, name: "Ada Example", role: "admin" }, OWNER);
  const heard = join(root, "heard.txt");
  const script = join(root, "agent.mjs");
  writeFileSync(script, `import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";\nconst said = readFileSync(0, "utf8");\nappendFileSync(${JSON.stringify(heard)}, said + "\\n=====\\n");\n${body}\nconsole.log(JSON.stringify({ type: "result", summary: ${JSON.stringify(answer)} }));\n`);
  ctx.tasks = createTaskRunner(ctx, { agents: [fakeAgentAdapter(script)], isolation: { mode: "process", network: "open" }, testCommand: () => null, hostEnv: { PATH: process.env.PATH } });
  await ctx.tasks.ready();
  const service = createRunnerService({ tenant: ctx.tenant, store: ctx.store, onFinished: (id, outcome) => openPushedRequest(ctx, id, outcome) });
  ctx.runnerService = service;
  const runner = await startEmbeddedRunner({ service, person: ADA, holder: "this-machine", executor: ctx.tasks.leased(), dataDir: ctx.dataDir, mask: (t) => t });
  const app = createApp(ctx, as(await principalOf(ctx.store, account)));
  const post = (path: string, body: unknown) => app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const repo = (await ctx.store.getRepo(ctx.tenant, "payments-skills"))!;
  const task: TaskRecord = { tenant: ctx.tenant, id: newId("tsk"), repoId: repo.id, team: repo.team, title: "Add an on-call note", description: "", issueUrl: null, issueKey: null, agent: "fake", status: "queued", createdBy: ADA, createdAt: new Date().toISOString(), startedAt: null, finishedAt: null, baseSha: null, tests: null, cost: UNKNOWN_COST, requestNumber: null, error: null, template: null, mode: "auto", runner: "local" };
  await ctx.store.createTask(task);
  service.wake();
  const prompts = () => readFileSync(heard, "utf8").split("\n=====\n").filter(Boolean);
  return { ctx, repo, task, post, runner, prompts };
}

const settled = (ctx: OrchestratorContext, id: string, check: (t: TaskRecord) => boolean) => until(async () => check((await ctx.store.getTask(ctx.tenant, id))!));

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

  it("given a person's own task whose agent answers without changing a file, when they ask for more and the embedded runner takes it again, then it first finished with nothing changed and its answer, and the next run hears that answer and their words and opens a request", async () => {
    // given
    const { ctx, task, post, runner, prompts } = await personal('if (said.includes("Write the note anyway.")) writeFileSync("ON-CALL.md", "Page the on-call engineer.\\n");', "No change is needed: the handover already lists its steps.");
    await settled(ctx, task.id, (t) => t.status === "nothing-changed");
    const first = (await ctx.store.getTask(ctx.tenant, task.id))!;

    // when
    const sent = await post(`/api/tasks/${task.id}/messages`, { text: "Write the note anyway.", commandId: "e2e-more-0001" });
    await settled(ctx, task.id, (t) => t.requestNumber !== null);

    // then
    expect([first.status, first.lastSaid, sent.status]).toEqual(["nothing-changed", "No change is needed: the handover already lists its steps.", 202]);
    expect(prompts()).toHaveLength(2);
    expect(prompts()[1]).toContain("No change is needed: the handover already lists its steps.");
    expect(prompts()[1]).toContain("Write the note anyway.");
    expect((await ctx.store.getTask(ctx.tenant, task.id))!).toMatchObject({ status: "needs-review" });
    await runner.loop.stop();
  });

  it("given a person's own task whose request they kept through its merge, when they ask for more and the embedded runner takes it again, then the next run starts from the kept change on a branch of its own and opens a second request the task shows", async () => {
    // given
    const { ctx, repo, task, post, runner, prompts } = await personal('if (said.includes("Also name the lead.")) writeFileSync("LEAD.md", "Ada\\n"); else writeFileSync("ON-CALL.md", "Page the on-call engineer.\\n");', "Done.");
    await settled(ctx, task.id, (t) => t.requestNumber !== null && t.status === "needs-review");
    const first = (await ctx.store.getTask(ctx.tenant, task.id))!;
    const kept = (await ctx.store.getRequest(ctx.tenant, repo.id, first.requestNumber!))!;
    const merged = await post(`/api/repos/${repo.id}/requests/${kept.number}/merge`, {});

    // when
    const sent = await post(`/api/tasks/${task.id}/messages`, { text: "Also name the lead.", commandId: "e2e-kept-0001" });
    await settled(ctx, task.id, (t) => t.requestNumber !== null && t.requestNumber !== kept.number && t.status === "needs-review");

    // then
    expect([merged.status, sent.status]).toEqual([200, 202]);
    const now = (await ctx.store.getTask(ctx.tenant, task.id))!;
    expect(now.keptBefore).toBe(true);
    expect(await ctx.store.getRequest(ctx.tenant, repo.id, now.requestNumber!)).toMatchObject({ status: "open", branch: `${kept.branch}-2` });
    expect(await ctx.store.getRequest(ctx.tenant, repo.id, kept.number)).toMatchObject({ status: "merged" });
    expect(prompts()[1]).toContain("The person kept the change the last run made");
    expect(gitMaybe(["show", `refs/heads/${kept.branch}-2:ON-CALL.md`], localRepoPath(repo.url)!)).toBe("Page the on-call engineer.\n");
    await runner.loop.stop();
  });
});
