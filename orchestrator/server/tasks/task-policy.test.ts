import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { seed } from "../../demo/seed.js";
import { syncRepo } from "../app.js";
import type { OrchestratorContext } from "../app.js";
import type { Principal } from "../auth.js";
import { localRepoPath } from "../forge/local.js";
import { git } from "../git.js";
import type { PolicyRule } from "../plugin.js";
import { openSqliteStore } from "../store.js";
import { storePrincipals } from "../test-fixtures.js";
import { claudeCodeAdapter, fakeAgentAdapter } from "./agents.js";
import type { TaskPaths } from "./isolation.js";
import { createTaskRunner } from "./runner.js";
import { shadowSnapshot } from "../shadow-git.js";
import type { ShadowPlace } from "../shadow-git.js";
import { narrowSetup, refusedInPlace } from "./task-policy.js";

const ADMIN: Principal = { id: "a", name: "Ada Example", email: "ada@example.invalid", role: "admin", ownedTeams: [] };
const deny = (action: PolicyRule["action"], resource: string, reason = "retired"): PolicyRule => ({ action, resource, effect: "deny", reason });

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("the team's setup a task's agent is given under the team's policies", () => {
  const team = { skills: [{ slug: "release-checklist", files: [] }, { slug: "on-call", files: [] }], mcpServers: {}, refused: [] };
  const allowed = [{ server: "tracker", tool: "deleteIssue" }, { server: "tracker", tool: "getIssue" }];

  it("given rules on a skill, an MCP tool, a whole file tool and some paths of reading, when the setup is narrowed, then each is left out or named as not held", () => {
    // when
    const narrowed = narrowSetup([deny("skill.use", "skill:release-*"), deny("mcp.use", "mcp:tracker/deleteIssue"), deny("tool.use", "tool:Grep:*"), deny("tool.use", "tool:Read:*.pem")], team, allowed);

    // then
    expect(narrowed.team.skills.map((s) => s.slug)).toEqual(["on-call"]);
    expect(narrowed.allowed).toEqual([{ server: "tracker", tool: "getIssue" }]);
    expect(narrowed.deniedTools).toEqual(["Grep"]);
    expect(narrowed.notes).toEqual([
      "Left out by the team's policies, skills: release-checklist.",
      "Left out by the team's policies, MCP tools: tracker/deleteIssue.",
      "Left out by the team's policies, tools: Grep.",
      "Not held in a task, the agent reads its own checkout: tool:Read:*.pem.",
    ]);
  });

  it("given a file tool denied whole, when Claude Code is started, then the tool is neither allowed nor left undenied", () => {
    // given
    const paths = { root: "/task", home: "/task/home", work: "/task/work" } as TaskPaths;

    // when
    const { args } = claudeCodeAdapter("claude").invocation(paths, { title: "t", prompt: "p" }, { skills: [], mcpServers: {}, mcpTools: [], deniedTools: ["Edit"] });

    // then
    expect(args[args.indexOf("--allowedTools") + 1]).toBe("Read,Write,Glob,Grep");
    expect(args[args.indexOf("--disallowedTools") + 1]).toBe("Bash,WebFetch,WebSearch,Edit,Edit(//task/home/**),Write(//task/home/**),NotebookEdit(//task/home/**)");
  });
});

/** The seeded Payments repository with `policies` in its team file, on main. */
async function payments(policies: unknown): Promise<{ ctx: OrchestratorContext; root: string }> {
  const root = mkdtempSync(join(tmpdir(), "orchestrator-task-policy-"));
  dirs.push(root);
  const { configFile } = seed(join(root, "demo"));
  const config = JSON.parse(readFileSync(configFile, "utf8"));
  const entry = config.repos.find((r: { id: string }) => r.id === "payments-skills");
  const ctx: OrchestratorContext = { store: openSqliteStore(":memory:"), dataDir: join(root, "data"), tenant: config.tenant };
  await storePrincipals(ctx, ADMIN);
  await ctx.store.upsertRepo({ ...entry, tenant: config.tenant });
  const bare = localRepoPath(entry.url)!;
  const work = mkdtempSync(join(root, "work-"));
  git(["clone", "--quiet", bare, work], work);
  const file = join(work, ".teamhandbook.json");
  writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), policies }, null, 2) + "\n");
  git(["-c", "user.name=Grace Example", "-c", "user.email=grace@example.invalid", "commit", "--quiet", "-am", "chore: set the team's policies"], work);
  git(["fetch", "--quiet", work, "main:main"], bare);
  await syncRepo(ctx, "payments-skills");
  return { ctx, root };
}

async function run(ctx: OrchestratorContext, root: string) {
  const script = join(root, "writes-env.mjs");
  writeFileSync(script, `import { writeFileSync } from "node:fs";\nwriteFileSync("deploy.env", "REGION=eu\\n");\nconsole.log(JSON.stringify({ type: "result", summary: "Done." }));\n`);
  const tasks = createTaskRunner(ctx, { agents: [fakeAgentAdapter(script)], isolation: { mode: "process", network: "open" }, testCommand: () => null, hostEnv: { PATH: process.env.PATH } });
  const repo = (await ctx.store.getRepo(ctx.tenant, "payments-skills"))!;
  const started = await tasks.start({ repo, title: "Set the region", description: "", agent: "fake", user: ADMIN });
  await tasks.idle();
  return (await ctx.store.getTask(ctx.tenant, started.id))!;
}

describe("a task in a repository whose team holds policies", () => {
  it("given a rule against editing env files, when the agent writes one, then no request opens and the team's reason is given", async () => {
    // given
    const { ctx, root } = await payments([{ id: "pol_env", name: "Keep env files", rules: [deny("tool.use", "tool:Edit:*.env", "env files are set by the platform team")] }]);

    // when
    const task = await run(ctx, root);

    // then
    expect(task).toMatchObject({ status: "failed", error: "The agent changed deploy.env, which the team's policy keeps from being edited: env files are set by the platform team. No request was opened." });
    expect(await ctx.store.listRequests(ctx.tenant)).toEqual([]);
  });

  it("given policies a teammate's plugin would not read, when the task starts, then it does not run", async () => {
    // given
    const { ctx, root } = await payments([{ id: "pol_x", name: "Open", rules: [{ action: "tool.use", resource: "tool:Bash:*", effect: "allow", reason: "x" }] }]);

    // when
    const task = await run(ctx, root);

    // then
    expect(task.status).toBe("failed");
    expect(task.error).toMatch(/^The task did not run: the team's policies cannot be read \(policy 1 \(pol_x\): rule 1: its effect is not "deny"/);
  });
});

describe("the team's policy on a change made in place", () => {
  it("given a folder recorded before and after an edit to a file the policy keeps, when the policy is held to the change, then the edit is taken back and the failure says which file, why and that it was undone; a change the policy allows is left as it is", async () => {
    // given
    const root = realpathSync(mkdtempSync(join(tmpdir(), "policy-in-place-")));
    try {
      const home = join(root, "home");
      const place: ShadowPlace = { gitDir: join(root, "data", "shadow"), folder: join(home, "notes"), where: { home, dataDir: join(root, "data") } };
      mkdirSync(place.folder, { recursive: true });
      writeFileSync(join(place.folder, "README.md"), "Notes.\n");
      const before = await shadowSnapshot(place, "before");
      writeFileSync(join(place.folder, "deploy.env"), "REGION=eu\n");
      const after = await shadowSnapshot(place, "after");
      if ("refused" in before || "refused" in after) throw new Error("the folder was not recorded");
      const rules = [deny("tool.use", "tool:Edit:*.env", "env files are set by the platform team")];

      // when
      const allowed = await refusedInPlace(rules, ["README.md"], place, before.sha, after.sha);
      const refused = await refusedInPlace(rules, ["deploy.env"], place, before.sha, after.sha);

      // then
      expect(allowed).toBeNull();
      expect(refused).toEqual({ failed: "The agent changed deploy.env, which the team's policy keeps from being edited: env files are set by the platform team. Its change was undone.", undone: { kept: [] } });
      expect(existsSync(join(place.folder, "deploy.env"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
