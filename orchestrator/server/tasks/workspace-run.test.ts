import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MiddlewareHandler } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createUser } from "../accounts.js";
import { createApp } from "../app.js";
import type { OrchestratorContext } from "../app.js";
import type { OrchestratorEnv, Principal } from "../auth.js";
import { git } from "../git.js";
import { localDescriptionRef } from "../forge/local.js";
import { openProject } from "../project-routes.js";
import { openSqliteStore } from "../store.js";
import { fakeAgentAdapter } from "./agents.js";
import { taskPaths } from "./isolation.js";
import { createTaskRunner } from "./runner.js";
import type { ExecutorHooks } from "../../runner/task.js";

const OWNER: Principal = { id: "owner", name: "Owner", email: "owner@example.invalid", role: "owner", ownedTeams: [] };

const dirs: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const as = (user: Principal): MiddlewareHandler<OrchestratorEnv> => async (c, next) => {
  c.set("user", user);
  await next();
};

/** A working copy as its person sees it: where HEAD is, what status says, the index's bytes, its branches and its README. */
const copyState = (repo: string) => ({
  head: git(["rev-parse", "HEAD"], repo).trim(),
  index: createHash("sha256").update(readFileSync(join(repo, ".git", "index"))).digest("hex"),
  status: git(["--no-optional-locks", "status", "--porcelain"], repo),
  branches: git(["for-each-ref", "--format=%(refname)", "refs/heads"], repo).split("\n").filter(Boolean),
  readme: readFileSync(join(repo, "README.md"), "utf8"),
});

/**
 * One person's orchestrator, its home holding the folder code (no git repository itself) with the
 * working copies alpha and beta under it, one commit each, opened as a project, and an agent that
 * runs `body` in its working directory before it reports.
 */
async function folderOfRepositories(body: string, names = ["alpha", "beta"]) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "orchestrator-workspace-")));
  dirs.push(root);
  const home = join(root, "home");
  const folder = join(home, "code");
  mkdirSync(folder, { recursive: true });
  for (const name of names) {
    const repo = join(folder, name);
    mkdirSync(repo);
    git(["init", "--quiet", "-b", "main"], repo);
    writeFileSync(join(repo, "README.md"), `${name}\n`);
    git(["add", "README.md"], repo);
    git(["commit", "--quiet", "-m", "First commit"], repo);
  }
  vi.stubEnv("HOME", home);
  vi.stubEnv("ORCHESTRATOR_MODE", "local");
  const ctx: OrchestratorContext = { store: openSqliteStore(":memory:"), dataDir: join(root, "data"), tenant: "default", addedRepos: new Map(), localReposRoot: home };
  const account = await createUser(ctx.store, ctx.tenant, new Set(["Mine"]), { email: "ada@example.invalid", name: "Ada Example", role: "owner" }, OWNER);
  const ada: Principal = { id: account.id, name: account.name, email: account.email, role: "owner", ownedTeams: [], restrictedTeams: [] };
  const { project } = await openProject(ctx, ada, folder);
  const script = join(root, "agent.mjs");
  writeFileSync(script, `import { writeFileSync } from "node:fs";\n${body}\nconsole.log(JSON.stringify({ type: "result", summary: "Done." }));\n`);
  ctx.tasks = createTaskRunner(ctx, { agents: [fakeAgentAdapter(script)], isolation: { mode: "process", network: "open" }, testCommand: () => null, hostEnv: { PATH: process.env.PATH, HOME: home }, profile: "personal" });
  await ctx.tasks.ready();
  const app = createApp(ctx, as(ada));
  const start = async () => (await app.request("/api/tasks", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ repoId: project.id, title: "Add a line", agent: "fake", mode: "auto" }) })).json();
  return { ctx, app, folder, project, start };
}

describe("a task in a folder that holds git working copies", { timeout: 120_000 }, () => {
  it("given a folder task whose request on one repository is open, when its person asks for more and this orchestrator's own runner takes it, then that repository starts at its request's head, the new commit moves the same branch forward, the same request is checked at it, and the words are handed once", async () => {
    // given
    const { ctx, folder, start } = await folderOfRepositories('const fs = await import("node:fs"); const now = fs.readFileSync("alpha/README.md", "utf8"); writeFileSync("alpha/README.md", now.includes("A second line.") ? now + "A third line.\\n" : "alpha\\nA second line.\\n");');
    const alpha = join(folder, "alpha");
    const started = await start();
    await ctx.tasks!.idle();
    const first = (await ctx.store.getTask(ctx.tenant, started.task.id))!;
    const opened = first.targets![0]!;
    const request = (await ctx.store.getRequest(ctx.tenant, opened.repoId, opened.requestNumber!))!;
    const firstHead = git(["rev-parse", request.branch], alpha).trim();
    await ctx.store.addFollowUp({ tenant: ctx.tenant, id: "fup_ws_local", taskId: first.id, source: "person", key: "person:ws-local-01", text: "Add a third line.", quotes: null, createdAt: new Date().toISOString(), createdBy: first.createdBy });
    await ctx.store.updateTask(ctx.tenant, first.id, { status: "queued" });
    const said: string[] = [];
    const hooks: ExecutorHooks = { signal: new AbortController().signal, onEvent: () => {}, log: (line) => void said.push(line), record: () => {}, onProcess: () => {}, decide: async () => ({ decision: "allow-once" }), leaseHeld: async () => true };

    // when
    await ctx.tasks!.leased().run({ id: first.id, title: first.title, agent: "fake", nativeSession: null }, hooks);

    // then
    const nextHead = git(["rev-parse", request.branch], alpha).trim();
    expect(git(["rev-parse", `${nextHead}^`], alpha).trim()).toBe(firstHead);
    expect(git(["show", `${request.branch}:README.md`], alpha)).toBe("alpha\nA second line.\nA third line.\n");
    expect(await ctx.store.listRequests(ctx.tenant, opened.repoId)).toHaveLength(1);
    expect(await ctx.store.getRequest(ctx.tenant, opened.repoId, opened.requestNumber!)).toMatchObject({ status: "open", checkedHead: nextHead });
    expect((await ctx.store.getTask(ctx.tenant, first.id))!.targets).toEqual([expect.objectContaining({ path: "alpha", status: "request", requestNumber: opened.requestNumber, baseSha: opened.baseSha })]);
    expect(await ctx.store.pendingFollowUps(ctx.tenant, first.id)).toEqual([]);
    expect(said).toContain(`alpha: went on in request #${opened.requestNumber} on ${request.branch}.`);
  });

  it("given a folder of two repositories each with its check approved, when the repair of the second breaks the first after the first passed, then the first is checked again and its evidence says it broke, and the task's tests failed", async () => {
    // given
    const swap = 'const fs = await import("node:fs"); if (fs.existsSync("beta/broken.flag")) { fs.unlinkSync("beta/broken.flag"); writeFileSync("alpha/broken.flag", "the repair broke alpha"); } else { writeFileSync("beta/README.md", "beta\\nHalf.\\n"); writeFileSync("beta/broken.flag", "the line is half"); }';
    const { ctx, app, folder, project, start } = await folderOfRepositories(swap);
    for (const name of ["alpha", "beta"]) {
      const repo = join(folder, name);
      writeFileSync(join(repo, "Makefile"), 'test:\n\t@if [ -f broken.flag ]; then echo "FAIL: $$(cat broken.flag)"; exit 1; fi; echo "all checks pass"\n');
      git(["add", "Makefile"], repo);
      git(["commit", "--quiet", "-m", "A check"], repo);
      const page = await (await app.request(`/api/projects/${project.id}/verification?repo=${name}`)).json();
      await app.request(`/api/projects/${project.id}/verification?repo=${name}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ checks: [page.detected.checks[0]], setup: null }) });
    }

    // when
    const started = await start();
    await ctx.tasks!.idle();

    // then
    const task = (await ctx.store.getTask(ctx.tenant, started.task.id))!;
    expect(task.tests).toBe("failed");
    const shown = await (await app.request(`/api/tasks/${task.id}/verification`)).json();
    expect(shown.verifications).toEqual(expect.arrayContaining([
      { repoId: `${project.id}--alpha`, verification: expect.objectContaining({ verdict: "broken" }) },
      { repoId: `${project.id}--beta`, verification: expect.objectContaining({ verdict: "passed", repairs: 1 }) },
    ]));
    expect((await ctx.store.taskLog(ctx.tenant, task.id, 0)).map((l) => l.text)).toContain("alpha: its check broke again after a later repository's repair round.");
  });

  it("given a folder of two repositories, one with its check approved under its path, when the agent breaks that check, then a repair round in the folder fixes it, its request carries the evidence, and the other repository runs none", async () => {
    // given
    const fix = 'const fs = await import("node:fs"); if (fs.existsSync("alpha/broken.flag")) { fs.rmSync("alpha/broken.flag"); writeFileSync("alpha/README.md", "alpha\\nFixed.\\n"); } else { writeFileSync("alpha/README.md", "alpha\\nHalf.\\n"); writeFileSync("alpha/broken.flag", "the line is half"); }';
    const { ctx, app, folder, project, start } = await folderOfRepositories(fix);
    const alpha = join(folder, "alpha");
    writeFileSync(join(alpha, "Makefile"), 'test:\n\t@if [ -f broken.flag ]; then echo "FAIL: $$(cat broken.flag)"; exit 1; fi; echo "all checks pass"\n');
    git(["add", "Makefile"], alpha);
    git(["commit", "--quiet", "-m", "A check"], alpha);
    const page = await (await app.request(`/api/projects/${project.id}/verification?repo=alpha`)).json();
    const approved = await app.request(`/api/projects/${project.id}/verification?repo=alpha`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ checks: [page.detected.checks[0]], setup: null }) });

    // when
    const started = await start();
    await ctx.tasks!.idle();

    // then
    expect(approved.status).toBe(200);
    const task = (await ctx.store.getTask(ctx.tenant, started.task.id))!;
    expect(task).toMatchObject({ status: "needs-review", tests: "passed", targets: [{ repoId: `${project.id}--alpha`, path: "alpha", status: "request", tests: "passed" }] });
    const shown = await (await app.request(`/api/tasks/${task.id}/verification`)).json();
    expect(shown.verifications).toEqual([{ repoId: `${project.id}--alpha`, verification: expect.objectContaining({ verdict: "passed", repairs: 1 }) }]);
    const request = (await ctx.store.listRequests(ctx.tenant, `${project.id}--alpha`))[0]!;
    expect(git(["notes", "--ref", localDescriptionRef(request.branch), "show", request.branch], alpha)).toContain("make test");
    expect(git(["show", `${request.branch}:README.md`], alpha)).toBe("alpha\nFixed.\n");
    expect((await ctx.store.taskLog(ctx.tenant, task.id, 0)).map((l) => l.text)).not.toContain("No check runs on this task: no repository in this folder has checks approved for it.");
  });

  it("given a folder of two repositories, when the agent changes one, then that one gets the task's branch with one commit over its HEAD and one request, the other gets nothing, neither working copy is touched, and the record holding the request is no project of its own", async () => {
    // given
    const { ctx, app, folder, project, start } = await folderOfRepositories('writeFileSync("alpha/README.md", "alpha\\nA second line.\\n");');
    const alpha = join(folder, "alpha");
    const beta = join(folder, "beta");
    const before = { alpha: copyState(alpha), beta: copyState(beta) };

    // when
    const started = await start();
    await ctx.tasks!.idle();

    // then
    const task = (await ctx.store.getTask(ctx.tenant, started.task.id))!;
    expect(task).toMatchObject({ status: "needs-review", requestNumber: null, targets: [{ repoId: `${project.id}--alpha`, status: "request", reason: "changed by the agent in alpha", baseSha: before.alpha.head, requestNumber: 1, error: null }] });
    const branch = task.targets![0]!.branch!;
    const after = { alpha: copyState(alpha), beta: copyState(beta) };
    expect(after.beta).toEqual(before.beta);
    expect(after.alpha).toEqual({ ...before.alpha, branches: [...before.alpha.branches, `refs/heads/${branch}`].sort() });
    expect(git(["rev-list", "--count", `HEAD..refs/heads/${branch}`], alpha).trim()).toBe("1");
    expect(git(["rev-parse", `refs/heads/${branch}^`], alpha).trim()).toBe(before.alpha.head);
    expect(git(["show", `refs/heads/${branch}:README.md`], alpha)).toBe("alpha\nA second line.\n");
    expect(git(["log", "-1", "--format=%B", `refs/heads/${branch}`], alpha)).not.toContain("Done.");
    const requests = await ctx.store.listRequests(ctx.tenant);
    expect(requests).toEqual([expect.objectContaining({ repoId: `${project.id}--alpha`, number: 1, branch, status: "open", provider: "local" })]);
    expect(await ctx.store.getRepo(ctx.tenant, `${project.id}--alpha`)).toMatchObject({ team: project.team, name: "alpha", url: alpha });
    const listed = (await (await app.request("/api/projects")).json()).projects as { id: string; trust: unknown }[];
    expect((await (await app.request(`/api/projects/${project.id}/repositories`)).json()).repositories).toEqual([{ path: "alpha", name: "alpha", openRequests: 1 }, { path: "beta", name: "beta", openRequests: 0 }]);
    expect(listed.map((p) => [p.id, p.trust])).toEqual([[project.id, null]]);
    expect((await (await app.request(`/api/tasks/${task.id}`)).json()).task.folderTrust).toBeNull();
    const trusted = await app.request(`/api/projects/${project.id}/trust`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ trusted: true }) });
    expect([trusted.status, (await trusted.json()).code]).toEqual([409, "not-a-folder"]);
    expect(existsSync(join(folder, ".git"))).toBe(false);
    const paths = taskPaths(ctx.dataDir, ctx.tenant, task.id);
    expect([existsSync(paths.root), existsSync(paths.git)]).toEqual([false, false]);
  });

  it("given a folder task whose one run changed two repositories and reported its cost, when the task is read, then its cost is whole and no part of it is said to be unreported", async () => {
    // given
    const { ctx, app, start } = await folderOfRepositories('writeFileSync("alpha/README.md", "alpha\\nA line.\\n");\nwriteFileSync("beta/README.md", "beta\\nA line.\\n");');
    const started = await start();
    await ctx.tasks!.idle();
    await ctx.store.updateTask(ctx.tenant, started.task.id, { cost: { usd: 0.62, inputTokens: null, outputTokens: null } });

    // when
    const read = (await (await app.request(`/api/tasks/${started.task.id}`)).json()).task;

    // then
    expect(read.targets.map((t: { status: string }) => t.status)).toEqual(["request", "request"]);
    expect(read.cost.usd).toBe(0.62);
    expect(read).not.toHaveProperty("costPartial");
  });

  it("given a folder of two repositories whose agent changed one and keeps working, when its starter stops the task, then the change waits for review in that repository's request and the stop is the task's reason", async () => {
    // given
    const { ctx, start } = await folderOfRepositories('writeFileSync("alpha/README.md", "alpha\\nHalfway.\\n");\nawait new Promise((r) => setTimeout(r, 20_000));');
    const started = await start();
    const copied = join(taskPaths(ctx.dataDir, ctx.tenant, started.task.id).work, "alpha", "README.md");
    for (let i = 0; i < 200 && !(existsSync(copied) && readFileSync(copied, "utf8").includes("Halfway.")); i++) await new Promise((r) => setTimeout(r, 50));

    // when
    await ctx.tasks!.cancel(started.task.id);
    await ctx.tasks!.idle();

    // then
    expect((await ctx.store.getTask(ctx.tenant, started.task.id))!).toMatchObject({ status: "needs-review", error: "Stopped by the person who started the task.", targets: [{ status: "request", requestNumber: 1 }] });
  });

  it("given a folder of two repositories, when the agent changes neither, then the task fails saying so and no request or record is made", async () => {
    // given
    const { ctx, folder, project, start } = await folderOfRepositories("");
    const before = copyState(join(folder, "alpha"));

    // when
    const started = await start();
    await ctx.tasks!.idle();

    // then
    expect((await ctx.store.getTask(ctx.tenant, started.task.id))!).toMatchObject({ status: "failed", error: "The agent changed no repository, so no request was opened." });
    expect(await ctx.store.listRequests(ctx.tenant)).toEqual([]);
    expect((await ctx.store.listRepos(ctx.tenant)).map((r) => r.id)).toEqual([project.id]);
    expect(copyState(join(folder, "alpha"))).toEqual(before);
  });

  it("given a folder holding more than 50 working copies, when a task starts there, then it fails saying to open one of them instead and its agent does not run", async () => {
    // given
    const { ctx, folder, start } = await folderOfRepositories('writeFileSync("ran.txt", "ran\\n");', []);
    for (let i = 0; i < 51; i++) mkdirSync(join(folder, `repo-${String(i).padStart(2, "0")}`, ".git"), { recursive: true });

    // when
    const started = await start();
    await ctx.tasks!.idle();

    // then
    expect((await ctx.store.getTask(ctx.tenant, started.task.id))!).toMatchObject({ status: "failed", error: "The task did not run: code holds more than 50 repositories; open one of them as the project instead." });
    expect(existsSync(join(folder, "ran.txt"))).toBe(false);
  });
});
