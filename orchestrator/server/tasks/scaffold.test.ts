import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { MiddlewareHandler } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { seed } from "../../demo/seed.js";
import { createApp, syncRepo } from "../app.js";
import type { OrchestratorContext } from "../app.js";
import type { OrchestratorEnv, Principal } from "../auth.js";
import { localDescriptionRef, localRepoPath } from "../forge/local.js";
import { git } from "../git.js";
import { skeletonFiles } from "../plugin.js";
import { ORCHESTRATOR_RELEASE } from "../setup.js";
import { openSqliteStore } from "../store.js";
import { storePrincipals } from "../test-fixtures.js";
import { fakeAgentAdapter } from "./agents.js";
import { createTaskRunner } from "./runner.js";
import type { TaskRecord } from "./types.js";

const ADMIN: Principal = { id: "a", name: "Ada Example", email: "ada@example.invalid", role: "admin", ownedTeams: [] };
const FAKE_AGENT = join(import.meta.dirname, "..", "..", "demo", "fake-agent.mjs");
const MEMBER_URL = "https://git.example.com/acme/payments-skills.git";
const MANIFEST = ".claude-plugin/plugin.json";

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

/** The seeded Payments repository, with the teammates' address `member` (none for null) and the changes `edit` makes to it on main. */
async function payments(member: string | null, edit: (work: string) => void = () => {}): Promise<{ ctx: OrchestratorContext; bare: string; root: string }> {
  const root = mkdtempSync(join(tmpdir(), "orchestrator-scaffold-"));
  dirs.push(root);
  const { configFile } = seed(join(root, "demo"));
  const config = JSON.parse(readFileSync(configFile, "utf8"));
  const entry = config.repos.find((r: { id: string }) => r.id === "payments-skills");
  const ctx: OrchestratorContext = { store: openSqliteStore(":memory:"), dataDir: join(root, "data"), tenant: config.tenant, ...(member ? { memberUrls: new Map([["payments-skills", member]]) } : {}) };
  await storePrincipals(ctx, ADMIN);
  await ctx.store.upsertRepo({ ...entry, tenant: config.tenant });
  const bare = localRepoPath(entry.url)!;
  const work = mkdtempSync(join(root, "work-"));
  git(["clone", "--quiet", bare, work], work);
  edit(work);
  git(["add", "-A"], work);
  git(["-c", "user.name=Grace Example", "-c", "user.email=grace@example.invalid", "commit", "--allow-empty", "--quiet", "-m", "chore: set up"], work);
  git(["fetch", "--quiet", work, "main:main"], bare);
  await syncRepo(ctx, "payments-skills");
  return { ctx, bare, root };
}

const json = (work: string, path: string, change: (value: Record<string, unknown>) => Record<string, unknown>) =>
  writeFileSync(join(work, path), JSON.stringify(change(JSON.parse(readFileSync(join(work, path), "utf8"))), null, 2) + "\n");

async function refresh(ctx: OrchestratorContext, commitVersioning = false) {
  ctx.tasks = createTaskRunner(ctx, { agents: [fakeAgentAdapter(FAKE_AGENT)], isolation: { mode: "process", network: "open" }, testCommand: () => null, hostEnv: { PATH: process.env.PATH } });
  const res = await createApp(ctx, as(ADMIN)).request("/api/tasks", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "", description: "", repoId: "payments-skills", agent: "fake", template: { kind: "scaffold.refresh", commitVersioning } }),
  });
  await ctx.tasks.idle();
  const answer = (await res.json()) as { task?: TaskRecord; error?: string };
  const task = answer.task ? (await ctx.store.getTask(ctx.tenant, answer.task.id))! : null;
  const log = task ? (await ctx.store.taskLog(ctx.tenant, task.id, 0)).map((l) => l.text) : [];
  return { status: res.status, error: answer.error, task, log };
}

function requestOf(bare: string, branch: string) {
  return {
    touched: git(["diff", "--name-only", `${branch}^`, branch], bare).trim().split("\n"),
    description: git(["notes", "--ref", localDescriptionRef(branch), "show", branch], bare),
    show: (path: string) => git(["show", `${branch}:${path}`], bare),
  };
}

describe("the scaffold refreshed by the orchestrator, with no agent", () => {
  it("given a scaffold an older release wrote for another address, when an admin asks for the refresh, then the orchestrator writes what the plugin writes today for the teammates' address, records its release, and leaves the team's own files alone", async () => {
    // given
    const { ctx, bare } = await payments(MEMBER_URL, (work) => json(work, ".teamhandbook.json", (t) => ({ ...t, scaffoldVersion: "0.1.0" })));

    // when
    const { status, task, log } = await refresh(ctx);

    // then
    expect(status).toBe(201);
    expect(task).toMatchObject({ status: "needs-review", agent: "orchestrator", title: "chore: refresh the team handbook scaffold", template: { kind: "scaffold.refresh", commitVersioning: false } });
    const request = requestOf(bare, (await ctx.store.listRequests(ctx.tenant))[0]!.branch);
    expect(request.touched.some((path) => path.startsWith("skills/") || path.startsWith("commands/") || path === ".mcp.json")).toBe(false);
    expect(request.show("README.md")).toContain(MEMBER_URL);
    expect(JSON.parse(request.show(".teamhandbook.json")).scaffoldVersion).toBe(ORCHESTRATOR_RELEASE);
    expect(request.description).toContain("## What the orchestrator did");
    expect(request.description).toContain(`Refreshed the scaffold to what TeamHandbook ${ORCHESTRATOR_RELEASE} writes, for teammates adding ${MEMBER_URL}:`);
    expect(request.description).not.toContain("## The agent's report");
    expect(log).toContain("Refreshing the scaffold; no agent runs.");
  });

  it("given a plugin that carries a version, when the scaffold is refreshed, then the request raises it as every orchestrator request does", async () => {
    // given
    const { ctx, bare } = await payments(MEMBER_URL, (work) => json(work, MANIFEST, (m) => ({ ...m, version: "0.1.5" })));

    // when
    const { task } = await refresh(ctx);

    // then
    const request = requestOf(bare, `task/${task!.id}`);
    expect(JSON.parse(request.show(MANIFEST)).version).toBe("0.1.6");
    expect(request.description).toContain("Raises the plugin to version 0.1.6, so teammates fetch it once this is merged.");
    expect(request.description).not.toContain("reaches nobody");
  });

  it("given a versioned plugin with an open branch claiming the next version, when the switch to versioning by commit is asked for, then the version line goes, and the request names the open claim and the release teammates need", async () => {
    // given
    const { ctx, bare, root } = await payments(MEMBER_URL, (work) => json(work, MANIFEST, (m) => ({ ...m, version: "0.1.5" })));
    const claim = mkdtempSync(join(root, "claim-"));
    git(["clone", "--quiet", bare, claim], claim);
    json(claim, MANIFEST, (m) => ({ ...m, version: "0.1.6" }));
    git(["-c", "user.name=Grace Example", "-c", "user.email=grace@example.invalid", "commit", "--quiet", "-am", "chore: raise"], claim);
    git(["fetch", "--quiet", claim, "HEAD:refs/heads/handbook/raise"], bare);
    await syncRepo(ctx, "payments-skills");

    // when
    const { task } = await refresh(ctx, true);

    // then
    expect(task).toMatchObject({ status: "needs-review", title: "chore: switch the plugin to versioning by commit" });
    const request = requestOf(bare, `task/${task!.id}`);
    expect(JSON.parse(request.show(MANIFEST))).not.toHaveProperty("version");
    expect(request.description).toContain(`This request switches the repository to versioning by commit: it takes "version": "0.1.5" out of ${MANIFEST},`);
    expect(request.description).toContain("Open now: handbook/raise (0.1.6).");
    expect(request.description).toContain("check that everyone who shares to this repository is on 0.31.0 or later before merging.");
  });

  it("given a repository that runs the version-bump job and a commit prefix changed since, when the scaffold is refreshed, then the job is rewritten with the new prefix and the request opens", async () => {
    // given
    const { ctx, bare } = await payments(MEMBER_URL, (work) => {
      const ci = skeletonFiles("payments-skills", MEMBER_URL, "git.example.com", "PAY", true);
      for (const path of [".gitlab-ci.yml", "scripts/bump-version.mjs"]) {
        mkdirSync(dirname(join(work, path)), { recursive: true });
        writeFileSync(join(work, path), ci[path]!);
      }
      json(work, MANIFEST, (m) => ({ ...m, version: "0.1.5" }));
      json(work, ".teamhandbook.json", (t) => ({ ...t, commitPrefix: "OPS" }));
    });

    // when
    const { task } = await refresh(ctx);

    // then
    expect(task!.status).toBe("needs-review");
    const request = requestOf(bare, `task/${task!.id}`);
    expect(request.touched).toContain(".gitlab-ci.yml");
    expect(request.show(".gitlab-ci.yml")).toContain("OPS ci: bump plugin version");
    expect(request.show(".gitlab-ci.yml")).toContain("https://oauth2:${TEAMHANDBOOK_CI_TOKEN}@");
  });

  it.each([
    ["no address for teammates", null, () => {}, false, 409, "payments-skills has no memberUrl in the orchestrator's configuration: the scaffold writes the address teammates add the repository by, so it is not refreshed without one"],
  ])("given %s, when the refresh is asked for, then it is refused before any task starts", async (_case, member, edit, commitVersioning, status, error) => {
    // given
    const { ctx } = await payments(member, edit);

    // when
    const answer = await refresh(ctx, commitVersioning);

    // then
    expect([answer.status, answer.error]).toEqual([status, error]);
    expect(await ctx.store.listTasks(ctx.tenant)).toEqual([]);
  });

  it.each([
    ["a plugin already versioned by commit", (work: string) => json(work, MANIFEST, ({ version: _v, ...m }) => m), true, `The repository is already versioned by commit: ${MANIFEST} carries no version. No request was opened.`],
    [
      "the version-bump job in its CI",
      (work: string) => {
        json(work, MANIFEST, (m) => ({ ...m, version: "0.1.5" }));
        mkdirSync(dirname(join(work, "scripts/bump-version.mjs")), { recursive: true });
        writeFileSync(join(work, "scripts/bump-version.mjs"), "// raises the version\n");
      },
      true,
      "The repository runs the version-bump job (scripts/bump-version.mjs), which raises the version on every merge and fails on a manifest without one; take the job and that script out first. No request was opened.",
    ],
    ["a scaffold a newer TeamHandbook wrote", (work: string) => json(work, ".teamhandbook.json", (t) => ({ ...t, scaffoldVersion: "99.0.0" })), false, /^The scaffold was not refreshed: /],
  ])("given %s, when the refresh is asked for, then the task fails with the plugin's reason and nothing reaches the team repository", async (_case, edit, commitVersioning, error) => {
    // given
    const { ctx, bare } = await payments(MEMBER_URL, edit);

    // when
    const { task } = await refresh(ctx, commitVersioning);

    // then
    expect(task!.status).toBe("failed");
    expect(task!.error).toMatch(error);
    expect(git(["for-each-ref", "--format=%(refname:short)", "refs/heads/"], bare).trim()).toBe("main");
  });

  it("given a scaffold already as the plugin writes it for the teammates' address, when the refresh is asked for, then nothing is proposed", async () => {
    // given: the demo seed writes the scaffold for the address its repositories are reached at
    const { ctx, bare } = await payments(null);
    ctx.memberUrls = new Map([["payments-skills", (await ctx.store.getRepo(ctx.tenant, "payments-skills"))!.url]]);

    // when
    const { task } = await refresh(ctx);

    // then
    expect(task).toMatchObject({ status: "failed", error: `The scaffold is already what TeamHandbook ${ORCHESTRATOR_RELEASE} writes; no request was opened.` });
    expect(git(["for-each-ref", "--format=%(refname:short)", "refs/heads/"], bare).trim()).toBe("main");
  });

  it("given a start that does not come through the API and no address for teammates, when the task runs, then it fails without writing a scaffold", async () => {
    // given
    const { ctx, bare } = await payments(null);
    const tasks = createTaskRunner(ctx, { agents: [fakeAgentAdapter(FAKE_AGENT)], isolation: { mode: "process", network: "open" }, testCommand: () => null, hostEnv: { PATH: process.env.PATH } });
    const repo = (await ctx.store.getRepo(ctx.tenant, "payments-skills"))!;

    // when
    const started = await tasks.start({ repo, title: "Refresh", description: "", agent: "orchestrator", user: ADMIN, template: { kind: "scaffold.refresh", commitVersioning: false } });
    await tasks.idle();

    // then
    expect(await ctx.store.getTask(ctx.tenant, started.id)).toMatchObject({
      status: "failed",
      error: "The scaffold was not refreshed: payments-skills has no memberUrl in the orchestrator's configuration, the address teammates add it by.",
    });
    expect(git(["for-each-ref", "--format=%(refname:short)", "refs/heads/"], bare).trim()).toBe("main");
  });
});
