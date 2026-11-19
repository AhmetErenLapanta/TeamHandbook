import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { OrchestratorContext } from "../app.js";
import type { Principal } from "../auth.js";
import { seededContext, storePrincipals } from "../test-fixtures.js";
import { fakeAgentAdapter } from "./agents.js";
import { taskPaths } from "./isolation.js";
import { createTaskRunner } from "./runner.js";
import type { TaskRunner } from "./runner.js";

const ADA: Principal = { id: "a", name: "Ada Example", email: "ada@example.invalid", role: "admin", ownedTeams: [] };
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function seeded() {
  const { ctx, root } = await seededContext("orchestrator-restart-disk-");
  await storePrincipals(ctx, ADA);
  dirs.push(root);
  return { ctx, root };
}

const agentScript = (root: string, name: string, body: string): string => {
  const file = join(root, `${name}.mjs`);
  writeFileSync(file, `import { writeFileSync } from "node:fs";\n${body}\nconsole.log(JSON.stringify({ type: "result", summary: "Done." }));\n`);
  return file;
};

const runner = (ctx: OrchestratorContext, script: string): TaskRunner =>
  createTaskRunner(ctx, { agents: [fakeAgentAdapter(script)], isolation: { mode: "process", network: "open" }, testCommand: () => null, hostEnv: { PATH: process.env.PATH } });

const waitFor = async (condition: () => Promise<boolean>, what: string): Promise<void> => {
  const stop = Date.now() + 60_000;
  while (!(await condition())) {
    if (Date.now() > stop) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
};

const startOn = async (ctx: OrchestratorContext, tasks: TaskRunner) => {
  const repo = (await ctx.store.getRepo(ctx.tenant, "payments-skills"))!;
  return tasks.start({ repo, title: "Add a note", description: "Write the note.", agent: "fake", user: ADA });
};

describe("a task that meets a full disk or an orchestrator that restarts", { timeout: 120_000 }, () => {
  it("given an agent whose write fails because the disk is full, when its task ends, then the task failed with one sentence that says the disk is full and what to do, and no raw error", async () => {
    // given
    const { ctx, root } = await seeded();
    const tasks = runner(ctx, agentScript(root, "disk-full", 'console.error("ENOSPC: no space left on device, write");\nprocess.exit(1);'));
    ctx.tasks = tasks;
    await tasks.ready();

    // when
    const started = await startOn(ctx, tasks);
    await tasks.idle();

    // then
    const task = (await ctx.store.getTask(ctx.tenant, started.id))!;
    expect(task.status).toBe("failed");
    expect(task.error).toBe("This machine's disk is full. Free some space, then start the task again.");
  });

  it.each([
    ["a change written", 'writeFileSync("restart-note.md", "half done\\n");\n', { status: "needs-review", error: "Stopped when the orchestrator restarted.", request: true }],
    ["nothing written", "", { status: "failed", error: /restarted/i, request: false }],
  ])("given a task running with %s, when the orchestrator restarts, then it ends as expected: what it changed waits for review, nothing changed fails saying why, and no copy of the run is left on the disk", async (_case, written, expected) => {
    // given
    const { ctx, root } = await seeded();
    const first = runner(ctx, agentScript(root, "slow", `${written}await new Promise((resolve) => setTimeout(resolve, 60000));`));
    ctx.tasks = first;
    await first.ready();
    const started = await startOn(ctx, first);
    const paths = taskPaths(ctx.dataDir, ctx.tenant, started.id);
    await waitFor(async () => (await ctx.store.getTask(ctx.tenant, started.id))?.status === "running" && existsSync(paths.work) && (written === "" || existsSync(join(paths.work, "restart-note.md"))), "the agent to be at work");

    // when
    const second = runner(ctx, agentScript(root, "slow", ""));
    ctx.tasks = second;
    await second.ready();

    // then
    const task = (await ctx.store.getTask(ctx.tenant, started.id))!;
    expect(task.status).toBe(expected.status);
    expect(task.error).toEqual(typeof expected.error === "string" ? expected.error : expect.stringMatching(expected.error));
    expect(task.requestNumber !== null && task.requestNumber !== undefined).toBe(expected.request);
    const tasksDir = join(ctx.dataDir, "tasks");
    expect(existsSync(tasksDir) ? readdirSync(tasksDir).flatMap((tenant) => readdirSync(join(tasksDir, tenant))) : []).toEqual([]);
    await first.cancel(started.id);
  });
});
