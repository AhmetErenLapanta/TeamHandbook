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
import type { AgentCodec, AgentEvent } from "../server/tasks/adapters/contract.js";
import { fakeAgentAdapter } from "../server/tasks/agents.js";
import type { AgentAdapter } from "../server/tasks/agents.js";
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

/** A stand-in for an agent in a session: its first run waits for an interrupt, ends that turn, and then stays for more words or ends, as told; any later turn adds a line to notes.md. */
const SESSION_AGENT = [
  'import { appendFileSync, existsSync, writeFileSync } from "node:fs";',
  'import { createInterface } from "node:readline";',
  'const [marker, stays] = process.argv.slice(2);',
  'const done = () => console.log(JSON.stringify({ type: "result", summary: "Done." }));',
  'const later = existsSync(marker);',
  'let stopped = false;',
  'for await (const line of createInterface({ input: process.stdin })) {',
  '  if (line === "interrupt") { stopped = true; done(); if (stays !== "stays") process.exit(0); continue; }',
  '  if (!line.startsWith("turn ")) continue;',
  '  if (!later && !stopped) { writeFileSync(marker, "1"); continue; }',
  '  appendFileSync("notes.md", "More.\\n"); done();',
  '}',
].join("\n");

const sessionCodec = (): AgentCodec => ({
  decode: (line): AgentEvent[] => (line.startsWith("{") ? [{ type: "turn_finished", ok: true, summary: "Done.", reason: null, turns: 1 }] : []),
  finish: (code) => ({ type: "terminal", status: code === 0 ? "completed" : "failed", summary: "" }),
  turn: (text) => `turn ${JSON.stringify(text)}`,
  answer: () => null,
  grantKey: () => null,
  pending: () => [],
  interrupt: () => "interrupt",
  compact: () => "compact",
});

/** A person's own orchestrator whose embedded runner has taken a task with the session agent, and that task's step stopped. */
async function stoppedStep(stays: "stays" | "ends") {
  const { ctx, root } = await seededContext("orchestrator-local-stop-", ["payments-skills"]);
  dirs.push(root);
  const account = await createUser(ctx.store, ctx.tenant, new Set(["Payments"]), { email: ADA, name: "Ada Example", role: "admin" }, OWNER);
  const program = join(root, "session-agent.mjs");
  writeFileSync(program, SESSION_AGENT);
  const stand = fakeAgentAdapter(FAKE_AGENT);
  const agent: AgentAdapter = { ...stand, twoWay: { capabilities: { ...stand.capabilities, approvals: true, steer: true, permissionModes: ["approval-required", "auto"] }, launch: (_paths, _setup, { mode }) => ({ call: { program: process.execPath, args: [program, join(root, "marker"), stays] }, codec: sessionCodec(), mode, notes: [] }) } };
  ctx.tasks = createTaskRunner(ctx, { agents: [agent], isolation: { mode: "process", network: "open" }, testCommand: () => null, hostEnv: { PATH: process.env.PATH } });
  await ctx.tasks.ready();
  const service = createRunnerService({ tenant: ctx.tenant, store: ctx.store, onFinished: (id, outcome) => openPushedRequest(ctx, id, outcome) });
  ctx.runnerService = service;
  const runner = await startEmbeddedRunner({ service, person: ADA, holder: "this-machine", executor: ctx.tasks.leased(), dataDir: ctx.dataDir, mask: (t) => t });
  const app = createApp(ctx, as(await principalOf(ctx.store, account)));
  const post = (path: string, body: unknown) => app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const repo = (await ctx.store.getRepo(ctx.tenant, "payments-skills"))!;
  const task: TaskRecord = { tenant: ctx.tenant, id: newId("tsk"), repoId: repo.id, team: repo.team, title: "Add an on-call note", description: "", issueUrl: null, issueKey: null, agent: "fake", status: "queued", createdBy: ADA, createdAt: new Date().toISOString(), startedAt: null, finishedAt: null, baseSha: null, tests: null, cost: UNKNOWN_COST, requestNumber: null, error: null, runner: "local", mode: "approval-required" };
  await ctx.store.createTask(task);
  service.wake();
  // The run is working before its agent's session is open; a stop then is told there is no session yet.
  await until(async () => (await post(`/api/tasks/${task.id}/stop-step`, {})).status === 200);
  const shown = async () => (await (await app.request(`/api/tasks/${task.id}`)).json()).task as { status: string; stage?: string; state: string };
  return { ctx, task, post, runner, shown };
}

describe("a local orchestrator with its embedded runner", { timeout: 120_000 }, () => {
  it("given a task on this machine whose step its person stopped, when they read it and then tell the agent to go on, then it reads as needing them while it waits, and their words take it on to review", async () => {
    // given
    const { ctx, task, post, runner, shown } = await stoppedStep("stays");

    // when
    const waiting = await shown();
    const sent = await post(`/api/tasks/${task.id}/messages`, { text: "Go on.", commandId: "cmd-go-on-stays" });
    await settled(ctx, task.id, (t) => t.status === "needs-review");

    // then
    expect([waiting.status, waiting.stage, waiting.state]).toEqual(["running", "stopped", "needs-you"]);
    expect(sent.status).toBe(202);
    expect((await shown()).stage).not.toBe("stopped");
    await runner.loop.stop();
  });

  it("given a task on this machine whose agent ended when its step was stopped, when its person tells it to go on, then the runner takes it again at once instead of leaving it waiting its turn through the rest of a poll", async () => {
    // given
    const { ctx, task, post, runner } = await stoppedStep("ends");
    await settled(ctx, task.id, (t) => t.status !== "running");

    // when
    const sent = await post(`/api/tasks/${task.id}/messages`, { text: "Go on.", commandId: "cmd-go-on-ended" });

    // then
    expect(sent.status).toBe(202);
    await until(async () => (await ctx.store.getTask(ctx.tenant, task.id))!.status !== "queued", 5_000);
    await settled(ctx, task.id, (t) => t.status === "needs-review");
    await runner.loop.stop();
  });

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

  it("given a person's own task whose agent ends asking them a question, when they read the task and write the answer in its follow-up box, then it read as waiting for their answer in its status as in its state, never as failed, with the question and a box to write in, the next run is told the question and their answer once, and a retry of the same message starts nothing more", async () => {
    // given
    const { ctx, task, post, runner, prompts } = await personal('if (said.includes("They answered")) writeFileSync("notes.md", "The lower tier.\\n");', "I cannot tell which tier applies.\nQUESTION: Does a parcel at the limit take the lower tier?\nOPTION: Yes, the lower tier\nOPTION: No, the next tier");
    await settled(ctx, task.id, (t) => t.status === "needs-answer");
    const app = createApp(ctx, as(await principalOf(ctx.store, (await ctx.store.getUserByEmail(ctx.tenant, ADA))!)));
    const asking = (await (await app.request(`/api/tasks/${task.id}`)).json()).task;

    // when
    const body = { text: "Yes, the lower tier.", commandId: "cmd-answer-in-box" };
    const sent = await post(`/api/tasks/${task.id}/messages`, body);
    const again = await post(`/api/tasks/${task.id}/messages`, body);
    await settled(ctx, task.id, (t) => t.status === "needs-review");

    // then
    expect([asking.status, asking.phase]).toEqual(["needs-answer", "review"]);
    expect([asking.state, asking.followUp, asking.question]).toEqual(["needs-you", "continue", { text: "Does a parcel at the limit take the lower tier?", options: ["Yes, the lower tier", "No, the next tier"] }]);
    expect([sent.status, again.status]).toEqual([202, 200]);
    expect(prompts()).toHaveLength(2);
    expect(prompts()[1]).toContain("Your last run stopped to ask the person: Does a parcel at the limit take the lower tier?");
    expect(prompts()[1]!.split("Yes, the lower tier.")).toHaveLength(2);
    expect((await ctx.store.getTask(ctx.tenant, task.id))!.question ?? null).toBeNull();
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
