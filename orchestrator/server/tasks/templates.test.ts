import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
const SKILL = (name: string) => `---\nname: ${name}\ndescription: Use when handing over the pager at shift change.\n---\n\n1. Write the handover.\n`;

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

async function seeded(): Promise<{ ctx: OrchestratorContext; root: string }> {
  const root = mkdtempSync(join(tmpdir(), "orchestrator-templates-"));
  dirs.push(root);
  const { configFile } = seed(join(root, "demo"));
  const config = JSON.parse(readFileSync(configFile, "utf8"));
  const ctx: OrchestratorContext = { store: openSqliteStore(":memory:"), dataDir: join(root, "data"), tenant: config.tenant };
  await storePrincipals(ctx, ADMIN);
  for (const repo of config.repos) {
    await ctx.store.upsertRepo({ ...repo, tenant: config.tenant });
    await syncRepo(ctx, repo.id);
  }
  return { ctx, root };
}

/** An agent that runs `body` in its checkout, with the prompt it was given in `prompt`, and reports success. */
function agentScript(root: string, name: string, body: string): string {
  const file = join(root, `${name}.mjs`);
  writeFileSync(file, `import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";\nconst prompt = readFileSync(0, "utf8");\n${body}\nconsole.log(JSON.stringify({ type: "result", summary: "Done." }));\n`);
  return file;
}

async function start(ctx: OrchestratorContext, agent: string, body: Record<string, unknown>) {
  ctx.tasks = createTaskRunner(ctx, { agents: [fakeAgentAdapter(agent)], isolation: { mode: "process", network: "open" }, testCommand: () => null, hostEnv: { PATH: process.env.PATH } });
  const res = await createApp(ctx, as(ADMIN)).request("/api/tasks", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "", description: "", repoId: "payments-skills", agent: "fake", ...body }),
  });
  await ctx.tasks.idle();
  const answer = (await res.json()) as { task?: TaskRecord; error?: string };
  const task = answer.task ? (await ctx.store.getTask(ctx.tenant, answer.task.id))! : null;
  return { status: res.status, error: answer.error, task };
}

const bareOf = async (ctx: OrchestratorContext) => localRepoPath((await ctx.store.getRepo(ctx.tenant, "payments-skills"))!.url)!;

describe("a task started from a template", () => {
  it("given the template to write a new skill and no title, when the agent writes it, then the task is named after it, its prompt says what a skill is and where it stays, and the request carries the skill", async () => {
    // given
    const { ctx, root } = await seeded();
    const agent = agentScript(root, "writer", `mkdirSync("skills/on-call", { recursive: true });\nwriteFileSync("skills/on-call/SKILL.md", ${JSON.stringify(SKILL("on-call"))});\nwriteFileSync("skills/on-call/prompt.txt", prompt);`);

    // when
    const { status, task } = await start(ctx, agent, { template: { kind: "skill.write", skill: "on-call" } });

    // then
    expect(status).toBe(201);
    expect(task).toMatchObject({ title: "Write the skill on-call", status: "needs-review", template: { kind: "skill.write", skill: "on-call" } });
    const bare = await bareOf(ctx);
    const sent = git(["show", `task/${task!.id}:skills/on-call/prompt.txt`], bare);
    expect(sent).toContain("Write a new skill named on-call: create skills/on-call/SKILL.md.");
    expect(sent).toContain("`name: on-call` and a one-line `description:` that says when to use the skill.");
    expect(sent).toContain("Change nothing outside skills/on-call/: the orchestrator refuses a change that does.");
  });

  it.each([
    ["writes outside the skill's folder", "skill.write", "on-call", `mkdirSync("skills/on-call", { recursive: true });\nwriteFileSync("skills/on-call/SKILL.md", ${JSON.stringify(SKILL("on-call"))});\nwriteFileSync("README.md", "changed\\n");`, "The task writes the skill on-call, and the agent also changed README.md, outside skills/on-call/; no request was opened."],
    ["writes no SKILL.md for a new skill", "skill.write", "on-call", `mkdirSync("skills/on-call", { recursive: true });\nwriteFileSync("skills/on-call/notes.md", "notes\\n");`, "The task writes the skill on-call, and the agent left no skills/on-call/SKILL.md; no request was opened."],
    ["deletes the SKILL.md it was to improve", "skill.improve", "release-checklist", `rmSync("skills/release-checklist/SKILL.md");\nwriteFileSync("skills/release-checklist/notes.md", "notes\\n");`, "The task improves the skill release-checklist, and the agent deleted its SKILL.md; no request was opened."],
  ])("given an agent that %s, when the task ends, then it fails saying how and nothing reaches the team repository", async (_case, kind, skill, body, error) => {
    // given
    const { ctx, root } = await seeded();

    // when
    const { task } = await start(ctx, agentScript(root, "stray", body), { template: { kind, skill } });

    // then
    expect(task).toMatchObject({ status: "failed", error, requestNumber: null });
    expect(git(["for-each-ref", "--format=%(refname:short)", "refs/heads/"], await bareOf(ctx)).trim()).toBe("main");
  });

  it("given the template to improve a skill the repository has, when the agent rewrites it, then the request carries the new text and the task keeps its template for Run again", async () => {
    // given
    const { ctx, root } = await seeded();
    const agent = agentScript(root, "improver", `writeFileSync("skills/release-checklist/SKILL.md", ${JSON.stringify(SKILL("release-checklist"))});`);

    // when
    const { task } = await start(ctx, agent, { template: { kind: "skill.improve", skill: "release-checklist" } });

    // then
    expect(task).toMatchObject({ title: "Improve the skill release-checklist", status: "needs-review", template: { kind: "skill.improve", skill: "release-checklist" } });
    expect(git(["show", `task/${task!.id}:skills/release-checklist/SKILL.md`], await bareOf(ctx))).toBe(SKILL("release-checklist"));
  });

  it.each([
    [{ kind: "skill.write", skill: "release-checklist" }, 409, "payments-skills already has the skill release-checklist; improve it instead"],
    [{ kind: "skill.improve", skill: "no-such-skill" }, 409, "payments-skills has no skill no-such-skill to improve"],
    [{ kind: "skill.delete", skill: "release-checklist" }, 400, "a template writes or improves one skill, named with lower-case letters, digits and dashes"],
    [{ kind: "skill.write", skill: "On Call" }, 400, "a template writes or improves one skill, named with lower-case letters, digits and dashes"],
  ])("given the template %j, when a task is started, then it is refused with the reason and no task is created", async (template, status, error) => {
    // given
    const { ctx } = await seeded();

    // when
    const answer = await start(ctx, FAKE_AGENT, { template });

    // then
    expect([answer.status, answer.error]).toEqual([status, error]);
    expect(await ctx.store.listTasks(ctx.tenant)).toEqual([]);
  });

  it("given the stand-in and the template to write a skill, when the task ends, then the stand-in wrote that skill and the request opens", async () => {
    // given
    const { ctx } = await seeded();

    // when
    const { task } = await start(ctx, FAKE_AGENT, { template: { kind: "skill.write", skill: "pager-handover" } });

    // then
    expect(task).toMatchObject({ status: "needs-review", requestNumber: 1 });
    expect(git(["show", `task/${task!.id}:skills/pager-handover/SKILL.md`], await bareOf(ctx))).toContain("name: pager-handover");
  });
});
