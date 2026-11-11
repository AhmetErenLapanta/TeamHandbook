import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MiddlewareHandler } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { createUser } from "../accounts.js";
import { createApp, syncRepo } from "../app.js";
import type { OrchestratorContext } from "../app.js";
import type { OrchestratorEnv, Principal } from "../auth.js";
import { git } from "../git.js";
import { claudeArgvStandIn, copyOf, seededContext, storePrincipals } from "../test-fixtures.js";
import { claudeCodeAdapter, fakeAgentAdapter } from "./agents.js";
import type { CodeTarget } from "./config.js";
import { parseCodeTarget } from "./config.js";
import type { TaskPaths } from "./isolation.js";
import { personalEnv, personalProfileRefusal, releasePersonalGuard, writePersonalGuard } from "./profile.js";
import type { RunnerOptions } from "./runner.js";
import { createTaskRunner } from "./runner.js";

const ADMIN: Principal = { id: "a", name: "Ada Example", email: "ada@example.invalid", role: "admin", ownedTeams: [] };
/** Who creates the accounts these tests need: the organization's owner. */
const OWNER: Principal = { id: "owner", name: "Owner", email: "owner@example.invalid", role: "owner", ownedTeams: [] };
const FAKE_AGENT = join(import.meta.dirname, "..", "..", "demo", "fake-agent.mjs");

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    await releasePersonalGuard(dir);
    rmSync(dir, { recursive: true, force: true });
  }
});

const as = (user: Principal): MiddlewareHandler<OrchestratorEnv> => async (c, next) => {
  c.set("user", user);
  await next();
};

/** The seed's skills repositories beside a code repository, billing-service, that has no team file. */
async function withCode(): Promise<{ ctx: OrchestratorContext; root: string; bare: string }> {
  const { ctx, root, config } = await seededContext("orchestrator-code-target-");
  dirs.push(root);
  const { made } = await copyOf("billing-service", "billing-", async (template) => {
    const bare = join(template, "billing-service.git");
    const work = join(template, "billing-work");
    mkdirSync(bare);
    git(["init", "--bare", "--quiet", "--initial-branch=main"], bare);
    git(["init", "--quiet", "--initial-branch=main", work], template);
    writeFileSync(join(work, "README.md"), "# Billing service\n");
    git(["add", "-A"], work);
    git(["-c", "user.name=Grace Example", "-c", "user.email=grace@example.invalid", "commit", "--quiet", "-m", "init"], work);
    git(["fetch", "--quiet", work, "main:main"], bare);
    return { bare };
  }, root);
  const bare = made.bare;
  await ctx.store.upsertRepo({ id: "billing-service", team: "Payments", name: "billing-service", url: `file://${bare}`, tenant: config.tenant });
  await syncRepo(ctx, "billing-service");
  return { ctx, root, bare };
}

const BILLING: CodeTarget = { skillsFrom: "payments-skills", naming: { branchExample: "feature/rotate-certs" } };

function runner(ctx: OrchestratorContext, overrides: Partial<RunnerOptions> = {}, script = FAKE_AGENT) {
  ctx.tasks = createTaskRunner(ctx, {
    agents: [fakeAgentAdapter(script)],
    isolation: { mode: "process", network: "open" },
    testCommand: () => null,
    hostEnv: { PATH: process.env.PATH },
    codeTarget: (repo) => (repo.id === "billing-service" ? BILLING : null),
    ...overrides,
  });
  return ctx.tasks;
}

const start = (ctx: OrchestratorContext, body: Record<string, unknown>) =>
  createApp(ctx, as(ADMIN)).request("/api/tasks", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "Add a note", description: "", repoId: "billing-service", agent: "fake", ...body }) });

describe("a code repository as a task's target", () => {
  it.each([
    ["an unknown kind", { id: "x", kind: "service" }, 'repository x: kind is "skills" or "code", not "service"'],
    ["skills from a repository not configured", { id: "x", kind: "code", skillsFrom: "nowhere" }, 'repository x: skillsFrom names "nowhere", which is not a skills repository in this configuration'],
    ["skills from another code repository", { id: "x", kind: "code", skillsFrom: "y" }, 'repository x: skillsFrom names "y", which is not a skills repository in this configuration'],
    ["a prefix that would run a command", { id: "x", kind: "code", naming: { commitPrefix: 'PAY $(id)' } }, /^repository x: naming\.commitPrefix is /],
    ["naming on a skills repository", { id: "x", naming: { commitPrefix: "PAY" } }, 'repository x: skillsFrom and naming are for kind "code"; a skills repository names its own'],
  ])("given %s, when the configuration is read, then the orchestrator refuses to start", (_case, repo, error) => {
    expect(() => parseCodeTarget(repo, [{ id: "y", kind: "code" }, { id: "payments-skills" }])).toThrow(error);
  });

  it("given a code repository with no team file, when a task runs, then the agent gets the named skills repository's setup, the branch follows the configured example and no plugin version moves", async () => {
    // given
    const { ctx, bare } = await withCode();
    await storePrincipals(ctx, ADMIN);
    runner(ctx);

    // when
    const res = await start(ctx, {});
    await ctx.tasks!.idle();

    // then
    const { task } = (await res.json()) as { task: { id: string } };
    const done = (await ctx.store.getTask(ctx.tenant, task.id))!;
    expect(done.status).toBe("needs-review");
    const [request] = await ctx.store.listRequests(ctx.tenant, "billing-service");
    expect(request!.branch).toMatch(/^feature\/add-a-note-[0-9a-z]{6}$/);
    expect(git(["diff", "--name-only", "main", request!.branch], bare).trim().split("\n")).not.toContain(".claude-plugin/plugin.json");
    const log = (await ctx.store.taskLog(ctx.tenant, task.id, 0)).map((l) => l.text);
    expect(log.some((l) => /^Installed \d+ team skill\(s\) and 0 MCP server\(s\) for Demo agent from payments-skills\.$/.test(l))).toBe(true);
  });

  it("given a code repository, when a skill template is asked for, then the start is refused", async () => {
    const { ctx } = await withCode();
    runner(ctx);
    const res = await start(ctx, { title: "", template: { kind: "skill.write", skill: "on-call" } });
    expect([res.status, (await res.json()).error]).toEqual([409, "skill templates and the scaffold refresh are for skills repositories, and this is a code repository"]);
  });
});

describe("tasks that run as the orchestrator's user", () => {
  it.each([
    ["one account on this machine alone", {}, ["ada@example.invalid"], null],
    ["two accounts", {}, ["ada@example.invalid", "max@example.invalid"], "Run as me is for one person's orchestrator, and this one has 2 accounts"],
    ["an orchestrator others reach", { ORCHESTRATOR_HOST: "0.0.0.0" }, ["ada@example.invalid"], "Run as me needs an orchestrator only this machine reaches, and this one listens on 0.0.0.0"],
  ])("given %s, when the profile is asked for, then it is allowed or refused with the reason", async (_case, env, emails, refusal) => {
    const { ctx } = await withCode();
    for (const email of emails) await createUser(ctx.store, ctx.tenant, new Set(), { email, role: "admin" }, OWNER);
    expect(await personalProfileRefusal(ctx, env)).toBe(refusal);
  });

  it("given two organizations with one account each, when the profile is asked for, then it is refused, since both would run with one profile", async () => {
    const { ctx } = await withCode();
    await createUser(ctx.store, ctx.tenant, new Set(), { email: "ada@example.invalid", role: "admin" }, OWNER);
    await createUser(ctx.store, "platform", new Set(), { email: "max@example.invalid", role: "admin" }, OWNER);
    expect(await personalProfileRefusal(ctx, {})).toBeNull();
    expect(await personalProfileRefusal(ctx, {}, [ctx.tenant, "platform"])).toBe("Run as me is for one person's orchestrator, and this one has 2 accounts");
  });

  it("given a one-person orchestrator, when a task runs as its user, then the agent's home is the user's own and nothing is installed into it", async () => {
    // given: a stand-in profile, never the real one
    const { ctx, root } = await withCode();
    await storePrincipals(ctx, ADMIN);
    const profile = join(root, "profile");
    mkdirSync(profile);
    const script = join(root, "says-home.mjs");
    writeFileSync(script, `import { writeFileSync } from "node:fs";\nwriteFileSync("note.md", "x\\n");\nconsole.log(JSON.stringify({ type: "log", text: "home " + process.env.HOME }));\nconsole.log(JSON.stringify({ type: "result", summary: "Done." }));\n`);
    runner(ctx, { profile: "personal", hostEnv: { PATH: process.env.PATH, HOME: profile } }, script);

    // when
    const res = await start(ctx, {});
    await ctx.tasks!.idle();

    // then
    const { task } = (await res.json()) as { task: { id: string } };
    expect((await ctx.store.getTask(ctx.tenant, task.id))!.status).toBe("needs-review");
    const log = (await ctx.store.taskLog(ctx.tenant, task.id, 0)).map((l) => l.text);
    expect(log).toContain(`home ${profile}`);
    expect(log).toContain("Runs as you: your own Claude Code, with your skills, plugins, MCP servers and memory, plus the team's skills. Nothing is installed in your profile; MCP tools that write are closed to the agent.");
    expect(readdirSync(profile)).toEqual([]);
  });

  it("given a policy that keeps the person's own setup out of billing-service, when a task runs there as the orchestrator's user, then the log names the policy and says the run takes the sign-in and the team's skills alone", async () => {
    // given
    const { ctx, root } = await withCode();
    await storePrincipals(ctx, ADMIN);
    await ctx.store.putPolicy({ tenant: ctx.tenant, id: "pol_team_setup", name: "Billing keeps to the team's setup", audience: JSON.stringify({ kind: "workspace" }), rules: JSON.stringify([{ kind: "own-setup", allowed: false, repos: ["billing-*"] }]), updatedAt: new Date().toISOString(), updatedBy: ADMIN.email });
    const profile = join(root, "profile");
    mkdirSync(profile);
    runner(ctx, { profile: "personal", hostEnv: { PATH: process.env.PATH, HOME: profile } });

    // when
    const res = await start(ctx, {});
    await ctx.tasks!.idle();

    // then
    const { task } = (await res.json()) as { task: { id: string } };
    const log = (await ctx.store.taskLog(ctx.tenant, task.id, 0)).map((l) => l.text);
    expect(log).toContain(`Runs as you with your Claude Code sign-in alone: "Billing keeps to the team's setup" keeps the rest of your Claude Code setup out of tasks here. Nothing is installed in your profile; MCP tools that write are closed to the agent.`);
  });

  it("given a task on a checkout run as the orchestrator's user with Claude Code, when the CLI starts, then it loads the person's user settings alone, never the clone's own, under the guard layer and in a named mode", async () => {
    // given
    const { ctx, root } = await withCode();
    await storePrincipals(ctx, ADMIN);
    const profile = join(root, "profile");
    mkdirSync(profile);
    runner(ctx, { profile: "personal", hostEnv: { PATH: process.env.PATH, HOME: profile }, agents: [claudeCodeAdapter(claudeArgvStandIn(root))] });

    // when
    await start(ctx, { agent: "claude-code" });
    await ctx.tasks!.idle();

    // then
    const argv = JSON.parse(readFileSync(join(profile, "claude-argv.json"), "utf8")) as string[];
    expect(argv).not.toContain("--restricted");
    expect(argv).not.toContain("--strict-mcp-config");
    expect(argv[argv.indexOf("--setting-sources") + 1]).toBe("user");
    // Auto as the person asks about a tool off its list, so Claude Code starts in its asking mode with questions on stdio.
    expect([argv[argv.indexOf("--permission-mode") + 1], argv[argv.indexOf("--permission-prompt-tool") + 1]]).toEqual(["default", "stdio"]);
    expect(argv[argv.indexOf("--settings") + 1]).toMatch(/\/guard\/personal-settings\.json$/);
  });

  it("given an orchestrator with two accounts, when a task is started as its user, then it is refused before it waits in line", async () => {
    const { ctx } = await withCode();
    for (const email of ["ada@example.invalid", "max@example.invalid"]) await createUser(ctx.store, ctx.tenant, new Set(), { email, role: "admin" }, OWNER);
    runner(ctx, { profile: "personal", hostEnv: { PATH: process.env.PATH, HOME: "/nonexistent-profile" } });
    const res = await start(ctx, {});
    expect([res.status, (await res.json()).error]).toEqual([409, "Run as me is for one person's orchestrator, and this one has 2 accounts"]);
    expect(await ctx.store.listTasks(ctx.tenant)).toEqual([]);
  });
});

describe("how Claude Code starts when it runs as the orchestrator's user", () => {
  const paths = { root: "/task", home: "/task/home", tmp: "/task/tmp", work: "/task/work" } as TaskPaths;

  it("given Run as me in Auto, when Claude Code is started, then it connects none of the user's MCP servers, has the shell, leaves the web to the person's own rules, and keeps the team's denied tools and the guard's rules", () => {
    // when
    const call = claudeCodeAdapter("claude").invocation(paths, { title: "t", prompt: "p" }, { skills: [], mcpServers: {}, mcpTools: [{ server: "tracker", tool: "getIssue" }], deniedTools: ["Grep"] }, true);

    // then
    expect(call.env).toEqual({ CLAUDE_CODE_ENABLE_TODO_TOOLS: "true" });
    expect(call.args).toContain("--strict-mcp-config");
    expect(call.args).not.toContain("--mcp-config");
    expect(call.args[call.args.indexOf("--allowedTools") + 1]).toBe("Read,Edit,Write,Glob,Bash");
    expect(call.args[call.args.indexOf("--disallowedTools") + 1]).toBe(["Grep", ...["Edit", "Write", "NotebookEdit"].map((t) => `${t}(/${paths.home}/**)`)].join(","));
    // A team that denies the shell keeps it denied in a run as you too.
    const noShell = claudeCodeAdapter("claude").invocation(paths, { title: "t", prompt: "p" }, { skills: [], mcpServers: {}, mcpTools: [], deniedTools: ["Bash"] }, true);
    expect(noShell.args[noShell.args.indexOf("--allowedTools") + 1]).not.toContain("Bash");
    expect(noShell.args[noShell.args.indexOf("--disallowedTools") + 1]).toContain("Bash");
  });

  it("given Run as me, when the agent's environment is built, then it has the user's home and their subscription token, and none of the orchestrator's own settings", () => {
    // when
    const env = personalEnv({ PATH: "/usr/bin", HOME: "/home/ada", USER: "ada", CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-stand-in", ORCHESTRATOR_SECRET_KEY: "x", ORCHESTRATOR_DATABASE_URL: "postgres://c" }, paths, ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"]);

    // then
    expect(env).toMatchObject({ HOME: "/home/ada", USER: "ada", CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-stand-in", TMPDIR: "/task/tmp" });
    expect(Object.keys(env).filter((k) => k.startsWith("ORCHESTRATOR_") || k.startsWith("XDG_"))).toEqual([]);
  });
});

describe("the user's MCP tools that write, under Run as me", () => {
  it("given Run as me, when Claude Code is started on the prompt alone or as a conversation, then it gets the person's sign-in alone: none of their settings, hooks, plugins or MCP servers, and the orchestrator's guard from the task's directory", () => {
    // given
    const paths = { root: "/task", home: "/task/home", tmp: "/task/tmp", work: "/task/work" } as TaskPaths;
    const adapter = claudeCodeAdapter("claude");

    // when
    const runs = [
      adapter.invocation(paths, { title: "t", prompt: "p" }, { skills: [], mcpServers: {}, mcpTools: [] }, true).args,
      adapter.twoWay!.launch(paths, { skills: [], mcpServers: {}, mcpTools: [] }, { mode: "approval-required", personal: true }).call.args,
    ];

    // then
    for (const args of runs) {
      expect(args).toEqual(expect.arrayContaining(["--restricted", "--strict-mcp-config"]));
      expect(args).not.toContain("--setting-sources");
      expect(args).not.toContain("--mcp-config");
      expect(args[args.indexOf("--settings") + 1]).toBe("/task/guard/personal-settings.json");
    }
  });

  it("given the guard written for a task, when the agent calls the user's forge and tracker tools, then the tracker's and the forge's that write and a call it cannot read are denied, and the rest are left to the person's own rules and the task's mode", async () => {
    // given
    const home = mkdtempSync(join(tmpdir(), "orchestrator-personal-guard-"));
    dirs.push(home);
    mkdirSync(join(home, "work"));
    const settings = JSON.parse(readFileSync(await writePersonalGuard({ root: home, work: join(home, "work") }), "utf8"));
    const hook = settings.hooks.PreToolUse[0];
    const decide = (input: string) => {
      const run = spawnSync("/bin/sh", ["-c", hook.hooks[0].command], { input, encoding: "utf8" });
      return run.stdout ? JSON.parse(run.stdout).hookSpecificOutput.permissionDecision : "allow";
    };
    const call = (tool_name: string) => decide(JSON.stringify({ hook_event_name: "PreToolUse", tool_name, tool_input: {} }));

    // when
    const decided = Object.fromEntries(
      [
        "mcp__gitlab__merge_merge_request",
        "mcp__plugin_team-skills_gitlab__create_note",
        "mcp__atlassian__addCommentToJiraIssue",
        "mcp__gitlab__save_merge_request",
        "mcp__gitlab__lists_delete",
        "mcp__tracker__views_create",
        "mcp__gitlab__delete__get_project",
        "mcp__gitlab",
        "mcp__gitlab__get_merge_request",
        "mcp__atlassian__searchJiraIssues",
        "mcp__gitlab__list_pipelines",
        "mcp__team__docs__get_page",
      ].map((t) => [t, call(t)]),
    );

    // then
    expect(hook.matcher).toBe("mcp__.*|Edit|Write|MultiEdit|NotebookEdit");
    expect(decided).toEqual({
      mcp__gitlab__merge_merge_request: "deny",
      "mcp__plugin_team-skills_gitlab__create_note": "deny",
      mcp__atlassian__addCommentToJiraIssue: "deny",
      mcp__gitlab__save_merge_request: "deny",
      mcp__gitlab__lists_delete: "deny",
      mcp__tracker__views_create: "deny",
      mcp__gitlab__delete__get_project: "deny",
      mcp__gitlab: "allow",
      mcp__gitlab__get_merge_request: "allow",
      mcp__atlassian__searchJiraIssues: "allow",
      mcp__gitlab__list_pipelines: "allow",
      mcp__team__docs__get_page: "allow",
    });
    expect([decide("not json"), decide(JSON.stringify({ tool_name: 7 })), decide("")]).toEqual(["deny", "deny", "deny"]);
  });

  it("given the guard written for a task, when the agent writes inside its folder, outside it, through a link that leads out, with a .. or into a .git, then only the write inside goes ahead, and the person's sign-ins are not read", async () => {
    // given
    const home = mkdtempSync(join(tmpdir(), "orchestrator-personal-guard-"));
    dirs.push(home);
    const work = join(home, "work");
    mkdirSync(join(work, "docs"), { recursive: true });
    mkdirSync(join(home, "elsewhere"));
    symlinkSync(join(home, "elsewhere"), join(work, "out"));
    const settings = JSON.parse(readFileSync(await writePersonalGuard({ root: home, work }), "utf8"));
    const command = settings.hooks.PreToolUse[0].hooks[0].command;
    const write = (tool_name: string, tool_input: Record<string, unknown>) => {
      const run = spawnSync("/bin/sh", ["-c", command], { input: JSON.stringify({ hook_event_name: "PreToolUse", tool_name, tool_input, cwd: work }), encoding: "utf8" });
      return run.stdout ? JSON.parse(run.stdout).hookSpecificOutput.permissionDecision : "allow";
    };

    // when
    const decided = [
      write("Write", { file_path: join(work, "docs", "new-note.md") }),
      write("Edit", { file_path: "README.md" }),
      write("Write", { file_path: join(home, "elsewhere", "note.md") }),
      write("Write", { file_path: join(work, "out", "note.md") }),
      write("Edit", { file_path: `${work}/docs/../README.md` }),
      write("NotebookEdit", { notebook_path: join(home, "notebook.ipynb") }),
      write("Write", {}),
      write("Write", { file_path: join(work, ".git", "config") }),
      write("Write", { file_path: join(work, "docs", ".git", "hooks", "pre-commit") }),
      write("Write", { file_path: join(work, ".GIT", "config") }),
    ];

    // then
    expect(decided).toEqual(["allow", "allow", "deny", "deny", "deny", "deny", "deny", "deny", "deny", "deny"]);
    expect(settings.permissions.deny).toEqual(expect.arrayContaining(["Read(~/.ssh/**)", "Read(~/.aws/**)", "Read(~/.config/gh/**)", "Read(~/.config/glab-cli/**)", "Read(~/.netrc)", "Read(~/.claude/**)"]));
  });
});
