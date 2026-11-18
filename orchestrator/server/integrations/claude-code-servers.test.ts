import { randomBytes } from "node:crypto";
import type { MiddlewareHandler } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import type { OrchestratorContext } from "../app.js";
import type { OrchestratorEnv, Principal } from "../auth.js";
import { openSqliteStore } from "../store.js";
import { createVault } from "../vault.js";
import type { PersonalSetup } from "../tasks/personal-setup.js";
import { claudeCodeServers } from "./claude-code-servers.js";

const OWNER: Principal = { id: "u-solo", name: "Solo Person", email: "solo@example.invalid", role: "owner", ownedTeams: [] };

/** The runner's probe standing in: what it last read, and how many reads were begun. */
function probe(setup: PersonalSetup | null) {
  const asked = { reads: 0 };
  const tasks = { lastPersonalSetup: () => setup, personalSetup: async () => (asked.reads++, setup) } as unknown as NonNullable<OrchestratorContext["tasks"]>;
  return { ctx: { tasks }, asked };
}

const SETUP: PersonalSetup = {
  commands: [],
  plugins: [],
  claudeMd: false,
  readAt: "2026-11-04T08:00:00.000Z",
  mcpServers: [
    { name: "atlassian", kind: "http", scope: "user", asksForValue: false },
    { name: "linear-server", kind: "http", scope: "project", asksForValue: true },
    { name: "local-db", kind: "stdio", scope: "user", asksForValue: false },
    { name: "helper", kind: "unknown", scope: "plugin", asksForValue: null },
  ],
};

afterEach(() => {
  delete process.env.ORCHESTRATOR_MODE;
});

describe("the MCP servers of one person's own Claude Code, as Integrations counts them", () => {
  it("given the probe's read on a local orchestrator, when its owner opens Integrations, then the page is told how many servers their tasks use, nothing of what they are, and a fresh read is begun", () => {
    // given
    process.env.ORCHESTRATOR_MODE = "local";
    const { ctx, asked } = probe(SETUP);

    // when
    const counted = claudeCodeServers(ctx, OWNER);

    // then
    expect(counted).toBe(4);
    expect(asked.reads).toBe(1);
  });

  it("given a team's orchestrator, an API key or a member, when Integrations is read, then no count is given", () => {
    // given
    const { ctx } = probe(SETUP);
    const member: Principal = { ...OWNER, role: "member" };

    // when
    process.env.ORCHESTRATOR_MODE = "self-hosted";
    const team = claudeCodeServers(ctx, OWNER);
    process.env.ORCHESTRATOR_MODE = "local";
    const byKey = claudeCodeServers(ctx, { ...OWNER, key: { id: "k", scope: "read" } as unknown as Principal["key"] });
    const byMember = claudeCodeServers(ctx, member);

    // then
    expect([team, byKey, byMember]).toEqual([null, null, null]);
  });
});

/** Claude Code's own sign-in as the runner will answer it: what it was asked, and what it says back. */
function runnerFor(answer: { authorizeUrl: string } | { signedIn: true } | { failed: string }, claude: { ok: boolean } | null = null) {
  const asked: string[] = [];
  const ran: { args: string[]; cwd: string | undefined }[] = [];
  const tasks = {
    lastPersonalSetup: () => SETUP,
    personalSetup: async () => SETUP,
    startMcpSignIn: async (name: string) => (asked.push(name), answer),
    mcpSignInState: () => ({ state: "waiting" as const }),
    ...(claude ? { runClaudeMcp: async (args: string[], cwd?: string) => (ran.push({ args, cwd }), claude) } : {}),
  } as unknown as NonNullable<OrchestratorContext["tasks"]>;
  return { tasks, asked, ran };
}

async function orchestrator_(tasks: OrchestratorContext["tasks"]) {
  const logged: string[] = [];
  const ctx: OrchestratorContext = { store: openSqliteStore(":memory:"), dataDir: "unused", tenant: "acme", allowedHosts: null, vault: createVault(randomBytes(32)), tasks, ownForgeCli: true, audit: async (actor, kind, fields) => void logged.push(`${actor.id} ${kind} ${fields.subject} ${fields.detail}`) };
  const who = { user: OWNER };
  const auth: MiddlewareHandler<OrchestratorEnv> = async (c, next) => {
    c.set("user", who.user);
    await next();
  };
  const app = createApp(ctx, auth);
  return { ctx, logged, who, call: (method: string, path: string, body?: unknown) => app.request(path, { method, ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) }) };
}

describe("signing in a server of the person's own Claude Code from the page", () => {
  it("given the owner of a one-person orchestrator, when they press Sign in for a server of their Claude Code, then Claude Code is asked once, the page is given its sign-in address, the state is readable and only the server's name is logged", async () => {
    // given
    process.env.ORCHESTRATOR_MODE = "local";
    const runner = runnerFor({ authorizeUrl: "https://auth.example.invalid/authorize?state=s3cr3t" });
    const { call, logged } = await orchestrator_(runner.tasks);

    // when
    const started = await call("POST", "/api/me/claude-mcp/linear-server/sign-in");
    const state = await call("GET", "/api/me/claude-mcp/linear-server/sign-in");

    // then
    expect([started.status, await started.json()]).toEqual([200, { authorizeUrl: "https://auth.example.invalid/authorize?state=s3cr3t" }]);
    expect(await state.json()).toEqual({ state: "waiting" });
    expect(runner.asked).toEqual(["linear-server"]);
    expect(logged).toEqual(["u-solo mcp.claude.sign-in.started claude-mcp:linear-server began signing in a server of their own Claude Code, which Claude Code finishes on this machine"]);
  });

  it("given a task that found a server asking to sign in, when the owner presses Sign in for it, then it is asked even though the probe did not read it", async () => {
    // given
    process.env.ORCHESTRATOR_MODE = "local";
    const runner = runnerFor({ signedIn: true });
    const { ctx, call } = await orchestrator_(runner.tasks);
    await ctx.store.createTask({ tenant: "acme", id: "aaaaaaaaaaaa", repoId: "web", team: "Mine", title: "t", description: "", issueUrl: null, issueKey: null, agent: "fake", status: "needs-review", createdBy: OWNER.email, createdAt: new Date().toISOString(), startedAt: null, finishedAt: null, baseSha: null, tests: null, cost: { usd: null, inputTokens: null, outputTokens: null }, requestNumber: null, error: null });
    await ctx.store.updateTask("acme", "aaaaaaaaaaaa", { mcpNeedsSignIn: ["claude.ai Notion"] });

    // when
    const res = await call("POST", `/api/me/claude-mcp/${encodeURIComponent("claude.ai Notion")}/sign-in`);

    // then
    expect([res.status, await res.json(), runner.asked]).toEqual([200, { signedIn: true }, ["claude.ai Notion"]]);
  });

  it("given a name Claude Code never named, a team's orchestrator, a member, or a runner that says it cannot, when Sign in is pressed, then Claude Code is not asked and the answer says no such server, or why not", async () => {
    // given
    process.env.ORCHESTRATOR_MODE = "local";
    const runner = runnerFor({ failed: "the task has no live session" });
    const { call, who } = await orchestrator_(runner.tasks);

    // when
    const unknown = await call("POST", "/api/me/claude-mcp/not-in-claude-code/sign-in");
    const refused = await call("POST", "/api/me/claude-mcp/linear-server/sign-in");
    who.user = { ...OWNER, role: "member" };
    const member = await call("POST", "/api/me/claude-mcp/linear-server/sign-in");
    who.user = OWNER;
    process.env.ORCHESTRATOR_MODE = "self-hosted";
    const team = await call("GET", "/api/me/claude-mcp/linear-server/sign-in");

    // then
    expect([unknown.status, refused.status, await refused.json(), member.status, team.status]).toEqual([404, 409, { code: "conflict", error: "the task has no live session" }, 404, 404]);
    expect(runner.asked).toEqual(["linear-server"]);
  });
});

describe("adding and removing a server of the person's own Claude Code from the page", () => {
  const FOLDER = "/home/ada/projects/web";
  async function withFolder(claude: { ok: boolean } | null = { ok: true }) {
    process.env.ORCHESTRATOR_MODE = "local";
    const runner = runnerFor({ signedIn: true }, claude);
    const made = await orchestrator_(runner.tasks);
    await made.ctx.store.upsertRepo({ tenant: "acme", id: "web", team: "Mine", name: "web", url: FOLDER });
    return { ...made, runner };
  }
  const stdio = { name: "helper", reach: "stdio", scope: "local", folder: "web", command: "npx", args: ["-y", "helper-mcp"], env: [{ name: "API_KEY", value: "s3cr3t-value" }] };

  it("given the owner adds a server run as a command with a secret value, when they press Add, then Claude Code is asked once with exactly that command in their folder, the answer and the log hold no value, and the preview showed dots and ran nothing", async () => {
    // given
    const { call, logged, runner } = await withFolder();

    // when
    const preview = await call("POST", "/api/me/claude-mcp/preview", { action: "add", ...stdio });
    const ranBefore = runner.ran.length;
    const added = await call("POST", "/api/me/claude-mcp", stdio);
    const addedBody = await added.json();

    // then
    expect(ranBefore).toBe(0);
    expect((await preview.json()).line).toBe("claude mcp add -s local -t stdio helper -e 'API_KEY=••••' -- npx -y helper-mcp");
    expect(runner.ran).toEqual([{ args: ["mcp", "add", "-s", "local", "-t", "stdio", "helper", "-e", "API_KEY=s3cr3t-value", "--", "npx", "-y", "helper-mcp"], cwd: FOLDER }]);
    expect([added.status, addedBody.added, addedBody.command]).toEqual([200, true, "claude mcp add -s local -t stdio helper -e 'API_KEY=••••' -- npx -y helper-mcp"]);
    expect(JSON.stringify([addedBody, logged])).not.toContain("s3cr3t-value");
    expect(logged).toEqual(["u-solo mcp.claude.added claude-mcp:helper added helper (stdio) to their own Claude Code for one folder, as local"]);
  });

  it("given a server over http for every folder with a header, when it is added, then no folder is needed, the header goes as a header, and a command that starts with a dash is run as a command after the dashes", async () => {
    // given
    const { call, runner } = await withFolder();

    // when
    const http = await call("POST", "/api/me/claude-mcp", { name: "tickets", reach: "http", scope: "user", url: "https://ticket-desk.example.invalid/mcp", headers: [{ name: "X-Api-Key", value: "header-value" }] });
    const dash = await call("POST", "/api/me/claude-mcp", { name: "odd", reach: "stdio", scope: "user", command: "-rm", args: [] });

    // then
    expect(http.status).toBe(200);
    expect(dash.status).toBe(200);
    expect(runner.ran.map((r) => [r.args, r.cwd])).toEqual([
      [["mcp", "add", "-s", "user", "-t", "http", "tickets", "https://ticket-desk.example.invalid/mcp", "-H", "X-Api-Key: header-value"], undefined],
      [["mcp", "add", "-s", "user", "-t", "stdio", "odd", "--", "-rm"], undefined],
    ]);
  });

  it("given a value with a line break, a folder path instead of a listed folder's id, a bad name, an unknown reach, or a header on a command, when Add is pressed, then it is refused and Claude Code is not asked", async () => {
    // given
    const { call, runner } = await withFolder();

    // when
    const refused = await Promise.all([
      call("POST", "/api/me/claude-mcp", { ...stdio, env: [{ name: "API_KEY", value: "a\nb" }] }),
      call("POST", "/api/me/claude-mcp", { ...stdio, folder: FOLDER }),
      call("POST", "/api/me/claude-mcp", { ...stdio, name: "bad name; rm" }),
      call("POST", "/api/me/claude-mcp", { ...stdio, env: [{ name: "1BAD", value: "v" }] }),
      call("POST", "/api/me/claude-mcp", { ...stdio, reach: "ftp" }),
      call("POST", "/api/me/claude-mcp", { ...stdio, headers: [{ name: "X-A", value: "v" }] }),
    ]);

    // then
    expect(refused.map((r) => r.status)).toEqual([400, 400, 400, 400, 400, 400]);
    expect(runner.ran).toEqual([]);
  });

  it("given Claude Code says it did not add the server, or this runner cannot run the command, when Add is pressed, then the answer is the orchestrator's own sentence with the command as dots and no output of Claude Code's", async () => {
    // given
    const failing = await withFolder({ ok: false });
    const absent = await withFolder(null);

    // when
    const failed = await failing.call("POST", "/api/me/claude-mcp", stdio);
    const cannot = await absent.call("POST", "/api/me/claude-mcp", stdio);

    // then
    expect([failed.status, await failed.json()]).toEqual([409, { code: "conflict", error: "Claude Code did not add helper.", command: "claude mcp add -s local -t stdio helper -e 'API_KEY=••••' -- npx -y helper-mcp" }]);
    expect([cannot.status, (await cannot.json()).error]).toEqual([409, "this orchestrator cannot ask Claude Code to add a server yet"]);
  });

  it("given servers the probe read in the user and project scopes, when the owner removes one, then it is removed from the scope named, and a scope the server is not in, or no scope, is refused before anything runs", async () => {
    // given
    const { call, runner } = await withFolder();

    // when
    const removed = await call("DELETE", "/api/me/claude-mcp/atlassian?scope=user");
    const wrongScope = await call("DELETE", "/api/me/claude-mcp/atlassian?scope=project&folder=web");
    const noScope = await call("DELETE", "/api/me/claude-mcp/atlassian");
    const project = await call("DELETE", "/api/me/claude-mcp/linear-server?scope=project&folder=web");

    // then
    expect([removed.status, wrongScope.status, noScope.status, project.status]).toEqual([200, 404, 400, 200]);
    expect(runner.ran).toEqual([
      { args: ["mcp", "remove", "-s", "user", "atlassian"], cwd: undefined },
      { args: ["mcp", "remove", "-s", "project", "linear-server"], cwd: FOLDER },
    ]);
  });

  it("given a team's orchestrator, a member, or an API key, when any of the routes is used, then there is no such server and nothing runs", async () => {
    // given
    const { call, runner, who } = await withFolder();

    // when
    who.user = { ...OWNER, role: "member" };
    const member = await call("POST", "/api/me/claude-mcp", stdio);
    who.user = OWNER;
    process.env.ORCHESTRATOR_MODE = "self-hosted";
    const team = await call("DELETE", "/api/me/claude-mcp/atlassian?scope=user");
    const teamPreview = await call("POST", "/api/me/claude-mcp/preview", { action: "remove", name: "atlassian", scope: "user" });

    // then
    expect([member.status, team.status, teamPreview.status]).toEqual([404, 404, 404]);
    expect(runner.ran).toEqual([]);
  });
});
