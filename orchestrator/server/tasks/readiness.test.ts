import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { MiddlewareHandler } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { createUser } from "../accounts.js";
import { createApp, syncRepo } from "../app.js";
import type { OrchestratorContext } from "../app.js";
import type { OrchestratorEnv, Principal } from "../auth.js";
import { localRepoPath } from "../forge/local.js";
import { git } from "../git.js";
import { seededContext } from "../test-fixtures.js";
import { claudeCodeAdapter, fakeAgentAdapter, opencodeAdapter } from "./agents.js";
import { taskOptionsFromEnv } from "./config.js";
import type { AgentAdapter } from "./agents.js";
import type { IsolationConfig } from "./isolation.js";
import type { Readiness } from "./readiness.js";
import { createTaskRunner } from "./runner.js";
import type { RunnerOptions } from "./runner.js";

const ADMIN: Principal = { id: "a", name: "Ada Example", email: "ada@example.invalid", role: "admin", ownedTeams: [] };
const PAYMENTS_OWNER: Principal = { id: "o", name: "Olu Example", email: "olu@example.invalid", role: "member", ownedTeams: ["Payments"] };
const KEY = "sk-ant-api03-readiness-test-key-0123456789";
const FAKE_AGENT = join(import.meta.dirname, "..", "..", "demo", "fake-agent.mjs");

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

async function seeded(): Promise<{ ctx: OrchestratorContext; root: string; bin: string }> {
  const { ctx, root } = await seededContext("orchestrator-readiness-");
  dirs.push(root);
  const bin = join(root, "bin");
  mkdirSync(bin);
  return { ctx, root, bin };
}

/** A stand-in CLI: a shell script that answers `--version` and the status command, and nothing else. */
function fakeCli(bin: string, name: string, version: string, status: string): void {
  const file = join(bin, name);
  writeFileSync(file, `#!/bin/sh\ncase "$1" in\n  --version) echo "${version}" ;;\n  auth) ${status} ;;\n  *) echo "a check asked for $*" >&2; exit 2 ;;\nesac\n`);
  chmodSync(file, 0o755);
}

const say = (json: Record<string, unknown>) => `echo '${JSON.stringify(json)}'`;

// Only the fake directory and the system's own: no agent CLI installed on this machine is on it.
const hostEnv = (bin: string, extra: Record<string, string> = {}) => ({ PATH: `${bin}:/usr/bin:/bin`, ANTHROPIC_API_KEY: KEY, ...extra });

function runnerWith(ctx: OrchestratorContext, agents: AgentAdapter[], env: Record<string, string | undefined>, overrides: Partial<RunnerOptions> = {}) {
  ctx.tasks = createTaskRunner(ctx, { agents, isolation: { mode: "process", network: "open" }, testCommand: () => null, hostEnv: env, ...overrides });
  return ctx.tasks;
}

async function readinessOf(ctx: OrchestratorContext, fresh = false): Promise<{ status: number; body: Readiness; text: string }> {
  const res = await createApp(ctx, as(ADMIN)).request(`/api/agents/readiness${fresh ? "?fresh=1" : ""}`);
  const text = await res.text();
  return { status: res.status, body: JSON.parse(text), text };
}

const checksOf = (body: Readiness, id: string) => Object.fromEntries(body.agents.find((a) => a.id === id)!.checks.map((c) => [c.name, c]));

describe("whether an agent is ready before its first task", () => {
  it.each([
    ["missing", null, null, false, { Program: "fail", "Sign-in": "unknown" }],
    ["an older version", "2.0.14 (Claude Code)", say({ loggedIn: true, authMethod: "claude.ai" }), true, { Program: "ok", Version: "warn", Credential: "ok", "Sign-in": "ok" }],
    ["a newer minor version", "2.2.0 (Claude Code)", say({ loggedIn: true, authMethod: "claude.ai" }), true, { Program: "ok", Version: "warn", Credential: "ok", "Sign-in": "ok" }],
    ["a newer patch of the checked version", "2.1.318 (Claude Code)", say({ loggedIn: true, authMethod: "claude.ai" }), true, { Program: "ok", Version: "ok", Credential: "ok", "Sign-in": "ok" }],
    ["not signed in", "2.1.309 (Claude Code)", say({ loggedIn: false, authMethod: "none" }), false, { Program: "ok", Version: "ok", "Sign-in": "fail" }],
    ["ready", "2.1.309 (Claude Code)", say({ loggedIn: true, authMethod: "claude.ai", email: "ada@corp.example.invalid", orgName: "Acme Payments" }), true, { Program: "ok", Version: "ok", Credential: "ok", "Sign-in": "ok" }],
  ])("given a Claude Code CLI that is %s, when an admin asks, then the checks say so and readiness follows the failures alone", async (_case, version, status, ready, expected) => {
    // given
    const { ctx, bin } = await seeded();
    if (version) fakeCli(bin, "claude", version, status!);
    runnerWith(ctx, [claudeCodeAdapter("claude")], hostEnv(bin));

    // when
    const { status: code, body, text } = await readinessOf(ctx);

    // then
    expect(code).toBe(200);
    const checks = checksOf(body, "claude-code");
    expect(Object.fromEntries(Object.keys(expected).map((name) => [name, checks[name]?.status]))).toEqual(expected);
    expect(body.agents[0]!.ready).toBe(ready);
    if (!version) expect(checks.Program!.detail).toBe("claude is not on the orchestrator's PATH; install it, or name it with ORCHESTRATOR_CLAUDE_BIN");
    if (version?.startsWith("2.0")) expect(checks.Version!.detail).toBe("2.0.14 is older than 2.1.309, the version the orchestrator was checked with. Update the CLI to 2.1.309.");
    if (version?.startsWith("2.2.0")) expect(checks.Version!.detail).toBe("2.2.0 is newer than 2.1.309, the version the orchestrator was checked with. If a task fails on a changed flag or output, install 2.1.309.");
    if (version?.startsWith("2.1.318")) expect(checks.Version!.detail).toBe("2.1.318, a newer patch of 2.1.309, the version the orchestrator was checked with");
    expect(text).not.toContain("ada@corp.example.invalid");
    expect(text).not.toContain("Acme Payments");
    expect(text).not.toContain(KEY);
  });

  it.each([
    ["one account", ["ada@example.invalid"], undefined],
    ["two accounts", ["ada@example.invalid", "max@example.invalid"], "warn"],
  ])("given a subscription token and %s, when an admin asks, then an orchestrator several people share is warned off it", async (_case, emails, expected) => {
    // given
    const { ctx, bin } = await seeded();
    fakeCli(bin, "claude", "2.1.309 (Claude Code)", say({ loggedIn: true, authMethod: "oauth_token" }));
    const owner = { id: "owner", name: "Owner", email: "owner@example.invalid", role: "owner" as const, ownedTeams: [] };
    for (const email of emails) await createUser(ctx.store, ctx.tenant, new Set(), { email, role: "member" }, owner);
    runnerWith(ctx, [claudeCodeAdapter("claude")], { PATH: `${bin}:/usr/bin:/bin`, CLAUDE_CODE_OAUTH_TOKEN: KEY });

    // when
    const checks = checksOf((await readinessOf(ctx)).body, "claude-code");

    // then
    expect(checks["Credential kind"]?.status).toBe(expected);
    if (expected) expect(checks["Credential kind"]!.detail).toBe("A personal subscription token is meant for one person's own use; a shared orchestrator should use an API key or a Team or Enterprise plan. See Anthropic's terms.");
  });

  it.each([
    ["one account", ["ada@example.invalid"], { status: "ok", detail: "Runs as you: your own Claude Code, with your skills, plugins, MCP servers and memory, plus the team's skills." }],
    ["two accounts", ["ada@example.invalid", "max@example.invalid"], { status: "fail", short: "Run as me refused here", detail: "Run as me is for one person's orchestrator, and this one has 2 accounts; tasks do not run until ORCHESTRATOR_TASK_PROFILE is isolated" }],
  ])("given Run as me on an orchestrator with %s, when an admin asks, then the profile line says so and the credential is the user's own sign-in", async (_case, emails, profile) => {
    // given
    const { ctx, bin } = await seeded();
    fakeCli(bin, "claude", "2.1.309 (Claude Code)", say({ loggedIn: true, authMethod: "oauth_token" }));
    const owner = { id: "owner", name: "Owner", email: "owner@example.invalid", role: "owner" as const, ownedTeams: [] };
    for (const email of emails) await createUser(ctx.store, ctx.tenant, new Set(), { email, role: "member" }, owner);
    runnerWith(ctx, [claudeCodeAdapter("claude")], { PATH: `${bin}:/usr/bin:/bin`, HOME: bin, CLAUDE_CODE_OAUTH_TOKEN: KEY }, { profile: "personal" });

    // when
    const checks = checksOf((await readinessOf(ctx)).body, "claude-code");

    // then
    expect(checks.Profile).toEqual({ name: "Profile", ...profile });
    expect(checks.Credential).toEqual({ name: "Credential", status: "ok", detail: "your own Claude Code profile's sign-in" });
    expect(checks["Credential kind"]).toBeUndefined();
  });

  it("given one person's orchestrator with no profile setting and Claude Code signed in through its own login, when an admin asks, then tasks run as that person and the sign-in counts", async () => {
    // given
    const { ctx, bin } = await seeded();
    fakeCli(bin, "claude", "2.1.309 (Claude Code)", say({ loggedIn: true, authMethod: "claude.ai" }));
    const env = { PATH: `${bin}:/usr/bin:/bin`, HOME: bin, ORCHESTRATOR_AGENTS: "claude-code" };
    const options = taskOptionsFromEnv(env, ctx.dataDir, FAKE_AGENT, () => null);
    ctx.tasks = createTaskRunner(ctx, options);

    // when
    const { body } = await readinessOf(ctx);

    // then
    const checks = checksOf(body, "claude-code");
    expect(options.profile).toBe("personal");
    expect(checks.Credential).toEqual({ name: "Credential", status: "ok", detail: "your own Claude Code profile's sign-in" });
    expect(checks["Sign-in"]!.status).toBe("ok");
    expect(body.agents[0]!.ready).toBe(true);
  });

  it("given a CLI that holds only an API key, when its status says not logged in with the key's source, then the credential counts", async () => {
    // given
    const { ctx, bin } = await seeded();
    fakeCli(bin, "claude", "2.1.309 (Claude Code)", say({ loggedIn: false, authMethod: "none", apiKeySource: "ANTHROPIC_API_KEY" }));
    runnerWith(ctx, [claudeCodeAdapter("claude")], hostEnv(bin));

    // when
    const { body } = await readinessOf(ctx);

    // then
    expect(checksOf(body, "claude-code")["Sign-in"]).toMatchObject({ status: "ok", detail: expect.stringContaining("API key from ANTHROPIC_API_KEY") });
    expect(body.agents[0]!.ready).toBe(true);
  });

  it("given a status answer the orchestrator does not read, carrying the credential and a token, when an admin asks, then sign-in is unknown and neither value is in the answer", async () => {
    // given
    const { ctx, bin } = await seeded();
    const token = `ghp_${"A1b2C3d4".repeat(5).slice(0, 36)}`;
    fakeCli(bin, "claude", "2.1.309 (Claude Code)", `echo "unexpected: $ANTHROPIC_API_KEY ${token}"`);
    runnerWith(ctx, [claudeCodeAdapter("claude")], hostEnv(bin));

    // when
    const { body, text } = await readinessOf(ctx);

    // then
    expect(checksOf(body, "claude-code")["Sign-in"]!.status).toBe("unknown");
    expect(text).not.toContain(KEY);
    expect(text).not.toContain(token);
    expect(body.agents[0]!.ready).toBe(true);
  });

  it("given a status answer whose shape changed and that names the account, when an admin asks, then sign-in is unknown and the account is not quoted", async () => {
    // given
    const { ctx, bin } = await seeded();
    fakeCli(bin, "claude", "2.1.309 (Claude Code)", say({ loggedIn: "yes", email: "ada@corp.example.invalid", orgName: "Acme Payments" }));
    runnerWith(ctx, [claudeCodeAdapter("claude")], hostEnv(bin));

    // when
    const { body, text } = await readinessOf(ctx);

    // then
    expect(checksOf(body, "claude-code")["Sign-in"]).toMatchObject({ status: "unknown", detail: "claude auth status --json gave an answer the orchestrator does not read (exit code 0)" });
    expect(text).not.toContain("ada@corp.example.invalid");
    expect(text).not.toContain("Acme Payments");
  });

  it("given container isolation and an image the daemon has, when the status command hangs in its container, then the probe ran as a task's agent does and its container is removed at the limit", async () => {
    // given
    const { ctx, root, bin } = await seeded();
    const calls = join(root, "docker.calls");
    const docker = join(bin, "docker");
    writeFileSync(
      docker,
      `#!/bin/sh
echo "$*" >> ${calls}
case "$1" in
  image) echo sha256:abc ;;
  rm) ;;
  run) case "$*" in *--version*) echo "2.1.309 (Claude Code)" ;; *) sleep 30 ;; esac ;;
esac
`,
    );
    chmodSync(docker, 0o755);
    const isolation: IsolationConfig = { mode: "container", network: "none", image: "agents:1", dataDir: ctx.dataDir };
    // The limit is well past a loaded machine's process start and well short of the 30 seconds the status hangs for.
    runnerWith(ctx, [claudeCodeAdapter("claude")], hostEnv(bin), { isolation, readinessTimeoutMs: 5000 });

    // when
    const { body, text } = await readinessOf(ctx);

    // then
    const checks = checksOf(body, "claude-code");
    expect([checks.Image!.status, checks.Version!.status, checks["Sign-in"]!.status]).toEqual(["ok", "ok", "unknown"]);
    const recorded = readFileSync(calls, "utf8").trim().split("\n");
    const status = recorded.find((line) => line.startsWith("run ") && line.includes("auth status"))!;
    expect(status).toContain("--network none");
    expect(status).toContain("-e ANTHROPIC_API_KEY");
    expect(status).toContain("--entrypoint claude agents:1 auth status --json");
    expect(recorded.join("\n")).not.toContain(KEY);
    const name = status.match(/--name (\S+)/)![1]!;
    expect(name).toMatch(/^teamhandbook-probe-[0-9a-f]{8}-demo$/);
    expect(recorded).toContain(`rm -f ${name}`);
    expect(text).not.toContain(KEY);
  });

  it("given a status command that never answers, when the probe's time runs out, then sign-in is unknown and the command and what it started are gone", async () => {
    // given
    const { ctx, root, bin } = await seeded();
    const pidFile = join(root, "status.pid");
    fakeCli(bin, "claude", "2.1.309 (Claude Code)", `sleep 60 & echo $! > ${pidFile}; wait`);
    runnerWith(ctx, [claudeCodeAdapter("claude")], hostEnv(bin), { readinessTimeoutMs: 1000 });

    // when
    const { body } = await readinessOf(ctx);

    // then
    expect(checksOf(body, "claude-code")["Sign-in"]).toMatchObject({ status: "unknown", detail: "claude auth status --json gave no answer within 1 s" });
    const pid = Number(readFileSync(pidFile, "utf8"));
    const alive = () => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    for (let i = 0; i < 50 && alive(); i++) await new Promise((r) => setTimeout(r, 100));
    expect(alive()).toBe(false);
  });

  it("given the orchestrator's own settings in its environment, when the status command runs, then it sees only what a task gets and its scratch directories are gone", async () => {
    // given
    const { ctx, root, bin } = await seeded();
    const dump = join(root, "status.env");
    fakeCli(bin, "claude", "2.1.309 (Claude Code)", `env > ${dump}; ${say({ loggedIn: true, authMethod: "api_key" })}`);
    runnerWith(ctx, [claudeCodeAdapter("claude")], hostEnv(bin, { ORCHESTRATOR_SECRET_KEY: "z".repeat(32), HOME: "/home/orchestrator-host", SERVICE_TOKEN: "svc-credential-9f8e7d6c5b4a" }));

    // when
    await readinessOf(ctx);

    // then
    const seen = Object.fromEntries(readFileSync(dump, "utf8").trim().split("\n").map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]));
    expect(seen.ANTHROPIC_API_KEY).toBe(KEY);
    expect(seen.ORCHESTRATOR_SECRET_KEY).toBeUndefined();
    expect(seen.SERVICE_TOKEN).toBeUndefined();
    expect(seen.HOME).toContain(join(ctx.dataDir, "tasks", ctx.tenant, "probe-"));
    expect(seen.CLAUDE_CONFIG_DIR).toBe(join(seen.HOME!, ".claude"));
    expect(readdirSync(join(ctx.dataDir, "tasks", ctx.tenant))).toEqual([]);
  });

  it("given container isolation and an image the daemon does not have, when an admin asks, then the image fails and nothing is run or pulled", async () => {
    // given
    const { ctx, root, bin } = await seeded();
    const calls = join(root, "docker.calls");
    const docker = join(bin, "docker");
    writeFileSync(docker, `#!/bin/sh\necho "$*" >> ${calls}\nif [ "$1" = image ]; then echo "Error: No such image: agents:1" >&2; exit 1; fi\nexit 0\n`);
    chmodSync(docker, 0o755);
    const isolation: IsolationConfig = { mode: "container", network: "none", image: "agents:1", dataDir: ctx.dataDir };
    runnerWith(ctx, [claudeCodeAdapter("claude")], hostEnv(bin), { isolation });

    // when
    const { body } = await readinessOf(ctx);

    // then
    const checks = checksOf(body, "claude-code");
    expect(checks.Image).toMatchObject({ status: "fail", detail: "agents:1 is not on the Docker daemon; build or pull it (the check never pulls)" });
    expect(checks["Sign-in"]!.status).toBe("unknown");
    // The start lists leftover probe containers first; the check itself only inspects.
    expect(readFileSync(calls, "utf8").trim().split("\n")).toEqual(["ps -a --filter name=teamhandbook-probe- --format {{.Names}}", "image inspect --format {{.Id}} agents:1"]);
  });

  it("given OpenCode with a provider key in its environment, when its credential list is read, then sign-in counts the key, and with none it fails", async () => {
    // given
    const { ctx, bin } = await seeded();
    const listed = (environment: boolean) =>
      `printf '\\033[2mCredentials ~/.local/share/opencode/auth.json\\033[0m\\n0 credentials\\n${environment ? "\\n\\033[1mEnvironment\\033[0m\\nAnthropic ANTHROPIC_API_KEY\\n" : ""}'`;
    fakeCli(bin, "opencode", "1.18.31", listed(true));
    const other = join(bin, "other");
    mkdirSync(other);
    fakeCli(other, "opencode", "1.18.31", listed(false));
    runnerWith(ctx, [opencodeAdapter("opencode")], hostEnv(bin));

    // when
    const withKey = (await readinessOf(ctx)).body;
    runnerWith(ctx, [opencodeAdapter(join(other, "opencode"))], hostEnv(bin));
    const without = (await readinessOf(ctx)).body;

    // then
    expect(checksOf(withKey, "opencode")["Sign-in"]).toMatchObject({ status: "ok", detail: expect.stringContaining("a provider key in the environment") });
    expect(checksOf(without, "opencode")["Sign-in"]!.status).toBe("fail");
  });

  it("given allowed MCP tools whose server is missing from the team's .mcp.json or held back by the share rule, when an admin asks, then each is named with its own cause, and OpenCode without MCP says what turns it on", async () => {
    // given
    const { ctx, root, bin } = await seeded();
    const repo = (await ctx.store.getRepo(ctx.tenant, "payments-skills"))!;
    const bare = localRepoPath(repo.url)!;
    const work = join(root, "edit");
    git(["clone", "--quiet", bare, work], root);
    const mcp = JSON.parse(readFileSync(join(work, ".mcp.json"), "utf8"));
    mcp.mcpServers.vault = { command: "vault-mcp", env: { VAULT_TOKEN: "literal-vault-token-123456" } };
    writeFileSync(join(work, ".mcp.json"), JSON.stringify(mcp, null, 2));
    git(["commit", "--quiet", "-am", "feat(mcp): add vault"], work);
    git(["fetch", "--quiet", work, "main:main"], bare);
    await syncRepo(ctx, repo.id);
    fakeCli(bin, "claude", "2.1.309 (Claude Code)", say({ loggedIn: true, authMethod: "claude.ai" }));
    fakeCli(bin, "opencode", "1.18.31", "echo '1 credentials'");
    const allowed = [{ server: "docs", tool: "search" }, { server: "warehouse", tool: "query" }, { server: "vault", tool: "read" }];
    runnerWith(ctx, [claudeCodeAdapter("claude"), opencodeAdapter("opencode")], hostEnv(bin), { mcpTools: (r) => (r.id === "payments-skills" ? allowed : []) });

    // when
    const { body, text } = await readinessOf(ctx);

    // then
    const claude = checksOf(body, "claude-code")["MCP tools, payments-skills"]!;
    expect(claude.status).toBe("warn");
    expect(claude.detail).toContain("warehouse is not in the team's .mcp.json, so its tools are never given");
    expect(claude.detail).toContain("vault is in the team's .mcp.json but held back by the share rule");
    expect(claude.detail).not.toContain("docs");
    expect(checksOf(body, "opencode")["MCP tools, payments-skills"]).toMatchObject({ status: "warn", detail: expect.stringContaining("without ORCHESTRATOR_OPENCODE_MCP=1") });
    expect(Object.keys(checksOf(body, "claude-code")).filter((name) => name.startsWith("MCP"))).toEqual(["MCP tools, payments-skills"]);
    expect(text).not.toContain("literal-vault-token-123456");
  });

  it("given a finished check, when it is asked for again within its lifetime and then fresh, then the CLI is asked only for the fresh one", async () => {
    // given
    const { ctx, root, bin } = await seeded();
    const count = join(root, "version.count");
    const file = join(bin, "claude");
    writeFileSync(file, `#!/bin/sh\ncase "$1" in\n  --version) echo x >> ${count}; echo "2.1.309 (Claude Code)" ;;\n  auth) ${say({ loggedIn: true, authMethod: "claude.ai" })} ;;\nesac\n`);
    chmodSync(file, 0o755);
    runnerWith(ctx, [claudeCodeAdapter("claude")], hostEnv(bin));
    const asked = () => readFileSync(count, "utf8").trim().split("\n").length;

    // when
    const first = (await readinessOf(ctx)).body;
    const again = (await readinessOf(ctx)).body;
    const before = asked();
    const fresh = (await readinessOf(ctx, true)).body;

    // then
    expect(again.checkedAt).toBe(first.checkedAt);
    expect(before).toBe(1);
    expect(asked()).toBe(2);
    expect(fresh.checkedAt > first.checkedAt).toBe(true);
  });
});

describe("who sees an agent's readiness", () => {
  it("given a Claude Code CLI a minor version newer than the one checked against, when an admin opens the task form, then it is ready with warnings and the form carries no check's text", async () => {
    // given
    const { ctx, bin } = await seeded();
    fakeCli(bin, "claude", "2.2.0 (Claude Code)", say({ loggedIn: true, authMethod: "claude.ai" }));
    runnerWith(ctx, [claudeCodeAdapter("claude")], hostEnv(bin));
    await ctx.tasks!.readiness();

    // when
    const options = await (await createApp(ctx, as(ADMIN)).request("/api/tasks/options")).json();

    // then
    expect(options.readinessReport).toBe(true);
    expect(options.agents).toEqual([{ id: "claude-code", label: "Claude Code", modes: expect.any(Array), options: expect.any(Array), questions: expect.any(Boolean), plan: expect.any(Boolean), readiness: { ready: true, state: "warnings", first: "version newer than checked" }, personal: null }]);
  });

  it("given a team's owner, when they ask for readiness and for the task form, then the full report is refused and the form says only where each agent stands once a check has finished", async () => {
    // given
    const { ctx, bin } = await seeded();
    runnerWith(ctx, [fakeAgentAdapter(FAKE_AGENT), claudeCodeAdapter("claude")], hostEnv(bin));
    const app = createApp(ctx, as(PAYMENTS_OWNER));

    // when
    const report = await app.request("/api/agents/readiness");
    const before = await (await app.request("/api/tasks/options")).json();
    await ctx.tasks!.readiness();
    const after = await (await app.request("/api/tasks/options")).json();

    // then
    expect(report.status).toBe(403);
    expect(before.agents.map((a: { readiness: unknown }) => a.readiness)).toEqual([null, null]);
    expect(after.readinessReport).toBe(false);
    expect(after.agents).toEqual([
      { id: "fake", label: "Demo agent", modes: ["approval-required", "auto-accept-edits", "auto"], options: [], questions: false, plan: false, readiness: { ready: true, state: "ready", first: null }, personal: null },
      { id: "claude-code", label: "Claude Code", modes: expect.any(Array), options: expect.any(Array), questions: expect.any(Boolean), plan: expect.any(Boolean), readiness: { ready: false, state: "not-ready", first: "program not found" }, personal: null },
    ]);
    expect(existsSync(join(ctx.dataDir, "tasks", ctx.tenant)) ? readdirSync(join(ctx.dataDir, "tasks", ctx.tenant)) : []).toEqual([]);
  });
});
