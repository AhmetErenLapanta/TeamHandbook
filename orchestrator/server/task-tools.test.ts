import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OrchestratorContext } from "./app.js";
import type { OrchestratorEnv, Principal } from "./auth.js";
import { plainGitServer } from "./forge/stand-in-git.js";
import { openSqliteStore } from "./store.js";
import { machineMcpServerOf, mcpConfigOf, readTaskTools, skillSourceDir, taskToolRoutes, toolChoiceOf } from "./task-tools.js";
import type { TaskMcpServer } from "./task-tools.js";
import { machineMcpServers } from "../runner/machine-mcp.js";
import { createVault } from "./vault.js";

const OWNER: Principal = { id: "usr_a", name: "Ada", email: "ada@example.invalid", role: "owner", ownedTeams: [] };
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=Stand In", "-c", "user.email=stand-in@example.invalid", ...args], { cwd, encoding: "utf8" }).trim();

const dirs: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(servers.splice(0).map((s) => new Promise((done) => s.close(done))));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const skill = (dir: string, name: string) => {
  mkdirSync(join(dir, name), { recursive: true });
  writeFileSync(join(dir, name, "SKILL.md"), `---\nname: ${name}\ndescription: The ${name} step.\n---\n`);
};

/**
 * A local orchestrator whose home holds a folder of two skills, a folder of none and a hidden
 * one, a git repository of skills served on this machine, and the project notes, reached as `user`.
 */
async function machine(user: Principal = OWNER) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "th-task-tools-")));
  dirs.push(root);
  const home = join(root, "home");
  skill(join(home, "code", "team-skills", "skills"), "handover");
  skill(join(home, "code", "team-skills", "skills"), "release-notes");
  mkdirSync(join(home, "code", "empty"), { recursive: true });
  skill(join(home, ".hidden"), "secret-step");
  const seed = join(root, "seed");
  skill(join(seed, "skills"), "retry");
  git(seed, "init", "-q", "-b", "main");
  git(seed, "add", ".");
  git(seed, "commit", "-q", "-m", "first");
  mkdirSync(join(root, "served", "acme"), { recursive: true });
  execFileSync("git", ["clone", "-q", "--bare", seed, join(root, "served", "acme", "skills.git")]);
  const web = await plainGitServer(join(root, "served"), servers);
  vi.stubEnv("HOME", home);
  vi.stubEnv("ORCHESTRATOR_MODE", "local");
  const ctx: OrchestratorContext = { store: openSqliteStore(":memory:"), dataDir: join(root, "data"), tenant: "default", vault: createVault(randomBytes(32)), privateNetworkForges: true, ownForgeCli: true, resolveHost: async () => ["127.0.0.1"] };
  await ctx.store.upsertRepo({ tenant: "default", id: "notes", team: "Mine", name: "notes", url: join(home, "notes") });
  const app = new Hono<OrchestratorEnv>();
  app.use("*", async (c, next) => {
    c.set("user", user);
    await next();
  });
  app.route("/", taskToolRoutes(ctx));
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await app.request(path, { method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: res.status, body: res.status === 204 ? null : await res.json() };
  };
  return { ctx, call, gitUrl: `${web}/acme/skills.git` };
}

describe("what a project gives the tasks that run in it", { timeout: 60_000 }, () => {
  it("given a folder of skills, the same folder again, a folder of none, a hidden one and a git address, when each is added as a skill source and the git one is removed, then the folder's and the repository's skills are read, the others refused by their codes, and the removed one's mirror is gone", async () => {
    // given
    const { ctx, call, gitUrl } = await machine();

    // when
    const folder = await call("POST", "/api/projects/notes/skill-sources", { folder: "~/code/team-skills" });
    const again = await call("POST", "/api/projects/notes/skill-sources", { folder: "~/code/team-skills" });
    const empty = await call("POST", "/api/projects/notes/skill-sources", { folder: "~/code/empty" });
    const hidden = await call("POST", "/api/projects/notes/skill-sources", { folder: "~/.hidden" });
    const repo = await call("POST", "/api/projects/notes/skill-sources", { url: gitUrl });
    const token = await call("POST", "/api/projects/notes/skill-sources", { url: "https://ada:glpat-x@gitlab.example.invalid/acme/skills.git" });
    const mirror = skillSourceDir(ctx, repo.body.source.id);
    const mirrored = existsSync(mirror);
    const removed = await call("DELETE", `/api/projects/notes/skill-sources/${repo.body.source.id}`);

    // then
    expect(folder).toMatchObject({ status: 200, body: { source: { kind: "folder", path: "~/code/team-skills", skills: [{ name: "handover" }, { name: "release-notes" }] } } });
    expect([again.status, again.body.code, empty.body.code, hidden.body.code, token.body.code]).toEqual([409, "already-added", "no-skills", "hidden", "address-has-credentials"]);
    expect(repo).toMatchObject({ status: 200, body: { source: { kind: "git", url: gitUrl, head: expect.stringMatching(/^[0-9a-f]{40}$/), skills: [{ name: "retry", description: "The retry step." }] } } });
    expect([mirrored, removed.status, existsSync(mirror)]).toEqual([true, 204, false]);
    expect((await readTaskTools(ctx, "notes")).skillSources.map((s) => s.kind)).toEqual(["folder"]);
  });

  it("given MCP servers with an env value and a header, one with a token in its command, one with its name taken and a removal, when each is added, then the record names the values only, the vault holds them, the --mcp-config reads them back, and the refused ones are kept nowhere", async () => {
    // given
    const { ctx, call } = await machine();

    // when
    const stdio = await call("POST", "/api/projects/notes/mcp-servers", { name: "tracker", command: "npx", args: ["tracker-mcp"], env: { TRACKER_TOKEN: "tracker-token-0123456789" } });
    const http = await call("POST", "/api/projects/notes/mcp-servers", { name: "docs", url: "https://docs.example.invalid/mcp", headers: { Authorization: "Bearer docs-0123456789" } });
    const inCommand = await call("POST", "/api/projects/notes/mcp-servers", { name: "leaky", command: "npx", args: ["leaky-mcp", "--token", `ghp_${"a1B2".repeat(9)}`] });
    const taken = await call("POST", "/api/projects/notes/mcp-servers", { name: "tracker", command: "npx" });
    const listed = await call("GET", "/api/projects/notes/task-tools");
    const config = await mcpConfigOf(ctx, "notes", stdio.body.server);
    const removed = await call("DELETE", `/api/projects/notes/mcp-servers/${http.body.server.id}`);

    // then
    expect(stdio.body.server).toEqual({ id: expect.any(String), name: "tracker", transport: "stdio", command: "npx", args: ["tracker-mcp"], env: ["TRACKER_TOKEN"] });
    expect(http.body.server).toMatchObject({ name: "docs", transport: "http", headers: ["Authorization"] });
    expect([inCommand.body.code, taken.body.code]).toEqual(["carries-credential", "name-taken"]);
    expect(JSON.stringify(listed.body)).not.toMatch(/tracker-token|docs-0123|ghp_/);
    expect(config).toEqual({ command: "npx", args: ["tracker-mcp"], env: { TRACKER_TOKEN: "tracker-token-0123456789" } });
    expect(removed.status).toBe(204);
    expect((await readTaskTools(ctx, "notes")).mcpServers.map((s) => s.name)).toEqual(["tracker"]);
  });

  it("given a member and an API key on a local orchestrator, when they change what the project's tasks are given, then both are refused", async () => {
    const member = await machine({ ...OWNER, role: "member" });
    const key = await machine({ ...OWNER, key: { id: "key_1", owner: { kind: "user", id: "usr_a" }, scopes: { repositories: "read", requests: "none", tasks: "none", usage: "none", members: "none", settings: "none", keys: "none" }, expiresAt: null } });
    expect((await member.call("POST", "/api/projects/notes/mcp-servers", { name: "x", command: "npx" })).status).toBe(403);
    expect((await key.call("GET", "/api/projects/notes/task-tools")).status).toBe(403);
  });

  it("given a project with a skill source and two MCP servers, one with a sealed value, when a start picks them, an unknown one and the same twice, then the pick keeps the source's head and each once, the unknown is refused by its code, and on a team's orchestrator the sealed one goes to the person's machine as a template and is held back where tasks run on the server", async () => {
    // given
    const { ctx, call, gitUrl } = await machine();
    const source = (await call("POST", "/api/projects/notes/skill-sources", { url: gitUrl })).body.source;
    const plain = (await call("POST", "/api/projects/notes/mcp-servers", { name: "docs", command: "npx", args: ["docs-mcp"] })).body.server;
    const sealed = (await call("POST", "/api/projects/notes/mcp-servers", { name: "tracker", command: "npx", env: { TRACKER_TOKEN: "tracker-token-0123456789" } })).body.server;

    // when
    const picked = await toolChoiceOf(ctx, "notes", [{ source: source.id, name: "retry" }, { source: source.id, name: "retry" }], [plain.id, sealed.id]);
    const unknownSkill = await toolChoiceOf(ctx, "notes", [{ source: source.id, name: "gone" }], undefined);
    const unknownServer = await toolChoiceOf(ctx, "notes", undefined, ["mcp_none"]);
    vi.stubEnv("ORCHESTRATOR_MODE", "self-hosted");
    const onTeam = await toolChoiceOf(ctx, "notes", undefined, [plain.id, sealed.id], [plain.id, sealed.id]);
    vi.stubEnv("ORCHESTRATOR_SERVER_TASKS", "1");
    const onServer = await toolChoiceOf(ctx, "notes", undefined, [sealed.id], [sealed.id]);

    // then
    expect(picked).toEqual({ skills: [{ source: source.id, name: "retry", head: source.head }], mcpServers: [plain.id, sealed.id] });
    expect(["code" in unknownSkill && unknownSkill.code, "code" in unknownServer && unknownServer.code, "code" in onServer && onServer.code]).toEqual(["unknown-project-skill", "unknown-mcp-server", "sealed-on-server"]);
    expect(onTeam).toEqual({ skills: [], mcpServers: [plain.id, sealed.id] });
  });

  it("given a team's orchestrator, when the project's team owner adds a server that runs a command and servers at this machine's and a private address, and a start picks a command with and without confirming it and where this orchestrator runs tasks, then only owners and admins add a command, the addresses are refused, and a command is started only once confirmed or in a container", async () => {
    // given
    const admin = await machine({ ...OWNER, role: "admin" });
    const teamOwner = await machine({ ...OWNER, role: "member", ownedTeams: ["Mine"], restrictedTeams: [] });
    vi.stubEnv("ORCHESTRATOR_MODE", "self-hosted");

    // when
    const byTeamOwner = await teamOwner.call("POST", "/api/projects/notes/mcp-servers", { name: "runs", command: "npx", args: ["runs-mcp"] });
    const atThisMachine = await teamOwner.call("POST", "/api/projects/notes/mcp-servers", { name: "near", url: "http://127.0.0.1:3000/mcp" });
    const atPrivate = await teamOwner.call("POST", "/api/projects/notes/mcp-servers", { name: "inside", url: "https://10.0.0.5/mcp" });
    const command = (await admin.call("POST", "/api/projects/notes/mcp-servers", { name: "runs", command: "npx", args: ["runs-mcp"] })).body.server;
    const unconfirmed = await toolChoiceOf(admin.ctx, "notes", undefined, [command.id]);
    const confirmed = await toolChoiceOf(admin.ctx, "notes", undefined, [command.id], [command.id]);
    vi.stubEnv("ORCHESTRATOR_SERVER_TASKS", "1");
    const onProcess = await toolChoiceOf(admin.ctx, "notes", undefined, [command.id], [command.id]);
    vi.stubEnv("ORCHESTRATOR_TASK_ISOLATION", "container");
    const inContainer = await toolChoiceOf(admin.ctx, "notes", undefined, [command.id]);

    // then
    expect([byTeamOwner.status, byTeamOwner.body.code]).toEqual([403, "command-owners-only"]);
    expect([atThisMachine.body.code, atPrivate.body.code]).toEqual(["bad-url", "bad-url"]);
    expect(["code" in unconfirmed && unconfirmed.code, "error" in unconfirmed && unconfirmed.error]).toEqual(["command-not-confirmed", "runs runs `npx runs-mcp` on your machine; confirm it to start the task"]);
    expect(confirmed).toEqual({ skills: [], mcpServers: [command.id] });
    expect("code" in onProcess && onProcess.code).toBe("command-needs-container");
    expect(inContainer).toEqual({ skills: [], mcpServers: [command.id] });
  });
});

describe("a project's MCP server on a person's machine", () => {
  it("given a command server with two sealed env values and an HTTP server with two sealed headers, when a machine task's lease names them and the machine fills them from its person's own environment, then the lease carries only templates, each value comes from the variable its name gives, and a header's variable is prefixed by its server", () => {
    // given
    const servers: TaskMcpServer[] = [
      { id: "mcp_a", name: "registry", transport: "stdio", command: "npx", args: ["registry-mcp"], env: ["api_key", "GITHUB_TOKEN"] },
      { id: "mcp_b", name: "payments-api", transport: "http", url: "https://payments.example.invalid/mcp", headers: ["Authorization", "X-Api-Key"] },
    ];
    const machineEnv = { API_KEY: "stand-in-one", GITHUB_TOKEN: "stand-in-two", PAYMENTS_API_AUTHORIZATION: "Bearer stand-in-three", PAYMENTS_API_X_API_KEY: "stand-in-four" };

    // when
    const lease = Object.fromEntries(servers.map((s) => [s.name, machineMcpServerOf(s)]));
    const filled = machineMcpServers(lease, machineEnv);

    // then
    expect(lease).toEqual({
      registry: { type: "stdio", command: "npx", args: ["registry-mcp"], env: { api_key: "${API_KEY}", GITHUB_TOKEN: "${GITHUB_TOKEN}" } },
      "payments-api": { type: "http", url: "https://payments.example.invalid/mcp", headers: { Authorization: "${PAYMENTS_API_AUTHORIZATION}", "X-Api-Key": "${PAYMENTS_API_X_API_KEY}" } },
    });
    expect(filled.notes).toEqual(["MCP server registry takes API_KEY, GITHUB_TOKEN from your environment.", "MCP server payments-api takes PAYMENTS_API_AUTHORIZATION, PAYMENTS_API_X_API_KEY from your environment."]);
    expect(filled.servers.registry).toMatchObject({ env: { api_key: "stand-in-one", GITHUB_TOKEN: "stand-in-two" } });
    expect(filled.servers["payments-api"]).toMatchObject({ headers: { Authorization: "Bearer stand-in-three", "X-Api-Key": "stand-in-four" } });
  });
});
