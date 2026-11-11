import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { MiddlewareHandler } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { seed } from "../../demo/seed.js";
import { createApp, syncRepo } from "../app.js";
import type { OrchestratorContext } from "../app.js";
import type { OrchestratorEnv, Principal } from "../auth.js";
import { localRepoPath } from "../forge/local.js";
import { git } from "../git.js";
import { openSqliteStore } from "../store.js";
import { storePrincipals } from "../test-fixtures.js";
import { fakeAgentAdapter } from "./agents.js";
import { createTaskRunner } from "./runner.js";
import type { TaskRecord } from "./types.js";

const ADMIN: Principal = { id: "a", name: "Ada Example", email: "ada@example.invalid", role: "admin", ownedTeams: [] };
const FAKE_AGENT = join(import.meta.dirname, "..", "..", "demo", "fake-agent.mjs");
const NEEDS_TICKET = "payments-skills names branches with a ticket first (its example is PAY-12-fix-login), and this task names none: start it with an issue link whose key fills it";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function as(user: Principal): MiddlewareHandler<OrchestratorEnv> {
  return async (c, next) => {
    c.set("user", user);
    await next();
  };
}

/** The seeded Payments repository with its team file changed by `team` and any other edits, on main. */
async function payments(team: (t: Record<string, unknown>) => Record<string, unknown>, edit: (work: string) => void = () => {}): Promise<{ ctx: OrchestratorContext; bare: string; root: string }> {
  const root = mkdtempSync(join(tmpdir(), "orchestrator-branch-rule-"));
  dirs.push(root);
  const { configFile } = seed(join(root, "demo"));
  const config = JSON.parse(readFileSync(configFile, "utf8"));
  const entry = config.repos.find((r: { id: string }) => r.id === "payments-skills");
  const ctx: OrchestratorContext = { store: openSqliteStore(":memory:"), dataDir: join(root, "data"), tenant: config.tenant, memberUrls: new Map([["payments-skills", "https://git.example.com/acme/payments-skills.git"]]) };
  await storePrincipals(ctx, ADMIN);
  await ctx.store.upsertRepo({ ...entry, tenant: config.tenant });
  const bare = localRepoPath(entry.url)!;
  const work = mkdtempSync(join(root, "work-"));
  git(["clone", "--quiet", bare, work], work);
  const file = join(work, ".teamhandbook.json");
  writeFileSync(file, JSON.stringify(team(JSON.parse(readFileSync(file, "utf8"))), null, 2) + "\n");
  edit(work);
  git(["add", "-A"], work);
  git(["-c", "user.name=Grace Example", "-c", "user.email=grace@example.invalid", "commit", "--allow-empty", "--quiet", "-m", "chore: set the team's naming"], work);
  git(["fetch", "--quiet", work, "main:main"], bare);
  await syncRepo(ctx, "payments-skills");
  return { ctx, bare, root };
}

const keyed = (t: Record<string, unknown>) => ({ ...t, commitPrefix: "PAY", branchExample: "PAY-12-fix-login" });

async function start(ctx: OrchestratorContext, body: Record<string, unknown>, agent = FAKE_AGENT) {
  ctx.tasks = createTaskRunner(ctx, { agents: [fakeAgentAdapter(agent)], isolation: { mode: "process", network: "open" }, testCommand: () => null, hostEnv: { PATH: process.env.PATH } });
  const app = createApp(ctx, as(ADMIN));
  const res = await app.request("/api/tasks", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "Add a note", description: "", repoId: "payments-skills", agent: "fake", ...body }) });
  await ctx.tasks.idle();
  const answer = (await res.json()) as { task?: TaskRecord; error?: string };
  return { status: res.status, error: answer.error, task: answer.task ? (await ctx.store.getTask(ctx.tenant, answer.task.id))! : null, app };
}

describe("a task in a repository whose branch rule starts with a ticket", () => {
  it.each([
    ["any change", {}],
    ["a skill template", { title: "", template: { kind: "skill.write", skill: "on-call" } }],
    ["the scaffold refresh", { title: "", template: { kind: "scaffold.refresh", commitVersioning: false } }],
  ])("given %s and no issue, when it is started, then it is refused with the rule before it waits in line", async (_case, body) => {
    // given
    const { ctx } = await payments(keyed);

    // when
    const { status, error } = await start(ctx, body);

    // then
    expect([status, error]).toEqual([409, NEEDS_TICKET]);
    expect(await ctx.store.listTasks(ctx.tenant)).toEqual([]);
  });

  it("given an issue link, when the task runs, then the issue's key fills the ticket and the request opens on a branch the rule accepts", async () => {
    // given
    const { ctx } = await payments(keyed);

    // when
    const { task } = await start(ctx, { title: "", issueUrl: "https://tracker.example.com/browse/PAY-142" });

    // then
    expect(task).toMatchObject({ status: "needs-review" });
    const [request] = await ctx.store.listRequests(ctx.tenant);
    expect(request!.branch).toMatch(/^PAY-142-work-on-[0-9a-z]{6}$/);
  });

  it("given the form's options, when they are read, then the repository says what its rule asks for", async () => {
    // given
    const { ctx } = await payments(keyed);
    const { app } = await start(ctx, {});

    // when
    const options = await (await app.request("/api/tasks/options")).json();

    // then
    expect(options.repos.find((r: { id: string }) => r.id === "payments-skills").ticketExample).toBe("PAY-12-fix-login");
  });

  it("given a start that does not come through the API, when the task runs, then it fails with the rule before any agent runs", async () => {
    // given
    const { ctx } = await payments(keyed);
    const tasks = createTaskRunner(ctx, { agents: [fakeAgentAdapter(FAKE_AGENT)], isolation: { mode: "process", network: "open" }, testCommand: () => null, hostEnv: { PATH: process.env.PATH } });
    const repo = (await ctx.store.getRepo(ctx.tenant, "payments-skills"))!;

    // when
    const started = await tasks.start({ repo, title: "Add a note", description: "", agent: "fake", user: ADMIN });
    await tasks.idle();

    // then
    expect(await ctx.store.getTask(ctx.tenant, started.id)).toMatchObject({ status: "failed", error: `The task did not run: ${NEEDS_TICKET}.` });
    expect((await ctx.store.taskLog(ctx.tenant, started.id, 0)).map((l) => l.text).filter((l) => l.startsWith("Starting"))).toEqual([]);
  });
});

/** An agent that sets the team file's commit prefix to `prefix` and adds a note. */
function settingPrefix(root: string, prefix: string): string {
  const file = join(root, `prefix-${Buffer.from(prefix).toString("hex")}.mjs`);
  writeFileSync(
    file,
    `import { readFileSync, writeFileSync } from "node:fs";\nconst t = JSON.parse(readFileSync(".teamhandbook.json", "utf8"));\nt.commitPrefix = ${JSON.stringify(prefix)};\nwriteFileSync(".teamhandbook.json", JSON.stringify(t, null, 2) + "\\n");\nwriteFileSync("note.md", "x\\n");\nconsole.log(JSON.stringify({ type: "result", summary: "Done." }));\n`,
  );
  return file;
}

describe("an agent that changes the team's commit prefix", () => {
  it.each([
    ["to one with a control character", (t: Record<string, unknown>) => t, () => {}, "PAY\u001b[31m", "The agent changed the team's commit prefix to one the plugin does not accept (it is carrying a control character); no request was opened."],
    [
      "beside the version-bump job",
      (t: Record<string, unknown>) => t,
      (work: string) => {
        mkdirSync(dirname(join(work, "scripts/bump-version.mjs")), { recursive: true });
        writeFileSync(join(work, "scripts/bump-version.mjs"), "// raises the version\n");
      },
      "OPS",
      "The agent changed the team's commit prefix, and the version-bump job (scripts/bump-version.mjs) commits with it on every merge; change it with /handbook:init --upgrade --commit-prefix, which rewrites the job with it. No request was opened.",
    ],
  ])("given an agent that changes it %s, when the task ends, then it fails with the reason and nothing reaches the team repository", async (_case, team, edit, prefix, error) => {
    // given
    const { ctx, bare, root } = await payments(team, edit);

    // when
    const { task } = await start(ctx, {}, settingPrefix(root, prefix));

    // then
    expect(task).toMatchObject({ status: "failed", error });
    expect(git(["for-each-ref", "--format=%(refname:short)", "refs/heads/"], bare).trim()).toBe("main");
  });

  it("given no version-bump job, when an agent changes the prefix to one the plugin accepts, then the request opens with the team's settings named first", async () => {
    // given
    const { ctx, root } = await payments((t) => t);

    // when
    const { task } = await start(ctx, {}, settingPrefix(root, "OPS"));

    // then
    expect(task!.status).toBe("needs-review");
    expect((await ctx.store.taskLog(ctx.tenant, task!.id, 0)).map((l) => l.text)).toContain(
      "Look at this before merging: .teamhandbook.json is changed: the team's settings: commit prefix, branch naming, reviewers, labels and where skill use is reported.",
    );
  });
});
