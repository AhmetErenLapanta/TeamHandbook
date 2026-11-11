import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { seed } from "../../demo/seed.js";
import { syncRepo } from "../app.js";
import type { OrchestratorContext } from "../app.js";
import type { Principal } from "../auth.js";
import { localDescriptionRef, localRepoPath } from "../forge/local.js";
import { git } from "../git.js";
import { openSqliteStore } from "../store.js";
import { storePrincipals } from "../test-fixtures.js";
import { fakeAgentAdapter } from "./agents.js";
import { createTaskRunner } from "./runner.js";
import type { TaskRunner } from "./runner.js";

const ADMIN: Principal = { id: "a", name: "Ada Example", email: "ada@example.invalid", role: "admin", ownedTeams: [] };
const FAKE_AGENT = join(import.meta.dirname, "..", "..", "demo", "fake-agent.mjs");
const MANIFEST = ".claude-plugin/plugin.json";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** The seeded Payments repository, its plugin's version line set to `version` (or removed for null) on main. */
async function payments(version: string | null): Promise<{ ctx: OrchestratorContext; bare: string; root: string }> {
  const root = mkdtempSync(join(tmpdir(), "orchestrator-task-versions-"));
  dirs.push(root);
  const { configFile } = seed(join(root, "demo"));
  const config = JSON.parse(readFileSync(configFile, "utf8"));
  const ctx: OrchestratorContext = { store: openSqliteStore(":memory:"), dataDir: join(root, "data"), tenant: config.tenant };
  await storePrincipals(ctx, ADMIN);
  const entry = config.repos.find((r: { id: string }) => r.id === "payments-skills");
  await ctx.store.upsertRepo({ ...entry, tenant: config.tenant });
  const bare = localRepoPath(entry.url)!;
  commitManifest(bare, root, "main", "main", version);
  await syncRepo(ctx, "payments-skills");
  return { ctx, bare, root };
}

/** Writes the manifest's version on `branch`, starting from `from`, the way a teammate's push would. */
function commitManifest(bare: string, root: string, from: string, branch: string, version: string | null): void {
  const work = mkdtempSync(join(root, "work-"));
  git(["clone", "--quiet", "--branch", from, bare, work], work);
  const file = join(work, MANIFEST);
  const { version: _old, ...rest } = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  writeFileSync(file, JSON.stringify(version === null ? rest : { ...rest, version }, null, 2) + "\n");
  git(["-c", "user.name=Grace Example", "-c", "user.email=grace@example.invalid", "commit", "--allow-empty", "-qam", `chore: version ${version}`], work);
  git(["fetch", "--quiet", work, `HEAD:refs/heads/${branch}`], bare);
}

/** An agent that sets the manifest's version to `version` (leaving the rest), and adds a note. */
function settingVersion(root: string, version: string | null): string {
  const file = join(root, `set-version-${version}.mjs`);
  writeFileSync(
    file,
    `import { readFileSync, writeFileSync } from "node:fs";\nconst m = JSON.parse(readFileSync("${MANIFEST}", "utf8"));\n${version === null ? "m.description = 'changed';" : `m.version = ${JSON.stringify(version)};`}\nwriteFileSync("${MANIFEST}", JSON.stringify(m, null, 2) + "\\n");\nwriteFileSync("note.md", "x\\n");\nconsole.log(JSON.stringify({ type: "result", summary: "Done." }));\n`,
  );
  return file;
}

async function runOne(ctx: OrchestratorContext, tasks: TaskRunner, title: string) {
  const repo = (await ctx.store.getRepo(ctx.tenant, "payments-skills"))!;
  const started = await tasks.start({ repo, title, description: "", agent: "fake", user: ADMIN });
  await tasks.idle();
  const task = (await ctx.store.getTask(ctx.tenant, started.id))!;
  const log = (await ctx.store.taskLog(ctx.tenant, started.id, 0)).map((l) => l.text);
  return { task, log };
}

function requestOf(bare: string, branch: string) {
  const version = (JSON.parse(git(["show", `${branch}:${MANIFEST}`], bare)) as { version?: string }).version ?? null;
  const description = git(["notes", "--ref", localDescriptionRef(branch), "show", branch], bare);
  const touched = git(["diff", "--name-only", `${branch}^`, branch], bare).trim().split("\n");
  return { version, description, touched };
}

const runner = (ctx: OrchestratorContext, agent = FAKE_AGENT) =>
  createTaskRunner(ctx, { agents: [fakeAgentAdapter(agent)], isolation: { mode: "process", network: "open" }, testCommand: () => null, hostEnv: { PATH: process.env.PATH } });

describe("the plugin version a task's request carries", () => {
  it("given a versioned plugin and two tasks one after the other, when each request opens, then each raises the version past the last, says so, and touches the manifest besides the agent's change", async () => {
    // given
    const { ctx, bare } = await payments("0.1.5");
    const tasks = runner(ctx);

    // when
    const first = await runOne(ctx, tasks, "Add an on-call handover");
    const second = await runOne(ctx, tasks, "Add a release checklist");

    // then
    const one = requestOf(bare, `task/${first.task.id}`);
    const two = requestOf(bare, `task/${second.task.id}`);
    expect([one.version, two.version]).toEqual(["0.1.6", "0.1.7"]);
    expect(one.touched).toEqual([MANIFEST, "skills/add-an-on-call-handover/SKILL.md"]);
    expect(one.description).toContain("Raises the plugin to version 0.1.6, so teammates fetch it once this is merged.");
    expect(two.description).toContain(`Raises the plugin to version 0.1.7, past 0.1.6 on task/${first.task.id}, which is not merged yet, so teammates fetch it once this is merged.`);
    expect(first.log).toContain("Raises the plugin to version 0.1.6, so teammates fetch it once this is merged.");
    expect(one.description).not.toContain("## Look at these before merging");
  });

  it("given a plugin versioned by commit, when a task's request opens, then the manifest is not touched and nothing is said about a version", async () => {
    // given
    const { ctx, bare } = await payments(null);

    // when
    const { task } = await runOne(ctx, runner(ctx), "Add an on-call handover");

    // then
    const request = requestOf(bare, `task/${task.id}`);
    expect(request.touched).toEqual(["skills/add-an-on-call-handover/SKILL.md"]);
    expect(request.description).not.toContain("Raises the plugin");
  });

  it("given an agent that changes the manifest but not its version, when the request opens, then the line stays as the agent left it, and the log and the request say this reaches nobody until it is raised", async () => {
    // given
    const { ctx, bare, root } = await payments("0.1.5");

    // when
    const { task, log } = await runOne(ctx, runner(ctx, settingVersion(root, null)), "Describe the plugin");

    // then
    expect(task.status).toBe("needs-review");
    const request = requestOf(bare, `task/${task.id}`);
    expect(request.version).toBe("0.1.5");
    const warning = `${MANIFEST} leaves the version at 0.1.5; teammates fetch the plugin again only past 0.1.6, so set it to that before merging or this change reaches nobody.`;
    expect(log).toContain(`The agent changed ${MANIFEST}, so its version line is left as the agent wrote it (0.1.5).`);
    expect(log).toContain(`Look at this before merging: ${warning}`);
    expect(request.description).toContain(`- ${warning}`);
    expect(request.description).not.toContain("Raises the plugin");
  });

  it("given an agent that raises the version itself far enough, when the request opens, then its number stands and no warning is added about it", async () => {
    // given
    const { ctx, bare, root } = await payments("0.1.5");

    // when
    const { task, log } = await runOne(ctx, runner(ctx, settingVersion(root, "0.2.0")), "Raise the minor version");

    // then
    expect(requestOf(bare, `task/${task.id}`).version).toBe("0.2.0");
    expect(log).toContain(`The agent changed ${MANIFEST}, so its version line is left as the agent wrote it (0.2.0).`);
    expect(log.filter((line) => line.includes("leaves the version"))).toEqual([]);
  });
});
