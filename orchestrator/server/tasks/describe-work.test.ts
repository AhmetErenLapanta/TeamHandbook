import { randomBytes } from "node:crypto";
import { rmSync } from "node:fs";
import { join } from "node:path";
import type { MiddlewareHandler } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { createUser, principalOf } from "../accounts.js";
import type { RunnerService } from "../runner-service.js";
import { startTask } from "./routes.js";
import { createApp } from "../app.js";
import type { OrchestratorContext } from "../app.js";
import type { OrchestratorEnv, Principal } from "../auth.js";
import type { AddedRepo } from "../connect.js";
import { newId } from "../ids.js";
import { setTaskSecret } from "../task-secrets.js";
import { seededContext } from "../test-fixtures.js";
import { createVault } from "../vault.js";
import { fakeAgentAdapter } from "./agents.js";
import { Redactor } from "./redact.js";
import { CONTINUE_AFTER_STOP, createTaskRunner, prompt, TASK_LIMITS_SETTING } from "./runner.js";
import { UNKNOWN_COST } from "./types.js";
import type { TaskRecord } from "./types.js";
import type { CheckoutWork, FolderWork, WorkspaceWork } from "../../runner/link.js";
import { checkedWork } from "../runner-service.js";
import { readEvidence } from "./verify.js";
import { ATTACHMENT_LIMITS } from "../attachments.js";
import { handedChecks } from "./leased.js";
import { machineProjectUrl } from "../projects.js";
import { CONTINUE_AFTER_LIMIT } from "./adapters/failure.js";

const OWNER: Principal = { id: "owner", name: "Owner", email: "owner@example.invalid", role: "owner", ownedTeams: [] };
const FAKE_AGENT = join(import.meta.dirname, "..", "..", "demo", "fake-agent.mjs");
const TOKEN = "ghp_0123456789abcdefghijklmnopqrstuvwxyzAB";
const TEAM_VALUE = "team-registry-token-0123456789";
const MEMBER_URL = "https://git.example.invalid/acme/payments-skills.git";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A task kept for its starter's machine on the seeded Payments repository, whose team holds a task secret. */
async function kept(overrides: Partial<TaskRecord> = {}, { member = true } = {}): Promise<{ ctx: OrchestratorContext; task: TaskRecord }> {
  const { ctx, root } = await seededContext("orchestrator-describe-work-", ["payments-skills"]);
  dirs.push(root);
  ctx.vault = createVault(randomBytes(32));
  if (member) ctx.memberUrls = new Map([["payments-skills", MEMBER_URL]]);
  await createUser(ctx.store, ctx.tenant, new Set(["Payments"]), { email: "ada@example.invalid", name: "Ada Example", role: "admin" }, OWNER);
  await setTaskSecret(ctx, { ...OWNER, role: "admin" }, { scope: "team", target: "Payments", name: "NPM_TOKEN", value: TEAM_VALUE });
  ctx.tasks = createTaskRunner(ctx, { agents: [fakeAgentAdapter(FAKE_AGENT)], isolation: { mode: "process", network: "open" }, testCommand: () => `npm test --token ${TEAM_VALUE}`, hostEnv: { PATH: process.env.PATH }, timeoutMs: 600_000 });
  await ctx.tasks.ready();
  const repo = (await ctx.store.getRepo(ctx.tenant, "payments-skills"))!;
  const task: TaskRecord = { tenant: ctx.tenant, id: newId("tsk"), repoId: repo.id, team: repo.team, title: "Add an on-call note", description: `Use ${TOKEN} and ${TEAM_VALUE} to reach the registry.`, issueUrl: null, issueKey: null, agent: "fake", status: "queued", createdBy: "ada@example.invalid", createdAt: new Date().toISOString(), startedAt: null, finishedAt: null, baseSha: null, tests: null, cost: UNKNOWN_COST, requestNumber: null, error: null, template: null, mode: "auto", ...overrides };
  await ctx.store.createTask(task);
  return { ctx, task };
}

describe("a task described for its person's machine", { timeout: 120_000 }, () => {
  it("given a policy that keeps the person's own setup out of Payments' repositories, when the machine leases a task there and one elsewhere is described before it, then the first carries the sign-in alone and names the policy in the log, and the second carries the person's own setup", async () => {
    // given
    const { ctx, task } = await kept();
    const open = (await ctx.tasks!.describeWork(task.id)) as CheckoutWork;
    await ctx.store.putPolicy({ tenant: ctx.tenant, id: "pol_team_setup", name: "Payments keeps to the team's setup", audience: JSON.stringify({ kind: "workspace" }), rules: JSON.stringify([{ kind: "own-setup", allowed: false, repos: ["payments-*"] }]), updatedAt: new Date().toISOString(), updatedBy: OWNER.email });

    // when
    const narrowed = (await ctx.tasks!.describeWork(task.id)) as CheckoutWork;

    // then
    expect(open.setup.ownSetup).toBe(true);
    expect(narrowed.setup.ownSetup).toBe(false);
    const log = (await ctx.store.taskLog(ctx.tenant, task.id, 0)).map((l) => l.text);
    expect(log).toContain(`Runs as you with your Claude Code sign-in alone: "Payments keeps to the team's setup" keeps the rest of your Claude Code setup out of tasks here.`);
  });

  it("given a task whose description holds a token and a task secret, when it is described twice, then the prompt is the one a run here builds with both masked, no secret is in the description, and the branch and base are the orchestrator's and the same both times", async () => {
    // given
    const { ctx, task } = await kept();
    const repo = (await ctx.store.getRepo(ctx.tenant, task.repoId))!;

    // when
    const first = (await ctx.tasks!.describeWork(task.id)) as CheckoutWork;
    const again = (await ctx.tasks!.describeWork(task.id)) as CheckoutWork;

    // then
    const sent = JSON.stringify(first);
    expect(sent).not.toContain(TOKEN);
    expect(sent).not.toContain(TEAM_VALUE);
    expect(first.prompt).toContain("[redacted");
    const redactor = new Redactor([TEAM_VALUE]);
    expect(first.prompt).toBe(prompt(repo, task.title, task.description, null, null, null).split("\n").map((line) => redactor.line(line)).join("\n"));
    expect(first).toMatchObject({ mode: "auto", choices: null, repo: { url: MEMBER_URL, baseSha: repo.head }, limits: { timeoutMs: 600_000, testCommand: expect.stringContaining("[redacted") } });
    expect(again.branch).toBe(first.branch);
    expect((await ctx.store.taskLease(ctx.tenant, task.id))!.branch).toBe(first.branch);
    expect((await ctx.store.getTask(ctx.tenant, task.id))!.baseSha).toBe(repo.head);
  });

  it("given the orchestrator's configured check holding a team secret, when a machine is handed the task, then it is told to run that check before and after the agent with the secret masked and the repair rounds allowed; with no check, none is handed and the task's evidence says why", async () => {
    // given
    const { ctx, task } = await kept();
    const { ctx: bare, task: unchecked } = await kept();
    bare.tasks = createTaskRunner(bare, { agents: [fakeAgentAdapter(FAKE_AGENT)], isolation: { mode: "process", network: "open" }, testCommand: () => null, hostEnv: { PATH: process.env.PATH } });

    // when
    const work = (await ctx.tasks!.describeWork(task.id)) as CheckoutWork;
    const none = (await bare.tasks.describeWork(unchecked.id)) as CheckoutWork;

    // then
    expect(work.limits.verification).toEqual({ plan: { checks: [{ command: "[redacted:cli-credential-flag]", runs: "[redacted:cli-credential-flag]", source: "the orchestrator's configuration" }], setup: null, approved: null }, maxRepairs: 2 });
    expect(JSON.stringify(work)).not.toContain(TEAM_VALUE);
    expect(await handedChecks(ctx.store, ctx.tenant, task.id)).toEqual(work.limits.verification);
    expect(none.limits.verification).toBeNull();
    expect(await handedChecks(bare.store, bare.tenant, unchecked.id)).toBeNull();
    expect(await readEvidence(bare.store, bare.tenant, unchecked.id, unchecked.repoId)).toMatchObject({ verdict: "not-run", reason: expect.stringContaining("No check is approved for this project") });
  });

  it("given a project's MCP servers, one of them picked for the task, when a machine is handed it, then the picked one goes as a template naming the variables the person's environment fills, no value of it, and the other stays behind", async () => {
    // given
    const servers = [
      { id: "mcp_issues", name: "issues", transport: "http", url: "https://issues.example.invalid/mcp", headers: ["Authorization"] },
      { id: "mcp_search", name: "search", transport: "stdio", command: "search-mcp", args: ["--read-only"], env: ["SEARCH_TOKEN"] },
      { id: "mcp_other", name: "other", transport: "stdio", command: "other-mcp", args: [], env: [] },
    ];
    const { ctx, task } = await kept({ tools: { skills: [], mcpServers: ["mcp_issues", "mcp_search"] } });
    await ctx.store.setSetting(ctx.tenant, `project.tools.${task.repoId}`, JSON.stringify({ skillSources: [], mcpServers: servers }));

    // when
    const work = (await ctx.tasks!.describeWork(task.id)) as CheckoutWork;

    // then
    expect(work.setup.mcpServers).toEqual({
      issues: { type: "http", url: "https://issues.example.invalid/mcp", headers: { Authorization: "${ISSUES_AUTHORIZATION}" } },
      search: { type: "stdio", command: "search-mcp", args: ["--read-only"], env: { SEARCH_TOKEN: "${SEARCH_TOKEN}" } },
    });
    expect((await ctx.store.taskLog(ctx.tenant, task.id, 0)).map((l) => l.text)).toContain("The project's MCP servers for this task go to the machine, each filled there from your own environment: issues, search.");
  });

  it("given a folder on its person's machine with a check approved for it, when the machine is handed its task, then the check goes as approved, what it runs masked and who approved it left out, for the machine to match against its own files", async () => {
    // given
    const { ctx, task } = await kept();
    ctx.tasks = createTaskRunner(ctx, { agents: [fakeAgentAdapter(FAKE_AGENT)], isolation: { mode: "process", network: "open" }, testCommand: () => null, hostEnv: { PATH: process.env.PATH } });
    await ctx.store.upsertRepo({ tenant: ctx.tenant, id: "shop", team: "Payments", name: "shop", url: machineProjectUrl("mch_laptop", "~/code/shop") });
    const check = { kind: "test" as const, command: "npm test", runs: `node test.js --registry-token ${TEAM_VALUE}`, source: "package.json script test", network: false, long: false, digest: "d".repeat(64) };
    await ctx.store.setSetting(ctx.tenant, "verify.approved.shop", JSON.stringify({ checks: [check], setup: null, by: "Owner", at: new Date().toISOString() }));
    const onMachine: TaskRecord = { ...task, id: "tsk_folderchecks000000000000", repoId: "shop" };
    await ctx.store.createTask(onMachine);

    // when
    const work = checkedWork(await ctx.tasks.describeWork(onMachine.id)) as FolderWork;

    // then
    const handed = work.limits.verification!;
    expect(handed.plan.checks).toEqual([{ ...check, runs: expect.stringContaining("[redacted") }]);
    expect(handed.plan.approved).toMatchObject({ checks: [{ command: "npm test", source: "package.json script test", digest: check.digest }], by: "" });
    expect(JSON.stringify(work)).not.toContain(TEAM_VALUE);
    expect(await handedChecks(ctx.store, ctx.tenant, onMachine.id)).toEqual(handed);
  });

  it("given files attached to a task, one named no file's name, when a machine leases it, then the lease names each by id, safe name and kind for the machine to fetch, and the machine's own rules take it", async () => {
    // given
    const { ctx, task } = await kept();
    const at = new Date().toISOString();
    await ctx.store.insertAttachment({ tenant: ctx.tenant, id: "att_shot", taskId: task.id, name: "screenshot.png", mime: "image/png", size: 3, sha256: "0".repeat(64), createdBy: OWNER.email, createdAt: at }, ATTACHMENT_LIMITS);
    await ctx.store.insertAttachment({ tenant: ctx.tenant, id: "att_dots", taskId: task.id, name: "..", mime: "text/plain", size: 3, sha256: "1".repeat(64), createdBy: OWNER.email, createdAt: new Date(Date.parse(at) + 1000).toISOString() }, ATTACHMENT_LIMITS);

    // when
    const work = checkedWork(await ctx.tasks!.describeWork(task.id)) as CheckoutWork;

    // then
    expect(work.attachments).toEqual([
      { id: "att_shot", name: "screenshot.png", kind: "image" },
      { id: "att_dots", name: "attachment", kind: "text" },
    ]);
  });

  it("given a task whose last run asked its starter and was answered, when a machine leases it, then the prompt carries the answer as data once and the task keeps no answer for a later run", async () => {
    // given
    const { ctx, task } = await kept();
    await ctx.store.updateTask(ctx.tenant, task.id, { question: { text: "Can you paste the issue's text?", options: ["Paste it here", "Skip the issue"], answer: "The refund lookup takes an order id." } });

    // when
    const work = checkedWork(await ctx.tasks!.describeWork(task.id));

    // then
    expect(work.prompt).toContain("Your last run stopped to ask the person: Can you paste the issue's text?");
    expect(work.prompt).toContain("The refund lookup takes an order id.");
    expect((await ctx.store.getTask(ctx.tenant, task.id))!.question ?? null).toBeNull();
  });

  it("given tasks on a machine cut off at the usage limit that went on after its reset, one with its agent's session and one without, when each is described and the first once more, then the first hand-out with a session is told to go on with care after the limit, the next as a cut-off run, and the one without a session carries the task", async () => {
    // given
    const { ctx, task } = await kept({ runner: "local" });
    const other: TaskRecord = { ...task, id: newId("tsk"), createdAt: new Date(Date.now() + 1).toISOString() };
    await ctx.store.createTask(other);
    const resetAt = new Date(Date.now() + 3_600_000).toISOString();
    const cutOff = async (id: string, session: string | null) => {
      const at = new Date().toISOString();
      await ctx.store.claimLocalTask(ctx.tenant, "ada@example.invalid", "mch_1", `lease_${id}`, new Date(Date.now() + 90_000).toISOString(), at);
      await ctx.store.finishLeasedTask(ctx.tenant, id, `lease_${id}`, { status: "interrupted", error: "The demo agent reached its usage limit.", nativeSession: session, branch: null, limitResetAt: resetAt }, at);
      await ctx.store.continueAfterLimit(ctx.tenant, id, resetAt);
      await ctx.store.claimLocalTask(ctx.tenant, "ada@example.invalid", "mch_1", `again_${id}`, new Date(Date.now() + 90_000).toISOString(), at);
    };
    await cutOff(task.id, "sess-1");
    await cutOff(other.id, null);

    // when
    const described = async (id: string) => checkedWork(await ctx.tasks!.describeWork(id)).prompt;
    const goesOn = await described(task.id);
    const fresh = await described(other.id);
    const again = await described(task.id);

    // then
    expect(goesOn).toBe(CONTINUE_AFTER_LIMIT);
    expect(fresh).toContain("Add an on-call note");
    expect(again).toBe(CONTINUE_AFTER_STOP);
  });

  it("given no time limit of the operator's own, when a machine leases a task under a 45-minute cap and then under none, then its run's time is the cap on screen and then has no end of its own", async () => {
    // given
    const { ctx, task } = await kept({});
    ctx.tasks = createTaskRunner(ctx, { agents: [fakeAgentAdapter(FAKE_AGENT)], isolation: { mode: "process", network: "open" }, testCommand: () => null, hostEnv: { PATH: process.env.PATH } });
    const capped = async (maxMinutes: number | null) => {
      await ctx.store.setSetting(ctx.tenant, TASK_LIMITS_SETTING, JSON.stringify({ maxUsd: 10, maxMinutes }));
      return checkedWork(await ctx.tasks!.describeWork(task.id)).limits.timeoutMs;
    };

    // when
    const times = [await capped(45), await capped(null)];

    // then
    expect(times).toEqual([45 * 60_000, 2 ** 31 - 1]);
  });

  it("given a task started to plan first, when a machine leases it, then its work says so, and a task that did not says nothing", async () => {
    // given
    const planning = await kept({ planFirst: true });
    const plain = await kept({});

    // when
    const [first, second] = [checkedWork(await planning.ctx.tasks!.describeWork(planning.task.id)), checkedWork(await plain.ctx.tasks!.describeWork(plain.task.id))];

    // then
    expect([first.planFirst, second.planFirst]).toEqual([true, undefined]);
  });

  it("given a folder on its person's machine that holds two repositories, when the machine leases its task, then it is handed one workspace on one task branch, kept for a lease taken again, with no folder to work in place and no check yet", async () => {
    // given
    const { ctx, task } = await kept();
    await ctx.store.upsertRepo({ tenant: ctx.tenant, id: "code", team: "Payments", name: "code", url: machineProjectUrl("mch_laptop", "~/code") });
    ctx.addedRepos = new Map([["code", { id: "code", forge: "machine", kind: "code", skillsFrom: null, gitOrigin: null, memberUrl: null, machine: { id: "mch_laptop", path: "~/code", name: "code", git: "none", repos: 2 }, addedBy: OWNER.email, addedAt: new Date().toISOString() }]]);
    const inWorkspace: TaskRecord = { ...task, id: "tsk_workspace0000000000000000", repoId: "code" };
    await ctx.store.createTask(inWorkspace);

    // when
    const work = checkedWork(await ctx.tasks!.describeWork(inWorkspace.id)) as WorkspaceWork;
    const again = checkedWork(await ctx.tasks!.describeWork(inWorkspace.id)) as WorkspaceWork;

    // then
    expect(work.workspace).toEqual({ machineId: "mch_laptop", projectId: "code", path: "~/code" });
    expect(work).not.toHaveProperty("folder");
    expect(work.branch).toEqual(expect.any(String));
    expect(again.branch).toBe(work.branch);
    expect(work.limits.verification).toBeNull();
  });

  it("given a task on a folder of repositories cut off at the usage limit that went on after the reset, when the machine leases it twice, then it is first told to go on with care and then as a cut-off run, never the whole task again", async () => {
    // given
    const { ctx, task } = await kept();
    await ctx.store.upsertRepo({ tenant: ctx.tenant, id: "code", team: "Payments", name: "code", url: machineProjectUrl("mch_laptop", "~/code") });
    ctx.addedRepos = new Map([["code", { id: "code", forge: "machine", kind: "code", skillsFrom: null, gitOrigin: null, memberUrl: null, machine: { id: "mch_laptop", path: "~/code", name: "code", git: "none", repos: 2 }, addedBy: OWNER.email, addedAt: new Date().toISOString() }]]);
    const inWorkspace: TaskRecord = { ...task, id: "tsk_workspacelimit000000000000", repoId: "code", runner: "local" };
    await ctx.store.createTask(inWorkspace);
    const resetAt = new Date(Date.now() + 3_600_000).toISOString();
    const at = new Date().toISOString();
    await ctx.store.claimLocalTask(ctx.tenant, "ada@example.invalid", "mch_laptop", "lease_ws_1", new Date(Date.now() + 90_000).toISOString(), at);
    await ctx.store.finishLeasedTask(ctx.tenant, inWorkspace.id, "lease_ws_1", { status: "interrupted", error: "The demo agent reached its usage limit.", nativeSession: "sess-ws", branch: null, limitResetAt: resetAt }, at);
    await ctx.store.continueAfterLimit(ctx.tenant, inWorkspace.id, resetAt);
    await ctx.store.claimLocalTask(ctx.tenant, "ada@example.invalid", "mch_laptop", "lease_ws_2", new Date(Date.now() + 90_000).toISOString(), at);

    // when
    const first = (checkedWork(await ctx.tasks!.describeWork(inWorkspace.id)) as WorkspaceWork).prompt;
    const again = (checkedWork(await ctx.tasks!.describeWork(inWorkspace.id)) as WorkspaceWork).prompt;

    // then
    expect([first, again]).toEqual([CONTINUE_AFTER_LIMIT, CONTINUE_AFTER_STOP]);
  });

  it("given a folder task that left a request open in one repository, a change on its machine in another and a merged request in a third, when its person sends more and its machine leases it, then a machine that knows how gets where each goes on and the words, and one from before gets neither the offer nor the list", async () => {
    // given
    const { ctx, task } = await kept();
    await ctx.store.upsertRepo({ tenant: ctx.tenant, id: "code", team: "Payments", name: "code", url: machineProjectUrl("mch_laptop", "~/code") });
    ctx.addedRepos = new Map([["code", { id: "code", forge: "machine", kind: "code", skillsFrom: null, gitOrigin: null, memberUrl: null, machine: { id: "mch_laptop", path: "~/code", name: "code", git: "none", repos: 3 }, addedBy: OWNER.email, addedAt: new Date().toISOString() }]]);
    const now = new Date().toISOString();
    const ada = (await ctx.store.listUsers(ctx.tenant)).find((u) => u.email === "ada@example.invalid")!;
    for (const id of ["mch_laptop", "mch_old"]) await ctx.store.insertMachine({ tenant: ctx.tenant, id, userId: ada.id, name: id, platform: "darwin", publicKey: "", agents: [], createdAt: now, lastSeenAt: now, revokedAt: null, tokenHash: (id === "mch_old" ? "e" : "d").repeat(64) }, null);
    await ctx.store.touchMachine(ctx.tenant, "mch_laptop", now, undefined, ["workspace-continues"]);
    await ctx.store.saveRequest({ tenant: ctx.tenant, repoId: "payments-skills", number: 4, provider: "local", url: "local://requests/payments-skills/4", branch: "task/folder", headSha: "a".repeat(40), title: "Add a note", status: "open", createdAt: now, createdBy: "ada@example.invalid" });
    await ctx.store.recordRequestCheck(ctx.tenant, "payments-skills", 4, { head: "a".repeat(40), passed: true });
    await ctx.store.saveRequest({ tenant: ctx.tenant, repoId: "payments-skills", number: 5, provider: "local", url: "local://requests/payments-skills/5", branch: "task/folder", headSha: "c".repeat(40), title: "Add a note", status: "merged", createdAt: now, createdBy: "ada@example.invalid" });
    const targets = [
      { repoId: "payments-skills", status: "request" as const, reason: "changed by the agent in alpha", path: "alpha", baseSha: "1".repeat(40), branch: "task/folder", tests: null, requestNumber: 4, error: null, cost: UNKNOWN_COST },
      { repoId: "code", status: "local" as const, reason: "no-remote", path: "beta", head: "b".repeat(40), baseSha: "2".repeat(40), branch: "task/folder", tests: null, requestNumber: null, error: null, cost: UNKNOWN_COST },
      { repoId: "payments-skills", status: "request" as const, reason: "changed by the agent in gamma", path: "gamma", baseSha: "3".repeat(40), branch: "task/folder", tests: null, requestNumber: 5, error: null, cost: UNKNOWN_COST },
    ];
    const reviewed = async (id: string, machine: string): Promise<TaskRecord> => {
      const record: TaskRecord = { ...task, id, repoId: "code", runner: "local", status: "queued" };
      await ctx.store.createTask(record);
      await ctx.store.claimLocalTask(ctx.tenant, "ada@example.invalid", machine, `lease_${id}`, new Date(Date.now() + 90_000).toISOString(), now);
      await ctx.store.finishLeasedTask(ctx.tenant, id, `lease_${id}`, { status: "needs-review", error: null, nativeSession: null, branch: "task/folder" }, now);
      await ctx.store.setTaskTargets(ctx.tenant, id, targets);
      return (await ctx.store.getTask(ctx.tenant, id))!;
    };
    const knows = await reviewed(newId("tsk"), "mch_laptop");
    const older = await reviewed(newId("tsk"), "mch_old");
    const signedIn: MiddlewareHandler<OrchestratorEnv> = async (c, next) => {
      c.set("user", { ...OWNER, id: ada.id, email: ada.email, name: ada.name, role: "admin" });
      await next();
    };
    const app = createApp(ctx, signedIn);
    const send = (id: string) => app.request(`/api/tasks/${id}/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "Also name the escalation lead.", commandId: `more-${id.slice(-12)}` }) });

    // when
    const offers = [(await (await app.request(`/api/tasks/${knows.id}`)).json()).task.followUp, (await (await app.request(`/api/tasks/${older.id}`)).json()).task.followUp];
    const sent = [await send(knows.id), await send(older.id)];
    await ctx.store.claimLocalTask(ctx.tenant, "ada@example.invalid", "mch_laptop", "lease_again", new Date(Date.now() + 90_000).toISOString(), now);
    const work = checkedWork(await ctx.tasks!.describeWork(knows.id)) as WorkspaceWork;

    // then
    expect(offers).toEqual(["continue", null]);
    expect(sent.map((r) => r.status)).toEqual([202, 409]);
    expect(work.continues).toEqual({ repos: [{ path: "alpha", head: "a".repeat(40), baseSha: "1".repeat(40) }, { path: "beta", head: "b".repeat(40), baseSha: "2".repeat(40) }] });
    expect(work.branch).toBe("task/folder");
    expect(work.prompt).toContain("Also name the escalation lead.");
  });

  it("given a folder on its person's machine that is one git repository itself, when the machine leases its task, then it is handed a workspace on a task branch, told it works in a copy, with no folder settings and nothing in place", async () => {
    // given
    const { ctx, task } = await kept();
    await ctx.store.upsertRepo({ tenant: ctx.tenant, id: "delivery", team: "Payments", name: "delivery", url: machineProjectUrl("mch_laptop", "~/work/delivery") });
    ctx.addedRepos = new Map([["delivery", { id: "delivery", forge: "machine", kind: "code", skillsFrom: null, gitOrigin: null, memberUrl: null, machine: { id: "mch_laptop", path: "~/work/delivery", name: "delivery", git: "origin" }, addedBy: OWNER.email, addedAt: new Date().toISOString() }]]);
    const inRepo: TaskRecord = { ...task, id: "tsk_onerepo00000000000000000", repoId: "delivery" };
    await ctx.store.createTask(inRepo);

    // when
    const work = checkedWork(await ctx.tasks!.describeWork(inRepo.id)) as WorkspaceWork;

    // then
    expect(work.workspace).toEqual({ machineId: "mch_laptop", projectId: "delivery", path: "~/work/delivery" });
    expect(work).not.toHaveProperty("folder");
    expect(work.branch).toEqual(expect.any(String));
    expect(work.setup.folderSettings).toBe(false);
    expect(work.prompt).toContain("You are working in a copy of delivery");
    expect(work.prompt).not.toContain("not a git repository");
    expect((await ctx.store.taskLog(ctx.tenant, inRepo.id, 0)).map((l) => l.text).join("\n")).toContain("to work on a copy of each repository in ~/work/delivery on the task's branch.");
  });

  it("given a project in a folder without git on its person's machine, when the machine leases its task, then it is handed the folder to work in place, named from the machine's home, with the team's policies and the in-place prompt, and nothing of a checkout", async () => {
    // given
    const { ctx, task } = await kept();
    await ctx.store.upsertRepo({ tenant: ctx.tenant, id: "shop", team: "Payments", name: "shop", url: machineProjectUrl("mch_laptop", "~/code/shop") });
    const onMachine: TaskRecord = { ...task, id: "tsk_onmachine0000000000000000", repoId: "shop" };
    await ctx.store.createTask(onMachine);

    // when
    const work = checkedWork(await ctx.tasks!.describeWork(onMachine.id)) as FolderWork;

    // then
    expect(work.folder).toEqual({ machineId: "mch_laptop", projectId: "shop", path: "~/code/shop" });
    expect(work).not.toHaveProperty("repo");
    expect(work).not.toHaveProperty("branch");
    expect(work.rules).toEqual([]);
    expect(work.prompt).toContain("a folder on this person's machine that is not a git repository");
    expect(JSON.stringify(work)).not.toContain(TEAM_VALUE);
    expect((await ctx.store.taskLog(ctx.tenant, onMachine.id, 0)).map((l) => l.text)).toContain("Handed to Ada Example's machine, to work in ~/code/shop in place.");
  });

  it("given a project in a folder on its person's machine that the orchestrator never reads, when its person starts a task there, then the start is taken and the task waits for that machine", async () => {
    // given
    const { ctx } = await kept();
    ctx.runnerService = { wake: () => {}, stop: () => {} } as unknown as RunnerService;
    await ctx.store.upsertRepo({ tenant: ctx.tenant, id: "shop", team: "Payments", name: "shop", url: machineProjectUrl("mch_laptop", "~/code/shop") });
    const ada = await principalOf(ctx.store, (await ctx.store.listUsers(ctx.tenant)).find((u) => u.email === "ada@example.invalid")!);
    const seen = new Date().toISOString();
    await ctx.store.insertMachine({ tenant: ctx.tenant, id: "mch_laptop", userId: ada.id, name: "laptop", platform: "darwin", publicKey: "", agents: [], createdAt: seen, lastSeenAt: seen, revokedAt: null, tokenHash: "0".repeat(64) }, null);

    // when
    const started = await startTask(ctx, ctx.tasks!, ada, { repoId: "shop", title: "Add a list", agent: "fake" });

    // then
    expect(started).toMatchObject({ task: { repoId: "shop", status: "queued", runner: "local" } });
  });

  it("given a mode ceiling put on Payments' repositories after a task in Auto was taken, when a machine is handed it and when it runs here, then neither runs and each says the policy's sentence", async () => {
    // given
    const { ctx, task } = await kept();
    const ada = await principalOf(ctx.store, (await ctx.store.listUsers(ctx.tenant)).find((u) => u.email === "ada@example.invalid")!);
    await ctx.store.putPolicy({ tenant: ctx.tenant, id: "pol_ask_first", name: "Ask first", audience: JSON.stringify({ kind: "workspace" }), rules: JSON.stringify([{ kind: "task-mode", ceiling: "approval-required", repos: ["payments-*"] }]), updatedAt: new Date().toISOString(), updatedBy: OWNER.email });
    const repo = (await ctx.store.getRepo(ctx.tenant, task.repoId))!;

    // when
    const described = ctx.tasks!.describeWork(task.id);
    const here = await ctx.tasks!.start({ repo, title: "Add an on-call note", description: "", agent: "fake", user: ada, mode: "auto" });
    await ctx.tasks!.idle();

    // then
    const sentence = '"Ask first" lets tasks on payments-skills run up to Approval required; this task asked for Auto. Start it in Approval required or below';
    await expect(described).rejects.toThrow(sentence);
    expect(await ctx.store.getTask(ctx.tenant, here.id)).toMatchObject({ status: "failed", error: expect.stringContaining(`The task did not run: ${sentence}`) });
  });

  it.each([
    ["a repository with no member address", {}, { member: false }, /has no memberUrl/],
    ["a task over several repositories", { targetMode: "pinned" as const, targets: [] }, {}, /runs on the orchestrator/],
    ["a delegated task", { parentId: "tsk_parent00000", depth: 1 }, {}, /runs on the orchestrator/],
  ])("given %s, when it is described, then it is refused with why and nothing is recorded", async (_case, overrides, options, why) => {
    // given
    const { ctx, task } = await kept(overrides, options);

    // when
    const described = ctx.tasks!.describeWork(task.id);

    // then
    await expect(described).rejects.toThrow(why);
    expect((await ctx.store.taskLease(ctx.tenant, task.id))!.branch).toBeNull();
  });
});

describe("a person's machine projects on the new task form", { timeout: 120_000 }, () => {
  it("given a folder without git and a git repository on Ada's machine and a project on another person's machine, when Ada reads the form's options, then both of hers are offered with her machine's name, the one without git ending in place and the repository in a request, and the other person's is not offered", async () => {
    // given
    const { ctx } = await kept();
    const ada = await principalOf(ctx.store, (await ctx.store.listUsers(ctx.tenant)).find((u) => u.email === "ada@example.invalid")!);
    const seen = new Date().toISOString();
    const machine = (id: string, userId: string, name: string) => ctx.store.insertMachine({ tenant: ctx.tenant, id, userId, name, platform: "darwin", publicKey: "", agents: [], createdAt: seen, lastSeenAt: seen, revokedAt: null, tokenHash: id.padEnd(64, "0").slice(0, 64) }, null);
    await machine("mch_laptop", ada.id, "laptop");
    await machine("mch_desk", "usr_lee", "desk");
    const projects = [["shop", "mch_laptop", "none"], ["api", "mch_laptop", "repo"], ["notes", "mch_desk", "none"]] as const;
    for (const [id, machineId] of projects) await ctx.store.upsertRepo({ tenant: ctx.tenant, id, team: "Payments", name: id, url: machineProjectUrl(machineId, `~/code/${id}`) });
    ctx.addedRepos = new Map(projects.map(([id, machineId, git]) => [id, { id, kind: "code", machine: { id: machineId, path: `~/code/${id}`, name: id, git } } as AddedRepo]));
    const as: MiddlewareHandler<OrchestratorEnv> = async (c, next) => {
      c.set("user", ada);
      await next();
    };

    // when
    const options = await (await createApp(ctx, as).request("/api/tasks/options")).json();

    // then
    const offered = (options.repos as { id: string; result: string; machine?: string }[]).filter((r) => r.machine !== undefined || ["shop", "api", "notes"].includes(r.id));
    expect(offered.map((r) => [r.id, r.result, r.machine]).sort()).toEqual([["api", "request", "laptop"], ["shop", "changes", "laptop"]]);
  });
});

describe("a person's machine projects in the project lists", { timeout: 120_000 }, () => {
  it("given a member's machine project, an admin's and the team's repository, when the member and the admin read the projects and the repositories, then the member is shown the team's and their own but not the admin's folder, and the admin is shown all three", async () => {
    // given
    const { ctx } = await kept();
    await createUser(ctx.store, ctx.tenant, new Set(["Payments"]), { email: "max@example.invalid", name: "Max Example", role: "member" }, OWNER);
    const people = await ctx.store.listUsers(ctx.tenant);
    const ada = await principalOf(ctx.store, people.find((u) => u.email === "ada@example.invalid")!);
    const max = await principalOf(ctx.store, people.find((u) => u.email === "max@example.invalid")!);
    const seen = new Date().toISOString();
    for (const [id, userId] of [["mch_ada", ada.id], ["mch_max", max.id]] as const) await ctx.store.insertMachine({ tenant: ctx.tenant, id, userId, name: id, platform: "darwin", publicKey: "", agents: [], createdAt: seen, lastSeenAt: seen, revokedAt: null, tokenHash: id.padEnd(64, "0").slice(0, 64) }, null);
    await ctx.store.upsertRepo({ tenant: ctx.tenant, id: "client-work", team: "Payments", name: "client-work", url: machineProjectUrl("mch_ada", "~/code/client-work") });
    await ctx.store.upsertRepo({ tenant: ctx.tenant, id: "notes", team: "Payments", name: "notes", url: machineProjectUrl("mch_max", "~/code/notes") });
    const read = async (user: Principal, path: string) => {
      const as: MiddlewareHandler<OrchestratorEnv> = async (c, next) => {
        c.set("user", user);
        await next();
      };
      const body = await (await createApp(ctx, as).request(path)).json();
      return ((body.projects ?? body.repos) as { id: string }[]).map((r) => r.id).sort();
    };

    // when
    const lists = [await read(max, "/api/projects"), await read(max, "/api/repos"), await read(ada, "/api/projects"), await read(ada, "/api/repos")];

    // then
    expect(lists).toEqual([["notes", "payments-skills"], ["notes", "payments-skills"], ["client-work", "notes", "payments-skills"], ["client-work", "notes", "payments-skills"]]);
  });
});
