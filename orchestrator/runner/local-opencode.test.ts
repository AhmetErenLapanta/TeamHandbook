import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createUser } from "../server/accounts.js";
import type { Principal } from "../server/auth.js";
import { localRepoPath } from "../server/forge/local.js";
import { gitMaybe } from "../server/git.js";
import { newId } from "../server/ids.js";
import { createRunnerService } from "../server/runner-service.js";
import { opencodeAdapter } from "../server/tasks/agents.js";
import { openPushedRequest } from "../server/tasks/leased.js";
import { createTaskRunner } from "../server/tasks/runner.js";
import { UNKNOWN_COST } from "../server/tasks/types.js";
import type { TaskMode, TaskRecord } from "../server/tasks/types.js";
import { seededContext } from "../server/test-fixtures.js";
import { startEmbeddedRunner } from "./embedded.js";

const OWNER: Principal = { id: "owner", name: "Owner", email: "owner@example.invalid", role: "owner", ownedTeams: [] };
const ADA = "ada@example.invalid";
const FAKE_SERVE = join(import.meta.dirname, "opencode-serve.fake.mjs");

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// A task here starts its own OpenCode server before the agent runs, so its end comes later than a one-shot run's.
const until = async (check: () => Promise<boolean>, ms = 60_000) => {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 100));
  }
};

/**
 * Ada's local orchestrator running her tasks as her, with OpenCode reached through a stand-in of
 * `opencode serve`; the `opencode` first on PATH refuses to run and says so, so no real CLI starts.
 */
async function adasOrchestrator(mode: TaskMode, description: string) {
  const { ctx, root } = await seededContext("orchestrator-local-opencode-", ["payments-skills"]);
  dirs.push(root);
  const home = join(root, "ada-home");
  const bin = join(root, "bin");
  mkdirSync(home);
  mkdirSync(bin);
  writeFileSync(join(bin, "opencode"), `#!/bin/sh\necho ran > "${join(root, "real-opencode-ran")}"\nexit 1\n`);
  writeFileSync(join(bin, "opencode-standin"), `#!/bin/sh\nexec "${process.execPath}" "${FAKE_SERVE}" "$@"\n`);
  chmodSync(join(bin, "opencode"), 0o755);
  chmodSync(join(bin, "opencode-standin"), 0o755);
  await createUser(ctx.store, ctx.tenant, new Set(["Payments"]), { email: ADA, name: "Ada Example", role: "admin" }, OWNER);
  ctx.tasks = createTaskRunner(ctx, { agents: [opencodeAdapter(join(bin, "opencode-standin"))], isolation: { mode: "process", network: "open" }, profile: "personal", testCommand: () => null, hostEnv: { PATH: `${bin}:${process.env.PATH}`, HOME: home } });
  await ctx.tasks.ready();
  const service = createRunnerService({ tenant: ctx.tenant, store: ctx.store, onFinished: (id, outcome) => openPushedRequest(ctx, id, outcome) });
  ctx.runnerService = service;
  const runner = await startEmbeddedRunner({ service, person: ADA, holder: "this-machine", executor: ctx.tasks.leased(), dataDir: ctx.dataDir, mask: (t) => t });
  const repo = (await ctx.store.getRepo(ctx.tenant, "payments-skills"))!;
  const task: TaskRecord = { tenant: ctx.tenant, id: newId("tsk"), repoId: repo.id, team: repo.team, title: "Add an on-call note", description, issueUrl: null, issueKey: null, agent: "opencode", status: "queued", createdBy: ADA, createdAt: new Date().toISOString(), startedAt: null, finishedAt: null, baseSha: null, tests: null, cost: UNKNOWN_COST, requestNumber: null, error: null, mode, runner: "local" };
  await ctx.store.createTask(task);
  service.wake();
  const sessions = () => (existsSync(join(home, "opencode-seen.jsonl")) ? readFileSync(join(home, "opencode-seen.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as { path: string; body: { permission: { permission: string; pattern: string; action: string }[] } }).filter((r) => r.path === "/session") : []);
  return { ctx, root, home, repo, task, service, runner, sessions };
}

describe("a local orchestrator running OpenCode as its person", { timeout: 180_000 }, () => {
  it("given a task in approval-required whose agent asks to use one of Ada's own MCP tools that writes, when she allows it once, then OpenCode ran as a session of its own server under rules no config of hers outranks, with no shell or web, the branch lands and the request opens", async () => {
    // given
    const run = await adasOrchestrator("approval-required", "stand-in: ask notebook_create_page quarterly notes");

    // when
    await until(async () => (await run.ctx.store.taskRequests(run.ctx.tenant, run.task.id)).some((r) => r.status === "pending"));
    const [asked] = (await run.ctx.store.taskRequests(run.ctx.tenant, run.task.id)).filter((r) => r.status === "pending");
    await run.ctx.store.answerTaskRequest(run.ctx.tenant, asked!.id, { decision: "allow_once" }, ADA, "web", new Date().toISOString());
    run.service.wake();
    await until(async () => (await run.ctx.store.getTask(run.ctx.tenant, run.task.id))!.requestNumber !== null);
    await run.runner.loop.stop();

    // then
    const done = (await run.ctx.store.getTask(run.ctx.tenant, run.task.id))!;
    expect(done.status).toBe("needs-review");
    expect(asked).toMatchObject({ payload: { tool: "notebook_create_page", summary: "quarterly notes" } });
    const rules = run.sessions()[0]!.body.permission;
    expect(rules).toEqual(expect.arrayContaining([{ permission: "bash", pattern: "*", action: "deny" }, { permission: "webfetch", pattern: "*", action: "deny" }, { permission: "edit", pattern: "*", action: "ask" }, { permission: "external_directory", pattern: "*", action: "deny" }]));
    const request = (await run.ctx.store.getRequest(run.ctx.tenant, run.repo.id, done.requestNumber!))!;
    expect(gitMaybe(["show", `refs/heads/${request.branch}:opencode-note.md`], localRepoPath(run.repo.url)!)?.trim()).toBe("Written by the stand-in OpenCode.");
    expect(existsSync(join(run.root, "real-opencode-ran"))).toBe(false);
  });

  it("given a task in approval-required whose agent reads an issue through the tracker's server, when it runs, then the read goes ahead with no card and the task reaches review", async () => {
    // given
    const run = await adasOrchestrator("approval-required", "stand-in: ask atlassian_getJiraIssue PAY-12");

    // when
    await until(async () => (await run.ctx.store.getTask(run.ctx.tenant, run.task.id))!.requestNumber !== null);
    await run.runner.loop.stop();

    // then
    expect((await run.ctx.store.getTask(run.ctx.tenant, run.task.id))!.status).toBe("needs-review");
    expect(await run.ctx.store.taskRequests(run.ctx.tenant, run.task.id)).toEqual([]);
  });

  it("given a task in auto, when it runs, then it still goes through OpenCode's server, never a one-shot run, with edits allowed, still no shell or web and nothing outside the folder", async () => {
    // given
    const run = await adasOrchestrator("auto", "");

    // when
    await until(async () => (await run.ctx.store.getTask(run.ctx.tenant, run.task.id))!.requestNumber !== null);
    await run.runner.loop.stop();

    // then
    expect((await run.ctx.store.getTask(run.ctx.tenant, run.task.id))!.status).toBe("needs-review");
    const rules = run.sessions()[0]!.body.permission;
    expect(rules).toEqual(expect.arrayContaining([{ permission: "bash", pattern: "*", action: "deny" }, { permission: "edit", pattern: "*", action: "allow" }, { permission: "external_directory", pattern: "*", action: "deny" }]));
    expect(existsSync(join(run.root, "real-opencode-ran"))).toBe(false);
  });

  it("given OpenCode working, when Ada cancels the task, then its server's process group is gone and the task ends cancelled, as a stopped run of Claude Code does", async () => {
    // given
    const run = await adasOrchestrator("auto", "stand-in: wait 60 seconds");
    await until(async () => existsSync(join(run.home, "opencode-serve.pid")) && run.sessions().length > 0);
    const pid = Number(readFileSync(join(run.home, "opencode-serve.pid"), "utf8"));

    // when
    await run.ctx.tasks!.cancel(run.task.id);
    await until(async () => !["queued", "running"].includes((await run.ctx.store.getTask(run.ctx.tenant, run.task.id))!.status));
    await run.runner.loop.stop();
    const alive = () => {
      try {
        process.kill(-pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    await until(async () => !alive(), 10_000);

    // then
    expect(alive()).toBe(false);
    expect((await run.ctx.store.getTask(run.ctx.tenant, run.task.id))!.status).toBe("cancelled");
  });
});
