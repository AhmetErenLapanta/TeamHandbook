import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FORGE_REASON, releasePersonalGuard, TRACKER_REASON } from "../server/tasks/profile.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createUser, principalOf, setupFirstOwner, startSession } from "../server/accounts.js";
import { createApp } from "../server/app.js";
import type { OrchestratorContext } from "../server/app.js";
import { CSRF_HEADER, sessionCookie } from "../server/auth.js";
import type { Principal } from "../server/auth.js";
import { localRepoPath } from "../server/forge/local.js";
import { newId } from "../server/ids.js";
import { organizationRunners } from "../server/runner-routes.js";
import { createRunnerService } from "../server/runner-service.js";
import { openSqliteStore } from "../server/store.js";
import { fakeAgentAdapter } from "../server/tasks/agents.js";
import type { AgentAdapter } from "../server/tasks/agents.js";
import { createTaskRunner } from "../server/tasks/runner.js";
import type { TaskRecord } from "../server/tasks/types.js";
import type { CheckoutWork, RemoteWork } from "./link.js";
import { KEPT_ON_MACHINE } from "./mask.js";
import { machineExecutor } from "./machine-executor.js";
import { STOPPED } from "./task.js";
import type { ExecutorHooks } from "./task.js";
import { seededContext } from "../server/test-fixtures.js";
import { createVault } from "../server/vault.js";
import { connectCommand } from "../shared/runner-command.js";
import { NOT_CONNECTED_EXIT, runnerCommand } from "./cli.js";
import { orgDir } from "./profile.js";
import type { Fetch } from "./profile.js";

const ADDRESS = "https://orchestrator.example.invalid";
const FORGE = "https://git.example.invalid/acme/payments-skills.git";
const MAX = "max@example.invalid";
const FAKE_AGENT = join(import.meta.dirname, "..", "demo", "fake-agent.mjs");
// Shaped like a GitHub token so the secret check sees one; it opens nothing anywhere.
const TOKEN_SHAPED = `ghp_${"Zx9".repeat(12)}`;

const git = (args: string[], cwd: string) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" } }).trim();
const until = async (check: () => Promise<boolean>) => {
  for (let i = 0; i < 300 && !(await check()); i++) await new Promise((r) => setTimeout(r, 100));
};

/**
 * Max's team orchestrator answered in this process, the forge as a bare repository this machine
 * reaches in place of the forge's address, and his machine paired with the command Settings
 * prints, running `runner start` with the stand-in agent.
 */
async function pairedMachine(root: string, files: Record<string, string>, prompt: string, testCommand: string | null = null, rules: RemoteWork["rules"] = [], mcpTools: RemoteWork["setup"]["mcpTools"] = [], continued: { moved: boolean } | null = null) {
  const bare = join(root, "forge.git");
  git(["init", "--quiet", "--bare", "--initial-branch=main", bare], root);
  const seed = join(root, "seed");
  git(["clone", "--quiet", bare, seed], root);
  for (const [path, content] of Object.entries({ "README.md": "payments skills\n", ...files })) writeFileSync(join(seed, path), content);
  git(["-c", "user.name=Seed", "-c", "user.email=seed@example.invalid", "add", "-A"], seed);
  git(["-c", "user.name=Seed", "-c", "user.email=seed@example.invalid", "commit", "--quiet", "-m", "start"], seed);
  git(["push", "--quiet", "origin", "main"], seed);
  const baseSha = git(["rev-parse", "HEAD"], seed);
  let head: string | null = null;
  if (continued) {
    const commit = (message: string) => {
      writeFileSync(join(seed, "NOTES.md"), `${message}\n`);
      git(["-c", "user.name=Max Example", "-c", "user.email=max@example.invalid", "commit", "--quiet", "-am", message], seed);
      git(["push", "--quiet", "origin", "HEAD:refs/heads/task/tsk_machine_1"], seed);
      return git(["rev-parse", "HEAD"], seed);
    };
    writeFileSync(join(seed, "NOTES.md"), "");
    git(["add", "NOTES.md"], seed);
    head = commit("the request's first change");
    if (continued.moved) commit("someone else's change on the request");
  }
  const home = join(root, "home");
  mkdirSync(home);
  writeFileSync(join(home, ".gitconfig"), "[user]\n\tname = Max Example\n\temail = max@example.invalid\n");

  const store = openSqliteStore(":memory:");
  const owner = await principalOf(store, await setupFirstOwner(store, "acme", "code", { code: "code", email: "ada@example.invalid", password: "correct horse battery" }));
  const max = await createUser(store, "acme", new Set(["Payments"]), { email: MAX, role: "member", password: "correct horse battery" }, owner);
  const service = createRunnerService({ tenant: "acme", store, describeWork: async (id) => ({ prompt, mode: "approval-required", choices: null, repo: { url: FORGE, baseBranch: "main", baseSha }, branch: `task/${id}`, ...(head ? { continues: { branch: `task/${id}`, head } } : {}), rules, setup: { plugin: null, mcpTools, deniedTools: [] }, limits: { timeoutMs: 120_000, testCommand: testCommand?.replace("<HOME>", home) ?? null } }) });
  const ctx: OrchestratorContext = { store, dataDir: join(root, "orchestrator-data"), tenant: "acme", allowedHosts: null, runnerService: service };
  const app = createApp(ctx);
  const fetchImpl: Fetch = async (input, init) => {
    const url = new URL(String(input));
    return app.request(url.pathname + url.search, init);
  };
  const cookie = `${sessionCookie("acme")}=${(await startSession(store, "acme", max.id)).token}`;
  const { csrf } = await (await app.request("/api/me", { headers: { cookie } })).json();
  const paired = (await (await app.request("/api/machines/pair", { method: "POST", headers: { cookie, [CSRF_HEADER]: csrf, "content-type": "application/json" }, body: "{}" })).json()) as { code: string };
  const out: string[] = [];
  const dataDir = join(root, "data");
  const io = { dataDir, out: (t: string) => void out.push(t), err: (t: string) => void out.push(t), fetch: fetchImpl, name: "max-laptop", platform: "darwin-arm64" };
  const task: TaskRecord = { tenant: "acme", id: "tsk_machine_1", repoId: "payments-skills", team: "Payments", title: "Add a note", description: "", issueUrl: null, issueKey: null, agent: "fake", status: "queued", createdBy: MAX, createdAt: new Date().toISOString(), startedAt: null, finishedAt: null, baseSha: null, tests: null, cost: { usd: null, inputTokens: null, outputTokens: null }, requestNumber: null, error: null, runner: "local" };
  await store.createTask(task);
  const stop = new AbortController();
  // The command Settings prints, as it is: it pairs the machine and goes on to run its person's tasks.
  const started = runnerCommand(connectCommand(ADDRESS, paired.code).split(" ").slice(2), { ...io, signal: stop.signal, adapters: [fakeAgentAdapter(FAKE_AGENT)], hostEnv: { PATH: process.env.PATH, HOME: home }, gitConfig: ["-c", `url.${bare}.insteadOf=${FORGE}`, "-c", "protocol.file.allow=always"], gitEnv: { GIT_ALLOW_PROTOCOL: "https:ssh:file" } });
  const finished = async () => {
    await until(async () => !["queued", "running"].includes((await store.getTask("acme", task.id))!.status));
    stop.abort();
    expect(await started).toBe(0);
    return (await store.getTask("acme", task.id))!;
  };
  const taskDir = join(dataDir, "runner", "machines", "acme", "tasks", task.id);
  return { store, service, task, bare, baseSha, head, out, finished, taskDir, started, stop };
}

/** What the guard's hook answers for one call, as Claude Code hands it one: a recorded PreToolUse input. */
function guardAnswers(settingsFile: string, toolName: string): string {
  const command = (JSON.parse(readFileSync(settingsFile, "utf8")) as { hooks: { PreToolUse: { hooks: { command: string }[] }[] } }).hooks.PreToolUse[0]!.hooks[0]!.command;
  const [node, script] = (JSON.parse(`[${command.replace("\" \"", "\",\"")}]`) as string[]);
  return execFileSync(node!, [script!], { input: JSON.stringify({ hook_event_name: "PreToolUse", tool_name: toolName, tool_input: {} }), encoding: "utf8" }).trim();
}

describe("a team member's machine, from the command line", { timeout: 120_000 }, () => {
  let root: string;
  beforeEach(() => void (root = mkdtempSync(join(tmpdir(), "machine-e2e-"))));
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("given Max runs the connect command Settings prints, when a task of his asks and he allows it, then the agent ran under the team's guard, the team's tests ran with a HOME that is not his, the branch reaches the forge with his git on its base from a git directory the agent never saw, and the task waits for review", async () => {
    // The team's tests pass only when HOME is not Max's own, where his sign-ins are.
    const run = await pairedMachine(root, { ".mcp.json": JSON.stringify({ mcpServers: { deploy: { command: "deploy-mcp" } } }) }, "Task: Add a note\nstand-in: ask Bash npm test", 'test "$HOME" != "<HOME>"', [{ action: "tool.use", resource: "tool:Edit:*.env", effect: "deny", reason: "env files are set by the platform team" }]);
    let asked = null as Awaited<ReturnType<typeof run.store.taskRequests>>[number] | null;
    await until(async () => !!([asked = null] = (await run.store.taskRequests("acme", run.task.id)).filter((r) => r.status === "pending"), asked));
    const settingsFile = join(run.taskDir, "guard", "personal-settings.json");
    const settings = JSON.parse(readFileSync(settingsFile, "utf8")) as Record<string, unknown>;
    const writing = guardAnswers(settingsFile, "mcp__github__merge_pull_request");
    const reading = guardAnswers(settingsFile, "mcp__docs__search");
    const readingTracker = ["mcp__claude_ai_Atlassian__getJiraIssue", "mcp__claude_ai_Atlassian__searchJiraIssuesUsingJql", "mcp__claude_ai_Slack__slack_search_public_and_private"].map((tool) => guardAnswers(settingsFile, tool));
    const writingTracker = guardAnswers(settingsFile, "mcp__claude_ai_Atlassian__editJiraIssue");
    const gitInCheckout = existsSync(join(run.taskDir, "work", ".git"));

    await run.store.answerTaskRequest("acme", asked!.id, { decision: "allow_once" }, MAX, "web", new Date().toISOString());
    run.service.wake();
    const done = await run.finished();

    expect(settings).toMatchObject({ enableAllProjectMcpServers: false, disabledMcpjsonServers: ["deploy"], permissions: { deny: expect.arrayContaining(["Edit(*.env)"]) } });
    expect(JSON.parse(writing)).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny", permissionDecisionReason: FORGE_REASON } });
    expect(JSON.parse(reading)).toMatchObject({ hookSpecificOutput: { permissionDecision: "allow" } });
    expect(readingTracker.map((answer) => JSON.parse(answer).hookSpecificOutput.permissionDecision)).toEqual(["allow", "allow", "allow"]);
    expect(JSON.parse(writingTracker)).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny", permissionDecisionReason: TRACKER_REASON } });
    expect(gitInCheckout).toBe(false);
    expect(done).toMatchObject({ status: "needs-review", tests: "passed" });
    expect(asked).toMatchObject({ payload: { tool: "Bash", summary: "npm test" } });
    expect(git(["log", "-1", "--format=%an <%ae>", "task/tsk_machine_1"], run.bare)).toBe("Max Example <max@example.invalid>");
    expect(git(["rev-parse", "task/tsk_machine_1^"], run.bare)).toBe(run.baseSha);
    const log = (await run.store.taskLog("acme", run.task.id, 0)).map((l) => l.text);
    expect(log).toEqual(expect.arrayContaining([expect.stringContaining("Checked out main"), "allowed Bash npm test", expect.stringContaining("Pushed task/tsk_machine_1 with your own git")]));
    expect(run.out.join("")).toMatch(/Running the tasks you start in acme on this machine/);
    expect(existsSync(run.taskDir)).toBe(false);
  });

  it("given the agent calls one of Max's own MCP tools and one the team gave the task, when each asks and he allows it, then what his own tool was aimed at stays on his machine and the team sees its name and his answer, while the team's tool is shown in full", async () => {
    // given
    const own = "the forecast for the stand-in quarter";
    const run = await pairedMachine(root, {}, `Task: Add a note\nstand-in: ask mcp__notebook__search_pages ${own}\nstand-in: ask mcp__docs__search on-call runbook`, null, [], [{ server: "docs", tool: "search" }]);
    const answer = async () => {
      let pending = null as Awaited<ReturnType<typeof run.store.taskRequests>>[number] | null;
      await until(async () => !!([pending = null] = (await run.store.taskRequests("acme", run.task.id)).filter((r) => r.status === "pending"), pending));
      await run.store.answerTaskRequest("acme", pending!.id, { decision: "allow_once" }, MAX, "web", new Date().toISOString());
      run.service.wake();
      return pending!;
    };

    // when
    const first = await answer();
    const second = await answer();
    const done = await run.finished();

    // then
    expect(done.status).toBe("needs-review");
    expect(first).toMatchObject({ payload: { tool: "mcp__notebook__search_pages", summary: KEPT_ON_MACHINE } });
    expect(second).toMatchObject({ payload: { tool: "mcp__docs__search", summary: "on-call runbook" } });
    // The stand-in says in its own words what it was allowed, as an agent may quote what it did; those words are the agent's, and they go.
    const log = (await run.store.taskLog("acme", run.task.id, 0)).map((l) => l.text).filter((line) => !line.startsWith("allowed "));
    expect(log).toEqual(expect.arrayContaining([`asks: mcp__notebook__search_pages ${KEPT_ON_MACHINE}`, "asks: mcp__docs__search on-call runbook"]));
    expect(log.join("\n")).not.toContain(own);
  });

  it("given Max's machine running his tasks, when he removes it in Settings, then the runner says so and stops, as asking again changes nothing", async () => {
    // given
    const run = await pairedMachine(root, {}, "Task: Add a note\nstand-in: wait 1 second");
    await until(async () => (await run.store.listMachines("acme", null)).some((m) => m.lastSeenAt !== null) || (await run.store.getTask("acme", run.task.id))!.status !== "queued");
    const [machine] = await run.store.listMachines("acme", null);

    // when
    await run.store.revokeMachine("acme", machine!.id, new Date().toISOString());
    run.service.wake();
    const exit = await Promise.race([run.started, new Promise<string>((resolve) => setTimeout(() => resolve("still running"), 60_000))]);
    run.stop.abort();

    // then
    expect(exit).toBe(NOT_CONNECTED_EXIT);
    expect(run.out.join("")).toMatch(/acme: the orchestrator no longer takes this machine; connect it again from Settings/);
    await releasePersonalGuard(join(orgDir(join(root, "data"), "acme"), "tasks", run.task.id));
  });

  it("given a task of Max's at work on his machine, when a follow-up of his arrives, then the agent takes it as its next turn, it is marked delivered, and the task's log says who sent it and what it says", async () => {
    // given
    const run = await pairedMachine(root, {}, "Task: Add a note\nstand-in: wait 3 seconds");
    await until(async () => (await run.store.getTask("acme", run.task.id))!.status === "running");

    // when
    await run.store.addFollowUp({ tenant: "acme", id: "fup_1", taskId: run.task.id, source: "person", key: "fup_1", text: "Also name the pager rotation.", quotes: null, createdAt: new Date().toISOString(), createdBy: MAX });
    run.service.wake();
    const done = await run.finished();

    // then
    expect(done.status).toBe("needs-review");
    expect(await run.store.pendingFollowUps("acme", run.task.id)).toEqual([]);
    const log = (await run.store.taskLog("acme", run.task.id, 0)).map((l) => l.text);
    expect(log).toEqual(expect.arrayContaining(["Sent a follow-up to the agent.", `${MAX}: Also name the pager rotation.`]));
  });

  it("given a task going on from its open request, when the machine runs it, then it starts from the request's head, commits on it and moves the request's branch forward, and the task keeps its first base", async () => {
    // given
    const run = await pairedMachine(root, {}, "Task: Add a note", null, [], [], { moved: false });

    // when
    const done = await run.finished();

    // then
    expect(done).toMatchObject({ status: "needs-review", baseSha: null });
    expect(git(["rev-parse", "task/tsk_machine_1^"], run.bare)).toBe(run.head);
    expect(git(["show", "task/tsk_machine_1:NOTES.md"], run.bare)).toBe("the request's first change");
    const log = (await run.store.taskLog("acme", run.task.id, 0)).map((l) => l.text);
    expect(log).toContain(`Continued task/tsk_machine_1 at ${run.head!.slice(0, 7)} into a folder of this machine's.`);
  });

  it("given a task going on from its open request whose branch moved since the orchestrator read it, when the machine would start, then it changes nothing and the branch stays as it is", async () => {
    // given
    const run = await pairedMachine(root, {}, "Task: Add a note", null, [], [], { moved: true });
    const moved = git(["rev-parse", "task/tsk_machine_1"], run.bare);

    // when
    const done = await run.finished();

    // then
    expect(done).toMatchObject({ status: "failed", error: "The request's branch moved since the orchestrator read it; nothing was changed." });
    expect(git(["rev-parse", "task/tsk_machine_1"], run.bare)).toBe(moved);
  });

  it("given an agent whose change carries something shaped like a token, when the run ends, then the task fails on this machine and nothing reaches the forge", async () => {
    const run = await pairedMachine(root, {}, `Task: keep ${TOKEN_SHAPED}`);

    const done = await run.finished();

    expect(done.status).toBe("failed");
    expect(done.error).toMatch(/looks like it holds a secret/);
    expect(git(["for-each-ref", "--format=%(refname)", "refs/heads/"], run.bare)).toBe("refs/heads/main");
  });

  it("given a repository whose .mcp.json cannot be read as JSON, when the machine would start the agent with its person's profile, then it does not, since the guard cannot keep those servers off", async () => {
    const run = await pairedMachine(root, { ".mcp.json": "{ not json" }, "Task: Add a note");

    const done = await run.finished();

    expect(done).toMatchObject({ status: "failed", error: expect.stringMatching(/\.mcp\.json is not JSON/) });
    expect(git(["for-each-ref", "--format=%(refname)", "refs/heads/"], run.bare)).toBe("refs/heads/main");
  });

  it("given a description whose address is a path or a command, when the machine would clone it, then git refuses it under the machine's own settings", () => {
    const work = join(root, "w");
    mkdirSync(work);
    for (const url of [`file://${root}`, "ext::sh -c true"]) {
      expect(() => execFileSync("git", ["-c", "protocol.allow=never", "-c", "protocol.https.allow=always", "-c", "protocol.ssh.allow=always", "clone", "--quiet", url, join(work, "x")], { cwd: work, stdio: "pipe", env: { ...process.env, GIT_ALLOW_PROTOCOL: "https:ssh" } })).toThrow();
    }
  });
});

describe("a team member's machine, given its work by the team's orchestrator", { timeout: 120_000 }, () => {
  let root: string;
  beforeEach(() => void (root = mkdtempSync(join(tmpdir(), "machine-served-"))));
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  async function sessionKeepingTask(root: string) {
    const seeded = await seededContext("machine-continue-", ["payments-skills"], "main", root);
    const ctx = seeded.ctx;
    const repo = (await ctx.store.getRepo(ctx.tenant, "payments-skills"))!;
    const forge = localRepoPath(repo.url)!;
    ctx.vault = createVault(randomBytes(32));
    ctx.memberUrls = new Map([[repo.id, FORGE]]);
    const owner: Principal = { id: "owner", name: "Owner", email: "owner@example.invalid", role: "owner", ownedTeams: [] };
    const max = await createUser(ctx.store, ctx.tenant, new Set([repo.team]), { email: MAX, role: "member", password: "correct horse battery" }, owner);
    const home = join(root, "home");
    mkdirSync(home);
    writeFileSync(join(home, ".gitconfig"), "[user]\n\tname = Max Example\n\temail = max@example.invalid\n");
    const launches: { sessionId?: string; resume?: string }[] = [];
    const base = fakeAgentAdapter(FAKE_AGENT);
    const resumable: AgentAdapter = {
      ...base,
      twoWay: {
        capabilities: { ...base.twoWay!.capabilities, resume: true },
        launch(paths, setup, options) {
          const { sessionId, resume, ...rest } = options;
          launches.push({ ...(sessionId ? { sessionId } : {}), ...(resume ? { resume } : {}) });
          return base.twoWay!.launch(paths, setup, rest);
        },
      },
    };
    ctx.tasks = createTaskRunner(ctx, { agents: [resumable], isolation: { mode: "process", network: "open" }, testCommand: () => null, hostEnv: { PATH: process.env.PATH }, timeoutMs: 120_000 });
    await ctx.tasks.ready();
    ctx.runnerService = organizationRunners(ctx);
    const app = createApp(ctx);
    const fetchImpl: Fetch = async (input, init) => {
      const url = new URL(String(input));
      return app.request(url.pathname + url.search, init);
    };
    const cookie = `${sessionCookie(ctx.tenant)}=${(await startSession(ctx.store, ctx.tenant, max.id)).token}`;
    const { csrf } = await (await app.request("/api/me", { headers: { cookie } })).json();
    const { code } = (await (await app.request("/api/machines/pair", { method: "POST", headers: { cookie, [CSRF_HEADER]: csrf, "content-type": "application/json" }, body: "{}" })).json()) as { code: string };
    const task: TaskRecord = { tenant: ctx.tenant, id: newId("tsk"), repoId: repo.id, team: repo.team, title: "Add an on-call note", description: "stand-in: wait 4 seconds", issueUrl: null, issueKey: null, agent: "fake", status: "queued", createdBy: MAX, createdAt: new Date().toISOString(), startedAt: null, finishedAt: null, baseSha: null, tests: null, cost: { usd: null, inputTokens: null, outputTokens: null }, requestNumber: null, error: null, mode: "approval-required", runner: "local" };
    await ctx.store.createTask(task);
    const io = (signal: AbortSignal) => ({ dataDir: join(root, "data-machine"), out: () => {}, err: () => {}, fetch: fetchImpl, name: "max-laptop", platform: "darwin-arm64", signal, adapters: [resumable], hostEnv: { PATH: process.env.PATH, HOME: home }, gitConfig: ["-c", `url.${forge}.insteadOf=${FORGE}`, "-c", "protocol.file.allow=always"], gitEnv: { GIT_ALLOW_PROTOCOL: "https:ssh:file" } });
    const status = async () => (await ctx.store.getTask(ctx.tenant, task.id))!.status;
    return { ctx, app, cookie, csrf, code, task, io, status, launches };
  }

  it("given Max's task running on his machine with an agent that keeps its session, when his runner stops mid-turn and he presses Continue, then the next run on his machine resumes that same session and the task reaches review", async () => {
    // given
    const { app, cookie, csrf, code, task, io, status, launches, ctx } = await sessionKeepingTask(root);

    // when
    const first = new AbortController();
    const firstRun = runnerCommand(connectCommand(ADDRESS, code).split(" ").slice(2), io(first.signal));
    await until(async () => (await ctx.store.taskLease(ctx.tenant, task.id))?.nativeSession != null);
    first.abort();
    await firstRun;
    await until(async () => (await status()) === "interrupted");
    const continued = await app.request(`/api/tasks/${task.id}/continue`, { method: "POST", headers: { cookie, [CSRF_HEADER]: csrf, "content-type": "application/json" }, body: JSON.stringify({ commandId: "continue-0001" }) });
    const second = new AbortController();
    const secondRun = runnerCommand(["start"], io(second.signal));
    await until(async () => !["queued", "running"].includes(await status()));
    second.abort();
    await secondRun;

    // then
    expect(continued.status).toBe(200);
    expect(launches).toHaveLength(2);
    expect(launches[0]!.sessionId).toEqual(expect.any(String));
    expect(launches[1]).toEqual({ resume: launches[0]!.sessionId });
    expect(await status()).toBe("needs-review");
  });

  it("given Max's task running on his machine with an agent that keeps its session, when his runner stops mid-turn and starts again, then the task goes on by itself in that same session and reaches review", async () => {
    // given
    const { ctx, code, task, io, status, launches } = await sessionKeepingTask(root);

    // when
    const first = new AbortController();
    const firstRun = runnerCommand(connectCommand(ADDRESS, code).split(" ").slice(2), io(first.signal));
    await until(async () => (await ctx.store.taskLease(ctx.tenant, task.id))?.nativeSession != null);
    first.abort();
    await firstRun;
    await until(async () => (await status()) === "interrupted");
    const second = new AbortController();
    const secondRun = runnerCommand(["start"], io(second.signal));
    await until(async () => !["interrupted", "queued", "running"].includes(await status()));
    second.abort();
    await secondRun;

    // then
    expect(launches).toHaveLength(2);
    expect(launches[1]).toEqual({ resume: launches[0]!.sessionId });
    expect(await status()).toBe("needs-review");
  });

  it("given Max's machine connected with the command Settings prints, when he starts a task kept for his machine, then the orchestrator describes it, his machine runs it and pushes the branch the orchestrator named with his git, and the orchestrator opens the request for review", async () => {
    // given
    const seeded = await seededContext("machine-served-", ["payments-skills"], "main", root);
    const ctx = seeded.ctx;
    const repo = (await ctx.store.getRepo(ctx.tenant, "payments-skills"))!;
    const forge = localRepoPath(repo.url)!;
    ctx.vault = createVault(randomBytes(32));
    ctx.memberUrls = new Map([[repo.id, FORGE]]);
    const owner: Principal = { id: "owner", name: "Owner", email: "owner@example.invalid", role: "owner", ownedTeams: [] };
    const max = await createUser(ctx.store, ctx.tenant, new Set([repo.team]), { email: MAX, role: "member", password: "correct horse battery" }, owner);
    const home = join(root, "home");
    mkdirSync(home);
    writeFileSync(join(home, ".gitconfig"), "[user]\n\tname = Max Example\n\temail = max@example.invalid\n");
    // The team's tests pass only when HOME is not Max's own, where his sign-ins are.
    ctx.tasks = createTaskRunner(ctx, { agents: [fakeAgentAdapter(FAKE_AGENT)], isolation: { mode: "process", network: "open" }, testCommand: () => `test "$HOME" != "${home}"`, hostEnv: { PATH: process.env.PATH }, timeoutMs: 120_000 });
    await ctx.tasks.ready();
    ctx.runnerService = organizationRunners(ctx);
    const app = createApp(ctx);
    const fetchImpl: Fetch = async (input, init) => {
      const url = new URL(String(input));
      return app.request(url.pathname + url.search, init);
    };
    const cookie = `${sessionCookie(ctx.tenant)}=${(await startSession(ctx.store, ctx.tenant, max.id)).token}`;
    const { csrf } = await (await app.request("/api/me", { headers: { cookie } })).json();
    const { code } = (await (await app.request("/api/machines/pair", { method: "POST", headers: { cookie, [CSRF_HEADER]: csrf, "content-type": "application/json" }, body: "{}" })).json()) as { code: string };
    const task: TaskRecord = { tenant: ctx.tenant, id: newId("tsk"), repoId: repo.id, team: repo.team, title: "Add an on-call note", description: "", issueUrl: null, issueKey: null, agent: "fake", status: "queued", createdBy: MAX, createdAt: new Date().toISOString(), startedAt: null, finishedAt: null, baseSha: null, tests: null, cost: { usd: null, inputTokens: null, outputTokens: null }, requestNumber: null, error: null, mode: "auto", runner: "local" };
    await ctx.store.createTask(task);
    const out: string[] = [];
    const stop = new AbortController();

    // when
    const started = runnerCommand(connectCommand(ADDRESS, code).split(" ").slice(2), { dataDir: join(root, "data-machine"), out: (t: string) => void out.push(t), err: (t: string) => void out.push(t), fetch: fetchImpl, name: "max-laptop", platform: "darwin-arm64", signal: stop.signal, adapters: [fakeAgentAdapter(FAKE_AGENT)], hostEnv: { PATH: process.env.PATH, HOME: home }, gitConfig: ["-c", `url.${forge}.insteadOf=${FORGE}`, "-c", "protocol.file.allow=always"], gitEnv: { GIT_ALLOW_PROTOCOL: "https:ssh:file" } });
    await until(async () => !["queued", "running"].includes((await ctx.store.getTask(ctx.tenant, task.id))!.status));
    stop.abort();
    const exit = await started;

    // then
    expect(exit).toBe(0);
    const done = (await ctx.store.getTask(ctx.tenant, task.id))!;
    const branch = (await ctx.store.taskLease(ctx.tenant, task.id))!.branch!;
    expect(done).toMatchObject({ status: "needs-review", tests: "passed", baseSha: repo.head, error: null });
    expect(git(["log", "-1", "--format=%an <%ae>", branch], forge)).toBe("Max Example <max@example.invalid>");
    expect(git(["rev-parse", `${branch}^`], forge)).toBe(repo.head);
    expect(await ctx.store.getRequest(ctx.tenant, repo.id, done.requestNumber!)).toMatchObject({ branch });
    const log = (await ctx.store.taskLog(ctx.tenant, task.id, 0)).map((l) => l.text);
    expect(log).toEqual(expect.arrayContaining([expect.stringContaining("Handed to"), expect.stringContaining(`Pushed ${branch} with your own git`)]));
  });
});

describe("a team member's machine, working in a folder of its own without git", { timeout: 120_000 }, () => {
  let root: string;
  beforeEach(() => void (root = realpathSync(mkdtempSync(join(tmpdir(), "machine-folder-served-")))));
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  it("given Max's machine connected and a folder of his opened as a project from it, when he starts a task there, then his machine works the folder in place, the orchestrator records only which files changed, and his undo puts the folder back through his machine", async () => {
    // given
    vi.stubEnv("ORCHESTRATOR_MODE", "self-hosted");
    const { ctx } = await seededContext("machine-folder-served-", ["payments-skills"], "main", root);
    const owner: Principal = { id: "owner", name: "Owner", email: "owner@example.invalid", role: "owner", ownedTeams: [] };
    const max = await createUser(ctx.store, ctx.tenant, new Set(["Payments"]), { email: MAX, role: "member", password: "correct horse battery" }, owner);
    ctx.tasks = createTaskRunner(ctx, { agents: [fakeAgentAdapter(FAKE_AGENT)], isolation: { mode: "process", network: "open" }, testCommand: () => null, hostEnv: { PATH: process.env.PATH }, timeoutMs: 120_000 });
    await ctx.tasks.ready();
    ctx.runnerService = organizationRunners(ctx);
    const app = createApp(ctx);
    const fetchImpl: Fetch = async (input, init) => {
      const url = new URL(String(input));
      return app.request(url.pathname + url.search, init);
    };
    const cookie = `${sessionCookie(ctx.tenant)}=${(await startSession(ctx.store, ctx.tenant, max.id)).token}`;
    const { csrf } = await (await app.request("/api/me", { headers: { cookie } })).json();
    const post = (path: string, body: unknown) => app.request(path, { method: "POST", headers: { cookie, [CSRF_HEADER]: csrf, "content-type": "application/json" }, body: JSON.stringify(body) });
    const { code } = (await (await post("/api/machines/pair", {})).json()) as { code: string };
    const home = join(root, "home");
    const folder = join(home, "code", "shop");
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "README.md"), "The shop.\n");
    const stop = new AbortController();
    const started = runnerCommand(connectCommand(ADDRESS, code).split(" ").slice(2), { dataDir: join(root, "data-machine"), out: () => {}, err: () => {}, fetch: fetchImpl, name: "max-laptop", platform: "darwin-arm64", signal: stop.signal, adapters: [fakeAgentAdapter(FAKE_AGENT)], hostEnv: { PATH: process.env.PATH, HOME: home } });
    let machineId = "";
    await until(async () => !!(machineId = (await ctx.store.listMachines(ctx.tenant, max.id))[0]?.id ?? ""));
    const opened = await post("/api/projects", { machineId, path: "~/code/shop" });
    const { project } = (await opened.json()) as { project: { id: string; team: string } };
    const task: TaskRecord = { tenant: ctx.tenant, id: newId("tsk"), repoId: project.id, team: project.team, title: "Add an on-call note", description: "", issueUrl: null, issueKey: null, agent: "fake", status: "queued", createdBy: MAX, createdAt: new Date().toISOString(), startedAt: null, finishedAt: null, baseSha: null, tests: null, cost: { usd: null, inputTokens: null, outputTokens: null }, requestNumber: null, error: null, mode: "auto", runner: "local" };
    await ctx.store.createTask(task);

    // when
    await until(async () => !["queued", "running"].includes((await ctx.store.getTask(ctx.tenant, task.id))!.status));
    const done = (await ctx.store.getTask(ctx.tenant, task.id))!;
    const written = existsSync(join(folder, "skills", "add-an-on-call-note", "SKILL.md"));
    const undo = await post(`/api/tasks/${task.id}/undo`, { commandId: "undo-on-machine-1" });
    const undone = (await undo.json()) as { undone: string[] };
    stop.abort();
    const exit = await started;

    // then
    expect(opened.status).toBe(200);
    expect(exit).toBe(0);
    expect(done).toMatchObject({ status: "needs-review", error: null, changes: { files: [expect.objectContaining({ path: "skills/add-an-on-call-note/SKILL.md" })] } });
    expect(JSON.stringify(done.changes)).not.toContain("Written by the stand-in agent");
    expect(written).toBe(true);
    expect(undo.status).toBe(200);
    expect(undone.undone).toEqual(["skills/add-an-on-call-note/SKILL.md"]);
    expect(existsSync(join(folder, "skills"))).toBe(false);
    expect(readFileSync(join(folder, "README.md"), "utf8")).toBe("The shop.\n");
    expect(existsSync(join(folder, ".git"))).toBe(false);
  });
});

describe("a task on a team's repository stopped on its person's machine", { timeout: 60_000 }, () => {
  let root: string;
  beforeEach(() => void (root = realpathSync(mkdtempSync(join(tmpdir(), "machine-stop-")))));
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("given an agent that changed the checkout and is still working, when its person stops the task, then the change is pushed on the task's branch with their git and the task waits for review with why it stopped", async () => {
    // given
    const bare = join(root, "forge.git");
    git(["init", "--quiet", "--bare", "--initial-branch=main", bare], root);
    const seed = join(root, "seed");
    git(["clone", "--quiet", bare, seed], root);
    writeFileSync(join(seed, "README.md"), "payments skills\n");
    git(["-c", "user.name=Seed", "-c", "user.email=seed@example.invalid", "add", "-A"], seed);
    git(["-c", "user.name=Seed", "-c", "user.email=seed@example.invalid", "commit", "--quiet", "-m", "start"], seed);
    git(["-C", bare, "fetch", "--quiet", seed, "HEAD:refs/heads/main"], root);
    const baseSha = git(["rev-parse", "HEAD"], seed);
    const home = join(root, "home");
    mkdirSync(home);
    writeFileSync(join(home, ".gitconfig"), "[user]\n\tname = Max Example\n\temail = max@example.invalid\n");
    const base = fakeAgentAdapter(FAKE_AGENT);
    const writing: AgentAdapter = {
      ...base,
      twoWay: {
        capabilities: base.twoWay!.capabilities,
        launch(paths, setup, options) {
          writeFileSync(join(paths.work, "ON-CALL.md"), "Page the on-call engineer.\n");
          return base.twoWay!.launch(paths, setup, options);
        },
      },
    };
    const work: CheckoutWork = { prompt: "Task: Add a note\nstand-in: wait 30 seconds", mode: "auto", choices: null, setup: { plugin: null, mcpTools: [], deniedTools: [] }, limits: { timeoutMs: 60_000, testCommand: null, verification: null }, rules: [], repo: { url: FORGE, baseBranch: "main", baseSha }, branch: "task/tsk_stop_1" };
    const controller = new AbortController();
    const hooks: ExecutorHooks = { signal: controller.signal, onEvent: () => {}, log: () => {}, record: () => {}, onProcess: () => setTimeout(() => controller.abort(new Error(STOPPED)), 300), decide: async () => ({ decision: "deny" }), leaseHeld: async () => true };
    const executor = machineExecutor({ dataDir: join(root, "data"), org: "acme", machineId: "mch_here", adapters: [writing], hostEnv: { PATH: process.env.PATH, HOME: home }, gitConfig: ["-c", `url.${bare}.insteadOf=${FORGE}`, "-c", "protocol.file.allow=always"], gitEnv: { GIT_ALLOW_PROTOCOL: "https:ssh:file" } });

    // when
    const outcome = await executor.run({ id: "tsk_stop_1", title: "Add a note", agent: "fake", nativeSession: null, work }, hooks);

    // then
    expect(outcome).toMatchObject({ status: "needs-review", error: STOPPED, branch: "task/tsk_stop_1" });
    expect(git(["show", "task/tsk_stop_1:ON-CALL.md"], bare)).toBe("Page the on-call engineer.");
    expect(git(["rev-parse", "task/tsk_stop_1^"], bare)).toBe(baseSha);
  });
});
