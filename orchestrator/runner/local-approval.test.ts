import { rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createUser } from "../server/accounts.js";
import type { Principal } from "../server/auth.js";
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

/**
 * A local orchestrator with its embedded runner and the stand-in agent, a task in Approval
 * required whose description makes the stand-in ask before it runs the tests.
 */
async function askingTask() {
  const { ctx, root } = await seededContext("orchestrator-local-approval-", ["payments-skills"]);
  dirs.push(root);
  await createUser(ctx.store, ctx.tenant, new Set(["Payments"]), { email: ADA, name: "Ada Example", role: "admin" }, OWNER);
  ctx.tasks = createTaskRunner(ctx, { agents: [fakeAgentAdapter(FAKE_AGENT)], isolation: { mode: "process", network: "open" }, testCommand: () => null, hostEnv: { PATH: process.env.PATH } });
  await ctx.tasks.ready();
  const service = createRunnerService({ tenant: ctx.tenant, store: ctx.store, onFinished: (id, outcome) => openPushedRequest(ctx, id, outcome) });
  const runner = await startEmbeddedRunner({ service, person: ADA, holder: "this-machine", executor: ctx.tasks.leased(), dataDir: ctx.dataDir, mask: (t) => t });
  const repo = (await ctx.store.getRepo(ctx.tenant, "payments-skills"))!;
  const task: TaskRecord = {
    tenant: ctx.tenant, id: newId("tsk"), repoId: repo.id, team: repo.team, title: "Add an on-call note", description: "stand-in: ask Bash npm test",
    issueUrl: null, issueKey: null, agent: "fake", status: "queued", createdBy: ADA, createdAt: new Date().toISOString(), startedAt: null, finishedAt: null,
    baseSha: null, tests: null, cost: UNKNOWN_COST, requestNumber: null, error: null, template: null, mode: "approval-required", runner: "local",
  };
  await ctx.store.createTask(task);
  service.wake();
  const card = async () => (await ctx.store.taskRequests(ctx.tenant, task.id))[0] ?? null;
  await until(async () => (await card()) !== null);
  const log = async () => (await ctx.store.taskLog(ctx.tenant, task.id, 0)).map((l) => l.text);
  const answer = async (decision: "allow_once" | "deny") => ctx.store.answerTaskRequest(ctx.tenant, (await card())!.id, { decision }, ADA, "web", new Date().toISOString());
  const current = async () => (await ctx.store.getTask(ctx.tenant, task.id))!;
  return { ctx, task, card, log, answer, current, stop: () => runner.loop.stop() };
}

describe("a question from the agent on a local orchestrator", { timeout: 120_000 }, () => {
  it("given the stand-in asking to run the tests, when its person allows it on the card, then the agent goes on and the task reaches review with a request", async () => {
    // given
    const run = await askingTask();
    expect(await run.card()).toMatchObject({ status: "pending" });

    // when
    await run.answer("allow_once");
    await until(async () => (await run.current()).requestNumber !== null);

    // then
    expect(await run.current()).toMatchObject({ status: "needs-review" });
    expect(await run.log()).toEqual(expect.arrayContaining([expect.stringContaining("allowed Bash npm test")]));
    await run.stop();
  });

  it("given the stand-in asking to run the tests, when its person refuses on the card, then the agent goes on without the call and never runs it", async () => {
    // given
    const run = await askingTask();

    // when
    await run.answer("deny");
    await until(async () => ["needs-review", "failed", "done"].includes((await run.current()).status));

    // then
    const log = await run.log();
    expect(log).toEqual(expect.arrayContaining([expect.stringContaining("refused Bash npm test")]));
    expect(log.some((l) => l.includes("allowed Bash npm test"))).toBe(false);
    await run.stop();
  });
});
