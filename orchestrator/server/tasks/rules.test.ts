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

const ADMIN: Principal = { id: "a", name: "Ada Example", email: "ada@example.invalid", role: "admin", ownedTeams: [] };
// A command under one person's home: the share rule refuses it as a trace of one machine,
// and no secret pattern sees it, so it reaches the rule rather than the scan before it.
const MACHINE_PATH = "/home/grace/bin/warehouse-mcp";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function seeded(): Promise<{ ctx: OrchestratorContext; root: string }> {
  const root = mkdtempSync(join(tmpdir(), "orchestrator-rules-"));
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

/** An agent that writes the given files into its checkout and reports success. */
function writing(root: string, files: Record<string, string>): string {
  const file = join(root, `agent-${Object.keys(files).length}-${Date.now()}.mjs`);
  writeFileSync(
    file,
    `import { mkdirSync, writeFileSync } from "node:fs";\nimport { dirname } from "node:path";\nfor (const [path, content] of Object.entries(${JSON.stringify(files)})) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content); }\nconsole.log(JSON.stringify({ type: "result", summary: "Done." }));\n`,
  );
  return file;
}

async function runWith(ctx: OrchestratorContext, agent: string) {
  const tasks = createTaskRunner(ctx, { agents: [fakeAgentAdapter(agent)], isolation: { mode: "process", network: "open" }, testCommand: () => null, hostEnv: { PATH: process.env.PATH } });
  const repo = (await ctx.store.getRepo(ctx.tenant, "payments-skills"))!;
  const started = await tasks.start({ repo, title: "Change the team's setup", description: "", agent: "fake", user: ADMIN });
  await tasks.idle();
  const task = (await ctx.store.getTask(ctx.tenant, started.id))!;
  const log = (await ctx.store.taskLog(ctx.tenant, started.id, 0)).map((l) => l.text);
  const bare = localRepoPath(repo.url)!;
  const [request] = await ctx.store.listRequests(ctx.tenant, repo.id);
  const description = request ? git(["notes", "--ref", localDescriptionRef(request.branch), "show", request.branch], bare) : null;
  const branches = git(["for-each-ref", "--format=%(refname:short)", "refs/heads/"], bare).trim().split("\n").filter((b) => b !== "main");
  return { task, log, description, branches };
}

const mcpWith = (root: string, ctx: OrchestratorContext, servers: Record<string, unknown>) => {
  const bare = localRepoPath(`file://${join(root, "demo", "repos", "payments-skills.git")}`)!;
  const current = JSON.parse(git(["show", "main:.mcp.json"], bare));
  return JSON.stringify({ ...current, mcpServers: { ...current.mcpServers, ...servers } }, null, 2) + "\n";
};

describe("a task's result held to the plugin's rules", () => {
  it.each([
    ["a SKILL.md with no frontmatter", { "skills/on-call/SKILL.md": "Just some notes.\n" }, "The agent's skills/on-call/SKILL.md cannot travel: SKILL.md needs frontmatter with a name and a description; no request was opened."],
    [
      "a SKILL.md whose name is not its folder's",
      { "skills/on-call/SKILL.md": "---\nname: oncall\ndescription: Use when handing over on-call.\n---\n\nSteps.\n" },
      `The agent's skills/on-call/SKILL.md cannot travel: the frontmatter name is "oncall"; it has to match the skill's folder, on-call; no request was opened.`,
    ],
    [
      "a SKILL.md that names itself twice",
      { "skills/on-call/SKILL.md": "---\nname: on-call\nname: other\ndescription: Use when handing over on-call.\n---\n\nSteps.\n" },
      "The agent's skills/on-call/SKILL.md cannot travel: the frontmatter names the skill more than once; no request was opened.",
    ],
    [
      "a skill in a folder the plugin does not read",
      { "skills/On_Call/SKILL.md": "---\nname: On_Call\ndescription: Use when handing over on-call.\n---\n\nSteps.\n" },
      "The agent wrote a skill in skills/On_Call, a folder name the plugin does not read (lower-case letters, digits and dashes); no request was opened.",
    ],
    ["a .mcp.json that is not JSON", { ".mcp.json": "{ not json" }, "The agent left .mcp.json as something other than a JSON object with an mcpServers object; no request was opened."],
  ])("given an agent that leaves %s, when the task ends, then it fails with the rule it broke and nothing reaches the team repository", async (_case, files, error) => {
    // given
    const { ctx, root } = await seeded();

    // when
    const { task, branches } = await runWith(ctx, writing(root, files));

    // then
    expect(task).toMatchObject({ status: "failed", error, requestNumber: null });
    expect(branches).toEqual([]);
  });

  it("given an agent that adds an MCP server the share rule refuses, when the task ends, then it fails with the rule's reason and the refused value is nowhere", async () => {
    // given
    const { ctx, root } = await seeded();
    const agent = writing(root, { ".mcp.json": mcpWith(root, ctx, { warehouse: { command: MACHINE_PATH } }) });

    // when
    const { task, log, branches } = await runWith(ctx, agent);

    // then
    expect(task.status).toBe("failed");
    expect(task.error).toMatch(/^The agent's change to \.mcp\.json cannot travel: warehouse is not shareable as written: its command carries a trace of one machine/);
    expect(JSON.stringify([task.error, log])).not.toContain(MACHINE_PATH);
    expect(branches).toEqual([]);
  });

  it("given a team repository that already holds a server the share rule refuses, when an agent adds a shareable one beside it, then only the agent's server is held to the rule and the request opens", async () => {
    // given
    const { ctx, root } = await seeded();
    const repo = (await ctx.store.getRepo(ctx.tenant, "payments-skills"))!;
    const bare = localRepoPath(repo.url)!;
    const work = join(root, "edit");
    git(["clone", "--quiet", bare, work], root);
    const mcp = JSON.parse(readFileSync(join(work, ".mcp.json"), "utf8"));
    mcp.mcpServers.vault = { command: MACHINE_PATH };
    writeFileSync(join(work, ".mcp.json"), JSON.stringify(mcp, null, 2));
    git(["-c", "user.name=Grace Example", "-c", "user.email=grace@example.invalid", "commit", "--quiet", "-am", "feat(mcp): add vault"], work);
    git(["fetch", "--quiet", work, "main:main"], bare);
    await syncRepo(ctx, repo.id);
    const agent = writing(root, { ".mcp.json": mcpWith(root, ctx, { search: { type: "http", url: "https://search.example.com/mcp" } }) });

    // when
    const { task } = await runWith(ctx, agent);

    // then
    expect(task).toMatchObject({ status: "needs-review", requestNumber: 1 });
  });

  it("given an agent that adds a server that starts a command, changes a hook and the CI, and touches the team's settings, when the request opens, then each is named first in the request and in the log", async () => {
    // given
    const { ctx, root } = await seeded();
    const agent = writing(root, {
      ".mcp.json": mcpWith(root, ctx, { lint: { command: "npx", args: ["-y", "lint-mcp"] } }),
      "hooks/notice.mjs": "console.log('changed');\n",
      ".github/workflows/ci.yml": "on: push\n",
      ".teamhandbook.json": '{ "commitPrefix": "PAY" }\n',
      "skills/on-call/SKILL.md": "---\nname: on-call\ndescription: Use when handing over on-call.\n---\n\nSteps.\n",
    });

    // when
    const { task, log, description } = await runWith(ctx, agent);

    // then
    expect(task.status).toBe("needs-review");
    const warnings = [
      ".mcp.json adds the server lint, which starts a command on every teammate's machine.",
      ".teamhandbook.json is changed: the team's settings: commit prefix, branch naming, reviewers, labels and where skill use is reported.",
      ".github/workflows/ci.yml is changed: the team's CI runs it, with whatever the CI holds.",
      "hooks/notice.mjs is changed: a hook runs on every teammate's machine at the event it names.",
    ];
    for (const warning of warnings) {
      expect(log).toContain(`Look at this before merging: ${warning}`);
      expect(description).toContain(`- ${warning}`);
    }
    expect(description!.indexOf("## Look at these before merging")).toBeLessThan(description!.indexOf("## Task"));
    expect(description!.indexOf("## Look at these before merging")).toBeLessThan(description!.indexOf("## The agent's report"));
  });

  it("given an agent that only adds a skill the plugin reads, when the request opens, then it carries no warning", async () => {
    // given
    const { ctx, root } = await seeded();

    // when
    const { task, log, description } = await runWith(ctx, writing(root, { "skills/on-call/SKILL.md": "---\nname: on-call\ndescription: Use when handing over on-call.\n---\n\nSteps.\n" }));

    // then
    expect(task.status).toBe("needs-review");
    expect(log.filter((line) => line.startsWith("Look at this"))).toEqual([]);
    expect(description).not.toContain("## Look at these before merging");
  });
});
