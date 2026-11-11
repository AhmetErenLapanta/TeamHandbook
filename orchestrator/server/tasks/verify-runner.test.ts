import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MiddlewareHandler } from "hono";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createUser } from "../accounts.js";
import { createApp, mirrorDir, syncRepo } from "../app.js";
import type { OrchestratorContext } from "../app.js";
import type { OrchestratorEnv, Principal } from "../auth.js";
import { openProject } from "../project-routes.js";
import { openSqliteStore } from "../store.js";
import { localDescriptionRef, localRepoPath } from "../forge/local.js";
import { git } from "../git.js";
import { copyOf, seededContext, storePrincipals } from "../test-fixtures.js";
import { fakeAgentAdapter } from "./agents.js";
import { createTaskRunner } from "./runner.js";
import { detectVerification } from "./verify-detect.js";
import { approveVerification, commitReader, readEvidence } from "./verify.js";

const ADMIN: Principal = { id: "a", name: "Ada Example", email: "ada@example.invalid", role: "admin", ownedTeams: [] };
const REPO = "payments-skills";
const MAKEFILE = 'test:\n\t@if [ -f broken.flag ]; then echo "FAIL: $$(cat broken.flag)"; exit 1; fi; echo "all checks pass"\n';

const dirs: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const as = (user: Principal): MiddlewareHandler<OrchestratorEnv> => async (c, next) => {
  c.set("user", user);
  await next();
};

interface Template {
  tenant: string;
  dataDir: string;
  bare: string;
  repos: { id: string; team: string; name: string; url: string; head: string }[];
  approval: string;
}

/**
 * The seeded skills repository with a Makefile check committed and synced, and its check approved as
 * its files name it: built once for the file, each test taking a copy, since every git call this
 * setup makes costs a process start.
 */
async function project(): Promise<{ ctx: OrchestratorContext; root: string; bare: string }> {
  const { root, made } = await copyOf<Template>("verify:makefile-check", "orchestrator-verify-", async (at) => {
    const { ctx } = await seededContext("seed-", undefined, "main", at);
    const bare = localRepoPath((await ctx.store.getRepo(ctx.tenant, REPO))!.url)!;
    const work = mkdtempSync(join(at, "work-"));
    git(["clone", "--quiet", bare, work], work);
    writeFileSync(join(work, "Makefile"), MAKEFILE);
    git(["add", "-A"], work);
    git(["-c", "user.name=Grace Example", "-c", "user.email=grace@example.invalid", "commit", "--quiet", "-m", "chore: add a check"], work);
    git(["fetch", "--quiet", work, "main:main"], bare);
    await syncRepo(ctx, REPO);
    const repo = (await ctx.store.getRepo(ctx.tenant, REPO))!;
    const detected = await detectVerification(commitReader(mirrorDir(ctx, REPO), repo.head!));
    const approved = await approveVerification(ctx.store, ctx.tenant, REPO, detected, { checks: [detected.checks[0]!], setup: null }, ADMIN.name);
    if ("refused" in approved) throw new Error(approved.refused);
    const repos = (await ctx.store.listRepos(ctx.tenant)).map(({ id, team, name, url, head }) => ({ id, team, name, url, head: head! }));
    return { tenant: ctx.tenant, dataDir: ctx.dataDir, bare, repos, approval: JSON.stringify(approved) };
  });
  dirs.push(root);
  const ctx: OrchestratorContext = { store: openSqliteStore(":memory:"), dataDir: made.dataDir, tenant: made.tenant };
  await storePrincipals(ctx, ADMIN);
  for (const { head, ...repo } of made.repos) {
    await ctx.store.upsertRepo({ ...repo, tenant: made.tenant });
    await ctx.store.recordSync(made.tenant, repo.id, { head });
  }
  await ctx.store.setSetting(made.tenant, `verify.approved.${REPO}`, made.approval);
  return { ctx, root, bare: made.bare };
}

/**
 * A stand-in agent that writes a skill on its first turn and runs `onFirst` there, and runs
 * `onRepair` on each repair round; it counts its turns in a file beside the repository.
 */
function agent(root: string, onFirst: string, onRepair = "", summary = "Wrote the skill."): string {
  const file = join(root, `agent-${Math.random().toString(36).slice(2)}.mjs`);
  const turns = join(root, "turns.log");
  writeFileSync(
    file,
    `import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
const prompt = readFileSync(0, "utf8");
const repair = prompt.includes("This is repair round");
appendFileSync(${JSON.stringify(turns)}, repair ? "repair\\n" : "first\\n");
if (repair) {
  ${onRepair}
} else {
  mkdirSync("skills/on-call-handover", { recursive: true });
  writeFileSync("skills/on-call-handover/SKILL.md", "---\\nname: on-call-handover\\ndescription: Use when handing over the on-call shift.\\n---\\n\\nSteps.\\n");
  ${onFirst}
}
console.log(JSON.stringify({ type: "result", summary: ${JSON.stringify(summary)} }));
`,
  );
  return file;
}

async function run(ctx: OrchestratorContext, script: string, testCommand: string | null = null) {
  const tasks = createTaskRunner(ctx, { agents: [fakeAgentAdapter(script)], isolation: { mode: "process", network: "open" }, testCommand: () => testCommand, hostEnv: { PATH: process.env.PATH } });
  const repo = (await ctx.store.getRepo(ctx.tenant, REPO))!;
  const started = await tasks.start({ repo, title: "Add an on-call handover", description: "", agent: "fake", user: ADMIN });
  await tasks.idle();
  const task = (await ctx.store.getTask(ctx.tenant, started.id))!;
  const log = (await ctx.store.taskLog(ctx.tenant, task.id, 0)).map((l) => l.text);
  const [request] = await ctx.store.listRequests(ctx.tenant, REPO);
  return { task, log, request, evidence: await readEvidence(ctx.store, ctx.tenant, task.id, REPO) };
}

const readTurns = (root: string) => readFileSync(join(root, "turns.log"), "utf8").trim().split("\n");
const bodyOf = (bare: string, branch: string) => git(["notes", "--ref", localDescriptionRef(branch), "show", branch], bare);

describe("a task's check, before and after its agent", { timeout: 120_000 }, () => {
  // The copy's template is built here, on its own time, rather than inside the first test.
  beforeAll(async () => void dirs.push((await project()).root), 120_000);

  it("given an approved check the agent breaks and its first repair round fixes, when the task runs, then the request opens green after one repair, with the evidence in its body", async () => {
    // given
    const { ctx, root, bare } = await project();
    const script = agent(root, 'writeFileSync("broken.flag", "the handover table is empty");', 'rmSync("broken.flag", { force: true });');

    // when
    const { task, log, request, evidence } = await run(ctx, script);

    // then
    expect(task).toMatchObject({ status: "needs-review", tests: "passed" });
    expect(readTurns(root)).toEqual(["first", "repair"]);
    expect(log.indexOf("Running the check before the agent: make test")).toBeLessThan(log.findIndex((l) => l.startsWith("Starting")));
    expect(log).toContain("`make test` fails on the agent's change; asking for repair round 1 of 2.");
    expect(evidence).toMatchObject({ verdict: "passed", repairs: 1, checks: [{ command: "make test", source: "Makefile target test", verdict: "passed", before: { code: 0 }, after: [{ code: 2, output: expect.stringContaining("FAIL: the handover table is empty") }, { code: 0, output: "all checks pass" }] }] });
    expect(git(["ls-tree", "-r", "--name-only", request!.branch], bare)).not.toContain("broken.flag");
    const body = bodyOf(bare, request!.branch);
    expect(body).toContain("Agent: fake. Tests: passed.");
    expect(body).toContain("## Verification\n\n`make test` passes before the agent's change and after it, after 1 repair round.");
    expect(body).toContain("| Command | Before the agent | After the agent | After repair round 1 |");
    expect(body).toMatch(/\| `make test` \| exit 0, [\d.]+ s \| exit 2, [\d.]+ s \| exit 0, [\d.]+ s \|/);
    expect(body).toContain("Wrote the skill.\n\nAfter a repair round: Wrote the skill.");
  });

  it("given an agent whose change stays broken, when the task runs, then it gets exactly two repair rounds and the request opens marked broken", async () => {
    // given
    const { ctx, root, bare } = await project();
    const script = agent(root, 'writeFileSync("broken.flag", "still empty");');

    // when
    const { task, request, evidence } = await run(ctx, script);

    // then
    expect(readTurns(root)).toEqual(["first", "repair", "repair"]);
    expect(task).toMatchObject({ status: "needs-review", tests: "failed" });
    expect(evidence).toMatchObject({ verdict: "broken", repairs: 2 });
    expect(evidence!.checks[0]!.after).toHaveLength(3);
    const body = bodyOf(bare, request!.branch);
    expect(body).toContain("Agent: fake. Tests: broken.");
    expect(body).toContain("## Verification\n\n**Broken:** `make test` passed before the agent's change and still fails after 2 repair rounds (exit code 2).");
  });

  it("given an agent that rewrites the approved check, when the task runs, then the check does not run on its change and no repair round is asked", async () => {
    // given
    const { ctx, root } = await project();
    const script = agent(root, 'writeFileSync("Makefile", "test:\\n\\t@true\\n"); writeFileSync("broken.flag", "hidden");');

    // when
    const { task, log, evidence } = await run(ctx, script);

    // then
    expect(readTurns(root)).toEqual(["first"]);
    expect(task).toMatchObject({ status: "needs-review", tests: "skipped" });
    expect(evidence).toMatchObject({ verdict: "not-run", checks: [{ verdict: "not-run", after: [] }] });
    expect(evidence!.reason).toContain("The agent's change touches Makefile target test");
    expect(log).not.toContain("Running the check after the agent: make test");
  });

});

describe("a check in a folder worked on in place", { timeout: 120_000 }, () => {
  /** One person's orchestrator with the folder notes (no git) holding a Makefile check, opened as a project. */
  async function folder() {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "orchestrator-verify-place-")));
    dirs.push(root);
    const home = join(root, "home");
    const notes = join(home, "notes");
    mkdirSync(notes, { recursive: true });
    writeFileSync(join(notes, "README.md"), "Notes.\n");
    writeFileSync(join(notes, "Makefile"), MAKEFILE);
    vi.stubEnv("HOME", home);
    vi.stubEnv("ORCHESTRATOR_MODE", "local");
    const ctx: OrchestratorContext = { store: openSqliteStore(":memory:"), dataDir: join(root, "data"), tenant: "default", addedRepos: new Map(), localReposRoot: home };
    const account = await createUser(ctx.store, ctx.tenant, new Set(["Mine"]), { email: "ada@example.invalid", name: "Ada Example", role: "owner" }, { ...ADMIN, role: "owner" });
    const ada: Principal = { id: account.id, name: account.name, email: account.email, role: "owner", ownedTeams: [], restrictedTeams: [] };
    const { project } = await openProject(ctx, ada, notes);
    return { ctx, root, home, notes, project, ada, app: createApp(ctx, as(ada)) };
  }

  it("given a folder's check approved on its page and an agent that breaks it, when the task runs, then the repair round fixes the same folder and the one record of its changes holds both turns", async () => {
    // given
    const { ctx, root, home, notes, project, ada, app } = await folder();
    const page = await (await app.request(`/api/projects/${project.id}/verification`)).json();
    const check = page.detected.checks[0];
    const approved = await app.request(`/api/projects/${project.id}/verification`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ checks: [check], setup: null }) });
    const script = agent(root, 'writeFileSync("todo.md", "- one\\n"); writeFileSync("broken.flag", "the list is empty");', 'rmSync("broken.flag", { force: true }); writeFileSync("todo.md", "- one\\n- two\\n");');
    // The repair round is what is measured, so the agent runs one-shot: Auto as the person would otherwise talk, asking about tools off its list.
    ctx.tasks = createTaskRunner(ctx, { agents: [{ ...fakeAgentAdapter(script), twoWay: undefined }], isolation: { mode: "process", network: "open" }, testCommand: () => null, hostEnv: { PATH: process.env.PATH, HOME: home }, profile: "personal" });
    await ctx.tasks.ready();
    const withTasks = createApp(ctx, as(ada));

    // when
    const sent = await (await withTasks.request("/api/tasks", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ repoId: project.id, title: "Add a list", agent: "fake", mode: "auto" }) })).json();
    await ctx.tasks.idle();

    // then
    expect(page).toMatchObject({ configured: null, approved: null, unread: null, changed: [], detected: { checks: [{ command: "make test", source: "Makefile target test" }] } });
    expect(approved.status).toBe(200);
    const task = (await ctx.store.getTask(ctx.tenant, sent.task.id))!;
    expect(readTurns(root)).toEqual(["first", "repair"]);
    expect(task).toMatchObject({ status: "needs-review", tests: "passed", result: "changes" });
    const changed = task.changes!.files.map((f) => f.path);
    expect(changed).toContain("todo.md");
    expect(changed).not.toContain("broken.flag");
    expect(readFileSync(join(notes, "todo.md"), "utf8")).toBe("- one\n- two\n");
    expect(existsSync(join(notes, "broken.flag"))).toBe(false);
    const shown = await (await withTasks.request(`/api/tasks/${task.id}/verification`)).json();
    expect(shown.verifications).toEqual([{ repoId: project.id, verification: expect.objectContaining({ verdict: "passed", repairs: 1, checks: [expect.objectContaining({ before: expect.objectContaining({ code: 0 }) })] }) }]);
  });

  it("given a folder's check, when it is approved with a digest the files no longer have or by a member, then it is refused and nothing is kept", async () => {
    // given
    const { ctx, project, app } = await folder();
    const page = await (await app.request(`/api/projects/${project.id}/verification`)).json();
    const check = page.detected.checks[0];
    const member: Principal = { id: "m", name: "Max Example", email: "max@example.invalid", role: "member", ownedTeams: [] };
    const put = (body: unknown, user?: Principal) => (user ? createApp(ctx, as(user)) : app).request(`/api/projects/${project.id}/verification`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

    // when
    const stale = await put({ checks: [{ ...check, digest: "0".repeat(64) }], setup: null });
    const byMember = await put({ checks: [check], setup: null }, member);
    const byKey = await put({ checks: [check], setup: null }, { ...ADMIN, key: { id: "k1", owner: { kind: "user", id: ADMIN.id }, scopes: {}, expiresAt: null } } as unknown as Principal);

    // then
    expect(stale.status).toBe(409);
    expect(byMember.status).toBe(403);
    expect(byKey.status).toBe(403);
    expect((await (await app.request(`/api/projects/${project.id}/verification`)).json()).approved).toBeNull();
  });
});
