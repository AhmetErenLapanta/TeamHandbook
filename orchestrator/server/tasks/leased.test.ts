import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createUser } from "../accounts.js";
import type { MiddlewareHandler } from "hono";
import { createApp } from "../app.js";
import type { OrchestratorContext } from "../app.js";
import type { OrchestratorEnv, Principal } from "../auth.js";
import { localRepoPath, readLocalDescription } from "../forge/local.js";
import { git, gitMaybe } from "../git.js";
import { newId } from "../ids.js";
import { fakeOpCli, seededContext } from "../test-fixtures.js";
import { setTaskSecret } from "../task-secrets.js";
import { createVault } from "../vault.js";
import type { CheckoutWork, TaskProgress } from "../../runner/link.js";
import type { ExecutorHooks } from "../../runner/task.js";
import { fakeAgentAdapter } from "./agents.js";
import { openPushedRequest, openTargetRequest } from "./leased.js";
import { recheckRequest } from "./pushed-check.js";
import { saveEvidence } from "./verify.js";
import { taskMergeRefusal } from "./guards.js";
import { mergeRequest } from "../propose.js";
import { createTaskRunner, PUSH_REF, wentOnFromKey } from "./runner.js";
import { UNKNOWN_COST } from "./types.js";
import type { TaskRecord } from "./types.js";

const ADA: Principal = { id: "ada", name: "Ada Example", email: "ada@example.invalid", role: "admin", ownedTeams: [] };
const OWNER: Principal = { id: "owner", name: "Owner", email: "owner@example.invalid", role: "owner", ownedTeams: [] };
const FAKE_AGENT = join(import.meta.dirname, "..", "..", "demo", "fake-agent.mjs");

const as = (user: Principal): MiddlewareHandler<OrchestratorEnv> => async (c, next) => {
  c.set("user", user);
  await next();
};

const dirs: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** The seeded Payments repository, its starter's account, and a task on it as a start leaves it for a runner. */
async function leasedTask(): Promise<{ ctx: OrchestratorContext; task: TaskRecord; bare: string }> {
  const { ctx, root } = await seededContext("orchestrator-leased-", ["payments-skills"]);
  dirs.push(root);
  await createUser(ctx.store, ctx.tenant, new Set(["Payments"]), { email: "ada@example.invalid", name: "Ada Example", role: "admin" }, OWNER);
  ctx.tasks = createTaskRunner(ctx, { agents: [fakeAgentAdapter(FAKE_AGENT)], isolation: { mode: "process", network: "open" }, testCommand: () => null, hostEnv: { PATH: process.env.PATH } });
  // The runner's start puts right what an earlier one left; the task below is made after it.
  await ctx.tasks.ready();
  const repo = (await ctx.store.getRepo(ctx.tenant, "payments-skills"))!;
  const task: TaskRecord = { tenant: ctx.tenant, id: newId("tsk"), repoId: repo.id, team: repo.team, title: "Add an on-call note", description: "", issueUrl: null, issueKey: null, agent: "fake", status: "queued", createdBy: "ada@example.invalid", createdAt: new Date().toISOString(), startedAt: null, finishedAt: null, baseSha: null, tests: null, cost: UNKNOWN_COST, requestNumber: null, error: null, template: null, mode: "auto", runner: "local" };
  await ctx.store.createTask(task);
  return { ctx, task, bare: localRepoPath(repo.url)! };
}

/** Hooks as a runner holds them, keeping what reaches them; `held` says whether the lease is still this runner's. */
function hooksFor(held = true) {
  const seen = { logs: [] as string[], progress: [] as TaskProgress[], processes: [] as number[] };
  const hooks: ExecutorHooks = {
    signal: new AbortController().signal,
    onEvent: () => {},
    log: (text) => void seen.logs.push(text),
    record: (progress) => void seen.progress.push(progress),
    onProcess: (pgid) => void seen.processes.push(pgid),
    decide: async () => ({ decision: "allow-once" }),
    leaseHeld: async () => held,
  };
  return { hooks, seen };
}

describe("a task leased to a runner on this machine", { timeout: 120_000 }, () => {
  it("given a task on a repository held by path, when the runner runs it, then its branch lands in that repository, every write reaches the hooks, and the request's title and description come back for the orchestrator", async () => {
    // given
    const { ctx, task, bare } = await leasedTask();
    const { hooks, seen } = hooksFor();

    // when
    const outcome = await ctx.tasks!.leased().run({ id: task.id, title: task.title, agent: "fake", nativeSession: null }, hooks);

    // then
    expect(outcome).toMatchObject({ status: "needs-review", error: null, position: null, request: { title: expect.any(String), body: expect.stringContaining("Added the skill") } });
    expect(gitMaybe(["rev-parse", "--verify", `refs/heads/${outcome.branch}`], bare)).not.toBeNull();
    expect(PUSH_REF).toBe("refs/orchestrator/change");
    expect(gitMaybe(["for-each-ref", "--format=%(refname)"], bare)!.trim().split("\n").filter((ref) => !/^refs\/(heads|notes|tags)\//.test(ref))).toEqual([]);
    expect(seen.logs).toContain(`Pushed ${outcome.branch} to payments-skills; the request opens from it.`);
    expect(seen.progress).toEqual(expect.arrayContaining([expect.objectContaining({ baseSha: expect.any(String) }), { tests: "skipped" }, { branch: outcome.branch }]));
    expect(seen.processes.length).toBeGreaterThan(0);
    expect((await ctx.store.getTask(ctx.tenant, task.id))!).toMatchObject({ status: "queued", requestNumber: null });
  });

  it("given a task a runner here took to review, when its starter asks for more and the runner takes it again, then the run starts from the request's branch with the words in its prompt, and its commit lands on that branch over the first one, checked on the same request", async () => {
    // given
    const { ctx, task, bare } = await leasedTask();
    const script = join(dirs[dirs.length - 1]!, "going-on.mjs");
    writeFileSync(script, `import { existsSync, readFileSync, writeFileSync } from "node:fs";\nconst prompt = readFileSync(0, "utf8");\nif (prompt.includes("Also name the escalation lead.")) writeFileSync("LEAD.md", existsSync("ON-CALL.md") ? "after the note\\n" : "from scratch\\n");\nelse writeFileSync("ON-CALL.md", "Page the on-call engineer.\\n");\nconsole.log(JSON.stringify({ type: "result", summary: "Done." }));\n`);
    ctx.tasks = createTaskRunner(ctx, { agents: [fakeAgentAdapter(script)], isolation: { mode: "process", network: "open" }, testCommand: () => null, hostEnv: { PATH: process.env.PATH } });
    await ctx.tasks.ready();
    const lease = { id: task.id, title: task.title, agent: "fake", nativeSession: null };
    const firstRun = hooksFor();
    const first = await ctx.tasks.leased().run(lease, firstRun.hooks);
    const baseSha = firstRun.seen.progress.find((p) => p.baseSha)!.baseSha!;
    await ctx.store.updateTask(ctx.tenant, task.id, { status: "needs-review", baseSha });
    await ctx.store.setTaskBranch(ctx.tenant, task.id, first.branch!);
    await openPushedRequest(ctx, task.id, first);
    const number = (await ctx.store.getTask(ctx.tenant, task.id))!.requestNumber!;
    const firstHead = git(["rev-parse", `refs/heads/${first.branch}`], bare).trim();

    // when
    const asked = await createApp(ctx, as(ADA)).request(`/api/tasks/${task.id}/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "Also name the escalation lead.", commandId: "go-on-local-1" }) });
    const secondRun = hooksFor();
    const second = await ctx.tasks.leased().run(lease, secondRun.hooks);
    await ctx.store.updateTask(ctx.tenant, task.id, { status: "needs-review" });
    await openPushedRequest(ctx, task.id, second);

    // then
    expect(asked.status).toBe(202);
    expect(second).toMatchObject({ status: "needs-review", branch: first.branch });
    const head = git(["rev-parse", `refs/heads/${first.branch}`], bare).trim();
    expect(git(["rev-parse", `${head}^`], bare).trim()).toBe(firstHead);
    expect(git(["show", `${head}:LEAD.md`], bare)).toBe("after the note\n");
    expect(secondRun.seen.logs).toContain(`Went on from request #${number}: ${first.branch} at ${firstHead.slice(0, 7)}.`);
    expect(secondRun.seen.progress.some((p) => p.baseSha)).toBe(false);
    expect((await ctx.store.listRequests(ctx.tenant, task.repoId)).filter((r) => r.branch === first.branch)).toHaveLength(1);
    expect(await ctx.store.getRequest(ctx.tenant, task.repoId, number)).toMatchObject({ status: "open", checkedHead: head });
    expect(await ctx.store.pendingFollowUps(ctx.tenant, task.id)).toEqual([]);
    const description = (await readLocalDescription((await ctx.store.getRepo(ctx.tenant, task.repoId))!, first.branch!))!;
    expect(description.split("\n## Verification\n").length).toBe(2);
  });

  it("given a runner that lost the lease by the time the change is ready, when it would push, then nothing reaches the repository and the task reads as interrupted", async () => {
    // given
    const { ctx, task, bare } = await leasedTask();
    const { hooks } = hooksFor(false);
    const before = gitMaybe(["for-each-ref", "--format=%(refname)", "refs/heads/"], bare);

    // when
    const outcome = await ctx.tasks!.leased().run({ id: task.id, title: task.title, agent: "fake", nativeSession: null }, hooks);

    // then
    expect(outcome).toMatchObject({ status: "interrupted", branch: null, request: null });
    expect(gitMaybe(["for-each-ref", "--format=%(refname)", "refs/heads/"], bare)).toBe(before);
  });

  it("given a branch a runner pushed, when the orchestrator hears the task is done, then the request is recorded on the local forge and on the task", async () => {
    // given
    const { ctx, task } = await leasedTask();
    const { hooks, seen } = hooksFor();
    const outcome = await ctx.tasks!.leased().run({ id: task.id, title: task.title, agent: "fake", nativeSession: null }, hooks);
    const baseSha = seen.progress.find((p) => p.baseSha)!.baseSha!;
    await ctx.store.updateTask(ctx.tenant, task.id, { baseSha, status: "needs-review" });
    await ctx.store.setTaskBranch(ctx.tenant, task.id, outcome.branch!);

    // when
    await openPushedRequest(ctx, task.id, outcome);

    // then
    const done = (await ctx.store.getTask(ctx.tenant, task.id))!;
    expect(done.requestNumber).toEqual(expect.any(Number));
    expect(await ctx.store.getRequest(ctx.tenant, "payments-skills", done.requestNumber!)).toMatchObject({ branch: outcome.branch, status: "open", provider: "local", createdBy: "ada@example.invalid" });
    expect((await ctx.store.taskLog(ctx.tenant, task.id, 0)).map((l) => l.text)).toContain(`Opened request #${done.requestNumber} on ${outcome.branch}. It waits for a person to review and merge it.`);
  });

  it("given a repository held by path whose clone has its origin on GitLab, when the request opens at the task's end, then the local request is the task's and nothing is said to or asked of the forge", async () => {
    // given
    const { ctx, task, bare } = await leasedTask();
    ctx.ownForgeCli = true;
    git(["remote", "add", "origin", "git@gitlab.com:acme/payments-skills.git"], bare);
    const { hooks, seen } = hooksFor();
    const outcome = await ctx.tasks!.leased().run({ id: task.id, title: task.title, agent: "fake", nativeSession: null }, hooks);
    await ctx.store.updateTask(ctx.tenant, task.id, { baseSha: seen.progress.find((p) => p.baseSha)!.baseSha!, status: "needs-review" });
    await ctx.store.setTaskBranch(ctx.tenant, task.id, outcome.branch!);
    const calls: string[][] = [];

    // when
    await openPushedRequest(ctx, task.id, outcome, async (_tool, args) => {
      calls.push(args);
      return { code: 1, stdout: "", stderr: "", missing: false };
    });

    // then
    expect((await ctx.store.getTask(ctx.tenant, task.id))!.requestNumber).toEqual(expect.any(Number));
    const log = (await ctx.store.taskLog(ctx.tenant, task.id, 0)).map((l) => l.text);
    expect(log.filter((l) => l.includes("repository's forge"))).toEqual([]);
    expect(calls).toEqual([]);
  });
});

describe("a branch a machine pushed, checked before its request opens", { timeout: 120_000 }, () => {
  const TOKEN = "ghp_0123456789abcdefghijklmnopqrstuvwxyzAB";

  /** A task waiting for review on `branch`, made in a clone of the repository by `commits`, each a set of files to write, and pushed there. */
  async function pushed(commits: Record<string, string>[], { branch = "handbook/add-on-call-note", named, body = "Added the on-call note.", message = "step", then }: { branch?: string; named?: string; body?: string; message?: string; then?: (clone: string) => void } = {}) {
    const { ctx, task, bare } = await leasedTask();
    const clone = join(dirs[dirs.length - 1]!, "clone");
    git(["clone", "--quiet", bare, clone], dirs[dirs.length - 1]!);
    const baseSha = git(["rev-parse", "HEAD"], clone).trim();
    git(["checkout", "--quiet", "-b", branch], clone);
    for (const [at, files] of commits.entries()) {
      for (const [path, content] of Object.entries(files)) writeFileSync(join(clone, path), content);
      git(["add", "-A"], clone);
      git(["-c", "user.name=Ada Example", "-c", "user.email=ada@example.invalid", "commit", "--quiet", "-m", `${message} ${at + 1}`], clone);
    }
    then?.(clone);
    git(["push", "--quiet", "origin", `${branch}:refs/heads/${branch}`], clone);
    await ctx.store.updateTask(ctx.tenant, task.id, { baseSha, status: "needs-review" });
    await ctx.store.setTaskBranch(ctx.tenant, task.id, named ?? branch);
    const outcome = { status: "needs-review" as const, error: null, nativeSessionId: null, branch, position: null, request: { title: "Add an on-call note", body } };
    const said = async () => ({ task: (await ctx.store.getTask(ctx.tenant, task.id))!, log: (await ctx.store.taskLog(ctx.tenant, task.id, 0)).map((l) => l.text) });
    return { ctx, task, outcome, said, clone };
  }

  it("given a branch that meets the team's rules, when the task is done, then its request opens", async () => {
    // given
    const { ctx, task, outcome, said } = await pushed([{ "ON-CALL.md": "Page the on-call engineer.\n" }]);

    // when
    await openPushedRequest(ctx, task.id, outcome);

    // then
    expect((await said()).task).toMatchObject({ status: "needs-review", requestNumber: expect.any(Number) });
  });

  it.each([
    ["a secret added in one commit and taken out in the next", [{ "ON-CALL.md": `token ${TOKEN}\n` }, { "ON-CALL.md": "Page the on-call engineer.\n" }], {}, /^commit [0-9a-f]{7}: The agent's change to ON-CALL\.md looks like it holds a secret/],
    ["a branch other than the one the task was given", [{ "ON-CALL.md": "Page the on-call engineer.\n" }], { named: "handbook/something-else" }, /^the machine pushed handbook\/add-on-call-note, and this task was given handbook\/something-else/],
    ["a description that holds a token", [{ "ON-CALL.md": "Page the on-call engineer.\n" }], { body: `Use ${TOKEN} to page.` }, /^its description looks like it holds a secret/],
    ["a commit message that holds a token", [{ "ON-CALL.md": "Page the on-call engineer.\n" }], { message: `Use ${TOKEN}` }, /^commit [0-9a-f]{7}: its message looks like it holds a secret/],
  ])("given %s, when the task is done, then the task fails, nothing opens and the log says to delete the branch", async (_case, commits, options, why) => {
    // given
    const { ctx, task, outcome, said } = await pushed(commits, options);

    // when
    await openPushedRequest(ctx, task.id, outcome);

    // then
    const { task: done, log } = await said();
    expect(done).toMatchObject({ status: "failed", requestNumber: null });
    expect(done.error!.replace(/^The request was not opened: /, "")).toMatch(why);
    expect(log.at(-1)).toMatch(/The branch is already where the machine pushed it; delete it there\.$/);
    expect(await ctx.store.listRequests(ctx.tenant, task.repoId)).toEqual(expect.not.arrayContaining([expect.objectContaining({ branch: outcome.branch })]));
    expect(JSON.stringify(log)).not.toContain(TOKEN);
  });

  it("given a team secret named by an item op does not hold, when the task is done, then its request does not open, since the check cannot mask a value it could not read", async () => {
    // given
    const op = mkdtempSync(join(tmpdir(), "orchestrator-leased-op-"));
    dirs.push(op);
    fakeOpCli(op, {});
    const { ctx, task, outcome, said } = await pushed([{ "ON-CALL.md": "Page the on-call engineer.\n" }]);
    ctx.vault = createVault(randomBytes(32));
    await setTaskSecret(ctx, ADA, { scope: "team", target: "Payments", name: "NPM_TOKEN", secret: { provider: "op", reference: "op://Payments/npm/credential" } });

    // when
    await openPushedRequest(ctx, task.id, outcome);

    // then
    expect((await said()).task).toMatchObject({ status: "failed", requestNumber: null, error: "The request was not opened: the task secret NPM_TOKEN is read from op://Payments/npm/credential, and that read returned no value a task secret can be." });
  });

  /** The target moves on with someone else's commit, and the branch merges it in, squeezing `extra` into the merge when given. */
  const upToDate = (extra?: Record<string, string>) => (clone: string) => {
    const who = ["-c", "user.name=Grace Example", "-c", "user.email=grace@example.invalid"];
    const branch = git(["rev-parse", "--abbrev-ref", "HEAD"], clone).trim();
    git(["checkout", "--quiet", "main"], clone);
    writeFileSync(join(clone, "TEAM.md"), "The team's own note.\n");
    git(["add", "-A"], clone);
    git([...who, "commit", "--quiet", "-m", "A teammate's change"], clone);
    git(["push", "--quiet", "origin", "main"], clone);
    git(["checkout", "--quiet", branch], clone);
    git([...who, "merge", "--quiet", "--no-ff", "--no-commit", "main"], clone);
    for (const [path, content] of Object.entries(extra ?? {})) writeFileSync(join(clone, path), content);
    git(["add", "-A"], clone);
    git([...who, "commit", "--quiet", "-m", "Merge main"], clone);
  };

  it("given a branch brought up to date by merging in its target, which a teammate moved on, when the task is done, then it is judged on the task's own work and its request opens", async () => {
    // given
    const { ctx, task, outcome, said } = await pushed([{ "ON-CALL.md": "Page the on-call engineer.\n" }], { then: upToDate() });

    // when
    await openPushedRequest(ctx, task.id, outcome);

    // then
    expect((await said()).task).toMatchObject({ status: "needs-review", requestNumber: expect.any(Number) });
  });

  it("given a merge of the target that squeezes a secret in, when the task is done, then the merge's own addition is what fails it", async () => {
    // given
    const { ctx, task, outcome, said } = await pushed([{ "ON-CALL.md": "Page the on-call engineer.\n" }], { then: upToDate({ "NOTES.md": `token ${TOKEN}\n` }) });

    // when
    await openPushedRequest(ctx, task.id, outcome);

    // then
    expect((await said()).task).toMatchObject({ status: "failed", requestNumber: null, error: expect.stringMatching(/commit [0-9a-f]{7}: The agent's change to NOTES\.md looks like it holds a secret/) });
  });

  it("given an open request, when a later push carries a secret, then the request is held with the reason, and a push that takes the secret back out of the history releases it", async () => {
    // given
    const { ctx, task, outcome, said, clone } = await pushed([{ "ON-CALL.md": "Page the on-call engineer.\n" }]);
    await openPushedRequest(ctx, task.id, outcome);
    const repo = (await ctx.store.getRepo(ctx.tenant, task.repoId))!;
    const opened = (await ctx.store.getRequest(ctx.tenant, repo.id, (await said()).task.requestNumber!))!;
    const clean = git(["rev-parse", "HEAD"], clone).trim();
    const who = ["-c", "user.name=Ada Example", "-c", "user.email=ada@example.invalid"];
    writeFileSync(join(clone, "KEYS.md"), `token ${TOKEN}\n`);
    git(["add", "-A"], clone);
    git([...who, "commit", "--quiet", "-m", "Add the key"], clone);
    git(["push", "--quiet", "origin", `HEAD:refs/heads/${outcome.branch}`], clone);
    const leaked = git(["rev-parse", "HEAD"], clone).trim();

    // when
    const first = await recheckRequest(ctx, repo, opened, leaked);
    const heldNow = (await ctx.store.getRequest(ctx.tenant, repo.id, opened.number))!;
    const card = async () => (await (await createApp(ctx, as(ADA)).request(`/api/tasks/${task.id}`)).json()).task.request;
    const heldCard = await card();
    git(["checkout", "--quiet", "-B", outcome.branch, clean], clone);
    writeFileSync(join(clone, "ON-CALL.md"), "Page the on-call engineer, then the lead.\n");
    git(["add", "-A"], clone);
    git([...who, "commit", "--quiet", "-m", "Say who comes next"], clone);
    git(["push", "--quiet", "--force", "origin", `HEAD:refs/heads/${outcome.branch}`], clone);
    const fixed = git(["rev-parse", "HEAD"], clone).trim();
    const second = await recheckRequest(ctx, repo, heldNow, fixed);

    // then
    expect(opened.checkedHead).toEqual(expect.stringMatching(/^[0-9a-f]{40}$/));
    expect(first).toBe("held");
    expect(heldNow).toMatchObject({ heldHead: leaked, heldReason: expect.stringContaining("looks like it holds a secret") });
    expect(heldCard).toMatchObject({ status: "open", heldReason: heldNow.heldReason });
    expect(second).toBe("passed");
    expect(await card()).not.toHaveProperty("heldReason");
    expect(await ctx.store.getRequest(ctx.tenant, repo.id, opened.number)).toMatchObject({ checkedHead: fixed });
    expect((await ctx.store.getRequest(ctx.tenant, repo.id, opened.number))!.heldHead ?? null).toBeNull();
    const log = (await said()).log;
    expect(log.find((l) => l.startsWith(`Request #${opened.number} changed after it was checked: ${leaked.slice(0, 7)} is held`))).toBeDefined();
    expect(log.at(-1)).toBe(`Request #${opened.number} was pushed to after it opened; ${fixed.slice(0, 7)} meets the team's rules, so it no longer waits.`);
    expect(JSON.stringify(log)).not.toContain(TOKEN);
  });

  it("given a task's request opened before heads were checked, with a secret on its branch, when a person merges it, then it is checked first and the merge is refused", async () => {
    // given
    const { ctx, task, outcome, said } = await pushed([{ "ON-CALL.md": `token ${TOKEN}\n` }]);
    const repo = (await ctx.store.getRepo(ctx.tenant, task.repoId))!;
    const head = git(["rev-parse", `refs/heads/${outcome.branch}`], localRepoPath(repo.url)!).trim();
    await ctx.store.saveRequest({ tenant: ctx.tenant, repoId: repo.id, number: 7, provider: "local", url: "local://requests/payments-skills/7", branch: outcome.branch, headSha: head, title: "Add an on-call note", status: "open", createdAt: new Date().toISOString(), createdBy: "ada@example.invalid" });
    await ctx.store.updateTask(ctx.tenant, task.id, { requestNumber: 7 });

    // when
    const refusal = await taskMergeRefusal(ctx, repo, 7, ADA);
    const merged = mergeRequest(ctx, repo, 7, ADA);

    // then
    expect(refusal).toBeNull();
    await expect(merged).rejects.toThrow(/looks like it holds a secret/);
    expect((await ctx.store.getRequest(ctx.tenant, repo.id, 7))).toMatchObject({ status: "open", heldHead: head });
    expect((await said()).log.some((l) => l.startsWith("Request #7 changed after it was checked"))).toBe(true);
  });

  it("given an open request whose target the forge changed to another branch, when it is checked at the head it passed, then it is held; on its own branch it stays as it was", async () => {
    // given
    const { ctx, task, outcome, said } = await pushed([{ "ON-CALL.md": "Page the on-call engineer.\n" }]);
    await openPushedRequest(ctx, task.id, outcome);
    const repo = (await ctx.store.getRepo(ctx.tenant, task.repoId))!;
    const opened = (await ctx.store.getRequest(ctx.tenant, repo.id, (await said()).task.requestNumber!))!;

    // when
    const same = await recheckRequest(ctx, repo, opened, opened.checkedHead!, "main");
    const moved = await recheckRequest(ctx, repo, opened, opened.checkedHead!, "release");

    // then
    expect([same, moved]).toEqual(["unchanged", "held"]);
    expect((await ctx.store.getRequest(ctx.tenant, repo.id, opened.number))!.heldReason).toBe("its target was changed on the forge to release, and it was opened on main");
  });

  it("given a head the forge reports that the orchestrator's copy does not have, when it is checked, then the request is held", async () => {
    // given
    const { ctx, task, outcome, said } = await pushed([{ "ON-CALL.md": "Page the on-call engineer.\n" }]);
    await openPushedRequest(ctx, task.id, outcome);
    const repo = (await ctx.store.getRepo(ctx.tenant, task.repoId))!;
    const opened = (await ctx.store.getRequest(ctx.tenant, repo.id, (await said()).task.requestNumber!))!;

    // when
    const verdict = await recheckRequest(ctx, repo, opened, "1".repeat(40));

    // then
    expect(verdict).toBe("held");
    expect((await ctx.store.getRequest(ctx.tenant, repo.id, opened.number))!.heldReason).toMatch(/the orchestrator's copy reads [0-9a-f]{7}/);
  });

  it("given the orchestrator stopped while it read the repository again, when the task is done, then the task keeps its review, the repository is not marked broken, and the log says why nothing opened", async () => {
    // given
    const { ctx, task, outcome, said } = await pushed([{ "ON-CALL.md": "Page the on-call engineer.\n" }]);
    vi.stubEnv("GIT_CONFIG_COUNT", "1");
    vi.stubEnv("GIT_CONFIG_KEY_0", "remote.origin.uploadpack");
    vi.stubEnv("GIT_CONFIG_VALUE_0", "kill -TERM $(ps -o ppid= -p $PPID); exit 1; :");

    // when
    await openPushedRequest(ctx, task.id, outcome);

    // then
    const { task: done, log } = await said();
    expect(done).toMatchObject({ status: "needs-review", requestNumber: null, error: null });
    expect(log.at(-1)).toBe(`The request for ${outcome.branch} was not opened: the orchestrator stopped before it could; the branch is where the machine pushed it.`);
    expect((await ctx.store.getRepo(ctx.tenant, task.repoId))!.error).toBeNull();
  });

  it("given a pushed branch whose request a stop cut off before it opened, when the orchestrator starts again, then the request opens from it once with the task's title, and a second start opens nothing more", async () => {
    // given
    const { ctx, task, said } = await pushed([{ "ON-CALL.md": "Page the on-call engineer.\n" }]);
    const restart = async () => {
      const again = createTaskRunner(ctx, { agents: [fakeAgentAdapter(FAKE_AGENT)], isolation: { mode: "process", network: "open" }, testCommand: () => null, hostEnv: { PATH: process.env.PATH } });
      await again.ready();
      for (let i = 0; i < 600 && (await ctx.store.getTask(ctx.tenant, task.id))!.requestNumber === null; i++) await new Promise((r) => setTimeout(r, 100));
    };

    // when
    await restart();
    const first = (await said()).task;
    await restart();

    // then
    expect(first).toMatchObject({ status: "needs-review", requestNumber: expect.any(Number) });
    const opened = await ctx.store.getRequest(ctx.tenant, task.repoId, first.requestNumber!);
    expect(opened).toMatchObject({ title: "Add an on-call note", branch: "handbook/add-on-call-note" });
    expect((await ctx.store.listRequests(ctx.tenant, task.repoId)).filter((r) => r.branch === "handbook/add-on-call-note")).toHaveLength(1);
    expect((await said()).log).toContain("The orchestrator stopped before this task's request opened; it is opened now from handbook/add-on-call-note.");
  });

  it("given checks a machine ran and the orchestrator kept as evidence, when the request opens, then its description carries them and says they ran on the person's machine, not on the orchestrator", async () => {
    // given
    const { ctx, task, outcome, said } = await pushed([{ "ON-CALL.md": "Page the on-call engineer.\n" }]);
    const run = { code: 0, timedOut: false, ms: 900, output: "ok", cut: 0 };
    await saveEvidence(ctx.store, ctx.tenant, task.id, task.repoId, { checks: [{ command: "npm test", runs: "npm test", source: "package.json", before: run, after: [run], verdict: "passed" }], setup: null, repairs: 0, verdict: "passed", reason: "`npm test` passes before the agent's change and after it." }, (t) => t);

    // when
    await openPushedRequest(ctx, task.id, outcome);

    // then
    const repo = (await ctx.store.getRepo(ctx.tenant, task.repoId))!;
    const opened = (await ctx.store.getRequest(ctx.tenant, repo.id, (await said()).task.requestNumber!))!;
    const body = (await readLocalDescription(repo, opened.branch))!;
    expect(body).toContain("## Verification");
    expect(body).toContain("These checks ran on Ada Example's machine, not on the orchestrator");
  });

  it("given a branch that does not start from the task's base, when the task is done, then nothing opens", async () => {
    // given
    const { ctx, task, outcome, said } = await pushed([{ "ON-CALL.md": "Page the on-call engineer.\n" }]);
    await ctx.store.updateTask(ctx.tenant, task.id, { baseSha: "0".repeat(40) });

    // when
    await openPushedRequest(ctx, task.id, outcome);

    // then
    expect((await said()).task).toMatchObject({ status: "failed", requestNumber: null, error: expect.stringContaining("does not start from the task's base commit") });
  });

  describe("a folder of several repositories, each changed one pushed by the machine", () => {
    /** The run's outcome as a machine reports it for a folder of several: the one repository it changed, on the seeded remote. */
    const reported = (outcome: { branch: string; request: { title: string; body: string } | null }, head: string, origin: string) => ({
      status: "needs-review" as const, error: null, nativeSessionId: null, branch: null, position: null, request: null,
      repos: [{ path: "payments", branch: outcome.branch, head, baseSha: "1".repeat(40), origin, target: "main", request: outcome.request }],
    });

    it("given a branch the machine pushed to a remote this organization connected, when the task ends, then the request opens on that repository from its own copy, its base read from the default branch and not the machine's word", async () => {
      // given
      const { ctx, task, outcome, said, clone } = await pushed([{ "ON-CALL.md": "Page the on-call engineer.\n" }]);
      const bare = localRepoPath((await ctx.store.getRepo(ctx.tenant, task.repoId))!.url)!;
      const head = git(["rev-parse", "HEAD"], clone).trim();

      // when
      await openPushedRequest(ctx, task.id, reported(outcome, head, bare));

      // then
      const { task: done, log } = await said();
      expect(done.targets).toEqual([expect.objectContaining({ repoId: task.repoId, status: "request", baseSha: done.baseSha, requestNumber: expect.any(Number) })]);
      expect(done.targets![0]!.baseSha).not.toBe("1".repeat(40));
      expect(await ctx.store.getRequest(ctx.tenant, task.repoId, done.targets![0]!.requestNumber!)).toMatchObject({ status: "open", checkedHead: head });
      expect(log.some((l) => l.startsWith("payments: opened request #"))).toBe(true);
    });

    it("given a repository with a remote the machine did not push its branch to, when the task ends, then no request opens there, the task waits for review with the change kept on the machine, and the log says the branch stays in it", async () => {
      // given
      const { ctx, task, outcome, said, clone } = await pushed([{ "ON-CALL.md": "Page the on-call engineer.\n" }]);
      const bare = localRepoPath((await ctx.store.getRepo(ctx.tenant, task.repoId))!.url)!;

      // when
      await openPushedRequest(ctx, task.id, reported({ ...outcome, request: null }, git(["rev-parse", "HEAD"], clone).trim(), bare));

      // then
      const { task: done, log } = await said();
      expect(log).toContain(`payments: the branch ${outcome.branch} stays in that repository, unpushed, so no request opens for it.`);
      expect(await ctx.store.listRequests(ctx.tenant)).toEqual([]);
      expect(done).toMatchObject({ status: "needs-review", targets: [{ repoId: task.repoId, status: "local", reason: "unpushed", path: "payments", branch: outcome.branch, baseSha: "1".repeat(40), requestNumber: null, error: null }] });
      const shown = (await (await createApp(ctx, as(ADA)).request(`/api/tasks/${task.id}`)).json()).task;
      expect(shown.targets).toEqual([expect.objectContaining({ status: "local", reason: "unpushed", path: "payments", branch: outcome.branch, request: null })]);
      expect(shown.ranOn).toBeNull();
    });

    it("given a branch the machine kept unpushed with its request's words, when its person pushes it later and the one change is opened, then the kept change holds its head, remote and masked words, and only that target becomes the request, checked as at a task's end", async () => {
      // given
      const { ctx, task, outcome, said, clone } = await pushed([{ "ON-CALL.md": "Page the on-call engineer.\n" }]);
      const bare = localRepoPath((await ctx.store.getRepo(ctx.tenant, task.repoId))!.url)!;
      const head = git(["rev-parse", "HEAD"], clone).trim();
      const keptWith = (body: string) => {
        const kept = reported({ ...outcome, request: { title: "Add an on-call note", body } }, head, bare);
        return { ...kept, repos: kept.repos.map((r) => ({ ...r, pushed: false })) };
      };
      const kept = keptWith("Added the note.");
      await openPushedRequest(ctx, task.id, kept);
      const stored = (await said()).task.targets![0]!;

      // when
      const opened = await openTargetRequest(ctx, task.id, 0);
      const none = await openTargetRequest(ctx, task.id, 3);
      const { task: done } = await said();
      await openPushedRequest(ctx, task.id, keptWith(`Added the note; registry token ${TOKEN} unused.`));
      const withSecret = (await said()).task.targets![0]!;

      // then
      expect(stored).toMatchObject({ status: "local", reason: "unpushed", path: "payments", head, origin: bare, targetBranch: "main" });
      expect(stored.description).toEqual({ title: "Add an on-call note", body: "Added the note." });
      expect(opened).toMatchObject({ repoId: task.repoId, status: "request", requestNumber: expect.any(Number), error: null });
      expect(done.targets).toEqual([expect.objectContaining({ repoId: task.repoId, status: "request", requestNumber: (opened as { requestNumber: number }).requestNumber })]);
      expect(await ctx.store.getRequest(ctx.tenant, task.repoId, (opened as { requestNumber: number }).requestNumber)).toMatchObject({ status: "open", checkedHead: head });
      expect(none).toEqual({ refused: "the task has no such change" });
      // Words that look like they hold a secret are not kept; the later request asks for its own.
      expect(withSecret).toMatchObject({ status: "local", reason: "unpushed" });
      expect(withSecret.description).toBeUndefined();
      expect(JSON.stringify(withSecret)).not.toContain(TOKEN);
    });

    it.each([
      ["a remote no repository of this organization is", "unknown", /^payments: its remote is no repository this organization connected/],
      ["a head the remote does not have", "head", /^payments: the request was not opened: .* the machine reported 0000000/],
      ["a secret in a commit between the base and the head", "secret", /^payments: the request was not opened: commit [0-9a-f]{7}: The agent's change to KEYS\.md looks like it holds a secret/],
    ])("given %s, when the task ends, then that repository's request does not open and the log says why", async (_case, kind, why) => {
      // given
      const { ctx, task, outcome, said, clone } = await pushed(kind === "secret" ? [{ "KEYS.md": `token ${TOKEN}\n` }, { "KEYS.md": "none\n" }] : [{ "ON-CALL.md": "Page the on-call engineer.\n" }]);
      const bare = localRepoPath((await ctx.store.getRepo(ctx.tenant, task.repoId))!.url)!;
      const head = kind === "head" ? "0".repeat(40) : git(["rev-parse", "HEAD"], clone).trim();

      // when
      await openPushedRequest(ctx, task.id, reported(outcome, head, kind === "unknown" ? "https://elsewhere.example.invalid/acme/payments.git" : bare));

      // then
      const { task: done, log } = await said();
      expect(log.find((l) => l.startsWith("payments: "))).toMatch(why);
      // A remote this organization did not connect keeps the change on the person's machine, to review there.
      expect(done).toMatchObject({ status: kind === "unknown" ? "needs-review" : "failed" });
      if (kind === "unknown") expect(done.targets).toEqual([expect.objectContaining({ repoId: task.repoId, status: "local", reason: "not-connected", path: "payments", branch: outcome.branch, requestNumber: null })]);
      expect((await ctx.store.listRequests(ctx.tenant, task.repoId)).filter((r) => r.branch === outcome.branch)).toEqual([]);
      expect(JSON.stringify(log)).not.toContain(TOKEN);
    });
  });

  describe("a file taken out of the task's open request", () => {
    const MAX: Principal = { id: "max", name: "Max Example", email: "max@example.invalid", role: "member", ownedTeams: [] };
    const drop = (ctx: OrchestratorContext, user: Principal, taskId: string, path: string) =>
      createApp(ctx, as(user)).request(`/api/tasks/${taskId}/request/drop`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path }) });

    it("given a task's open request with two files, when its starter takes one out, then the branch gets one commit putting it back as the task's base held it, the new head is the request's checked one, and the log and event log say who", async () => {
      // given
      const { ctx, task, outcome, said, clone } = await pushed([{ "ON-CALL.md": "Page the on-call engineer.\n", "NOTES.md": "A stray note.\n" }]);
      await openPushedRequest(ctx, task.id, outcome);
      const number = (await said()).task.requestNumber!;
      const bare = localRepoPath((await ctx.store.getRepo(ctx.tenant, task.repoId))!.url)!;
      const before = git(["rev-parse", "HEAD"], clone).trim();

      // when
      const answer = await drop(ctx, ADA, task.id, "NOTES.md");

      // then
      expect(answer.status).toBe(200);
      const { head } = await answer.json();
      expect(git(["rev-parse", `refs/heads/${outcome.branch}`], bare).trim()).toBe(head);
      expect(git(["rev-parse", `${head}^`], bare).trim()).toBe(before);
      expect(git(["ls-tree", "-r", "--name-only", head], bare).split("\n")).toEqual(expect.not.arrayContaining(["NOTES.md"]));
      expect(git(["ls-tree", "-r", "--name-only", head], bare)).toContain("ON-CALL.md");
      expect(await ctx.store.getRequest(ctx.tenant, task.repoId, number)).toMatchObject({ status: "open", checkedHead: head });
      expect((await said()).log).toContain(`Ada Example took NOTES.md out of request #${number}: the file is back as the task's base held it, at ${head.slice(0, 7)}.`);
    });

    it("given a member the task was shared with, and a request that was closed, when each asks to take a file out, then the reader is told no such task exists and the closed request is refused, and the branch does not move", async () => {
      // given
      const { ctx, task, outcome, said } = await pushed([{ "ON-CALL.md": "Page the on-call engineer.\n", "NOTES.md": "A stray note.\n" }]);
      await openPushedRequest(ctx, task.id, outcome);
      await createUser(ctx.store, ctx.tenant, new Set(["Payments"]), { email: MAX.email, name: MAX.name, role: "member" }, OWNER);
      const max = (await ctx.store.listUsers(ctx.tenant)).find((u) => u.email === MAX.email)!;
      await ctx.store.addTaskShare({ tenant: ctx.tenant, taskId: task.id, userId: max.id, sharedBy: ADA.email, at: new Date().toISOString() });
      const bare = localRepoPath((await ctx.store.getRepo(ctx.tenant, task.repoId))!.url)!;
      const head = git(["rev-parse", `refs/heads/${outcome.branch}`], bare).trim();

      // when
      const byReader = await drop(ctx, { ...MAX, id: max.id }, task.id, "NOTES.md");
      await ctx.store.setRequestStatus(ctx.tenant, task.repoId, (await said()).task.requestNumber!, "closed");
      const onClosed = await drop(ctx, ADA, task.id, "NOTES.md");

      // then
      expect(byReader.status).toBe(404);
      expect([onClosed.status, (await onClosed.json()).code]).toEqual([409, "request-not-open"]);
      expect(git(["rev-parse", `refs/heads/${outcome.branch}`], bare).trim()).toBe(head);
    });
  });

  describe("the starter going on from the task's open request", () => {
    it("given a task's open request a follow-up round pushed to before its new head was checked, when its owner merges it once, then the new head is checked and merged in that one press", async () => {
      // given
      const { ctx, task, outcome, said, clone } = await pushed([{ "ON-CALL.md": "Page the on-call engineer.\n" }]);
      await openPushedRequest(ctx, task.id, outcome);
      const number = (await said()).task.requestNumber!;
      const repo = (await ctx.store.getRepo(ctx.tenant, task.repoId))!;
      writeFileSync(join(clone, "ON-CALL.md"), "Page the on-call engineer, then the escalation lead.\n");
      git(["add", "-A"], clone);
      git(["-c", "user.name=Ada Example", "-c", "user.email=ada@example.invalid", "commit", "--quiet", "-m", "Name the lead"], clone);
      git(["push", "--quiet", "origin", `HEAD:refs/heads/${outcome.branch}`], clone);
      const next = git(["rev-parse", "HEAD"], clone).trim();

      // when
      const refused = await taskMergeRefusal(ctx, repo, number, OWNER);
      const merged = await mergeRequest(ctx, repo, number, OWNER);

      // then
      expect(refused).toBeNull();
      expect(merged.status).toBe("merged");
      expect((await ctx.store.getRequest(ctx.tenant, repo.id, number))!.checkedHead).toBe(next);
    });

    const say = (ctx: OrchestratorContext, taskId: string, commandId: string) =>
      createApp(ctx, as(ADA)).request(`/api/tasks/${taskId}/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "Also name the escalation lead.", commandId }) });

    it("given a task in review with its request open, when the starter asks for more twice with one commandId, then the task waits once more, each hand-out of its run starts from the request's head with the words once, and the push it makes is checked on that request with no second one opened", async () => {
      // given
      const { ctx, task, outcome, said, clone } = await pushed([{ "ON-CALL.md": "Page the on-call engineer.\n" }]);
      ctx.memberUrls = new Map([["payments-skills", "https://git.example.invalid/acme/payments-skills.git"]]);
      await openPushedRequest(ctx, task.id, outcome);
      const number = (await said()).task.requestNumber!;
      const repo = (await ctx.store.getRepo(ctx.tenant, task.repoId))!;
      const head = git(["rev-parse", "HEAD"], clone).trim();

      // when
      const first = await say(ctx, task.id, "go-on-0001");
      const again = await say(ctx, task.id, "go-on-0001");
      const waiting = (await said()).task;
      const mergeRefused = await taskMergeRefusal(ctx, repo, number, OWNER);
      const work = (await ctx.tasks!.describeWork(task.id)) as CheckoutWork;
      const wentOnFrom = await ctx.store.getSetting(ctx.tenant, wentOnFromKey(task.id));
      const rerun = (await ctx.tasks!.describeWork(task.id)) as CheckoutWork;
      writeFileSync(join(clone, "ON-CALL.md"), "Page the on-call engineer, then the escalation lead.\n");
      git(["add", "-A"], clone);
      git(["-c", "user.name=Ada Example", "-c", "user.email=ada@example.invalid", "commit", "--quiet", "-m", "Name the lead"], clone);
      git(["push", "--quiet", "origin", `HEAD:refs/heads/${outcome.branch}`], clone);
      const next = git(["rev-parse", "HEAD"], clone).trim();
      await ctx.store.updateTask(ctx.tenant, task.id, { status: "needs-review" });
      await openPushedRequest(ctx, task.id, { ...outcome, request: null });

      // then
      expect([first.status, again.status]).toEqual([202, 200]);
      expect(waiting).toMatchObject({ status: "queued", requestNumber: number });
      expect(mergeRefused).toMatch(/^its task is going on from it/);
      expect(work).toMatchObject({ branch: outcome.branch, continues: { branch: outcome.branch, head }, repo: { baseSha: waiting.baseSha } });
      expect(wentOnFrom).toBe(head);
      expect([work, rerun].map((w) => w.prompt.split("Also name the escalation lead.").length - 1)).toEqual([1, 1]);
      expect(await ctx.store.pendingFollowUps(ctx.tenant, task.id)).toEqual([]);
      expect((await ctx.store.listRequests(ctx.tenant, repo.id)).filter((r) => r.branch === outcome.branch)).toHaveLength(1);
      expect(await ctx.store.getRequest(ctx.tenant, repo.id, number)).toMatchObject({ status: "open", checkedHead: next });
      expect((await said()).task).toMatchObject({ status: "needs-review", requestNumber: number });
    });

    it("given a task whose request was merged, when the starter asks for more, then it is refused and the task stays as it was", async () => {
      // given
      const { ctx, task, outcome, said } = await pushed([{ "ON-CALL.md": "Page the on-call engineer.\n" }]);
      await openPushedRequest(ctx, task.id, outcome);
      await ctx.store.setRequestStatus(ctx.tenant, task.repoId, (await said()).task.requestNumber!, "merged", new Date().toISOString());

      // when
      const answer = await say(ctx, task.id, "go-on-0002");

      // then
      expect(answer.status).toBe(409);
      expect(await answer.json()).toMatchObject({ code: "follow-up-not-offered" });
      expect((await said()).task).toMatchObject({ status: "needs-review" });
    });
  });
});
