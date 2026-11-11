import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { MiddlewareHandler } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { createApp, mirrorDir } from "../app.js";
import type { OrchestratorContext } from "../app.js";
import type { OrchestratorEnv, Principal } from "../auth.js";
import { openSqliteStore } from "../store.js";
import { createVault } from "../vault.js";
import { closeStandIns, signedInServer } from "./mcp-stand-in.js";
import { userMcpForTask } from "./personal-mcp.js";

const ADA: Principal = { id: "u-ada", name: "Ada Admin", email: "ada@example.invalid", role: "admin", ownedTeams: [] };
const SAM: Principal = { id: "u-sam", name: "Sam Member", email: "sam@example.invalid", role: "member", ownedTeams: ["Payments"] };
const PUBLIC_URL = "https://orchestrator.example.invalid";

const dirs: string[] = [];
afterEach(async () => {
  await closeStandIns();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** An orchestrator with one team repository whose .mcp.json declares `tickets` at the stand-in's address, sending no credential. */
async function orchestrator_(url: string): Promise<{ ctx: OrchestratorContext; team: Record<string, unknown> }> {
  const root = mkdtempSync(join(tmpdir(), "orchestrator-team-mcp-"));
  dirs.push(root);
  const work = join(root, "work");
  mkdirSync(work);
  const team = { tickets: { type: "http", url } };
  writeFileSync(join(work, ".mcp.json"), JSON.stringify({ mcpServers: team }));
  const env = { PATH: process.env.PATH, HOME: work, GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" };
  for (const args of [["init", "-q", "-b", "main"], ["add", "-A"], ["commit", "-q", "-m", "team"]]) execFileSync("git", args, { cwd: work, env });
  const ctx: OrchestratorContext = { store: openSqliteStore(":memory:"), dataDir: join(root, "data"), tenant: "acme", allowedHosts: null, vault: createVault(randomBytes(32)), publicUrl: PUBLIC_URL, localMcp: true };
  const mirror = mirrorDir(ctx, "payments-skills");
  mkdirSync(dirname(mirror), { recursive: true });
  execFileSync("git", ["clone", "-q", "--mirror", work, mirror], { env });
  await ctx.store.upsertRepo({ tenant: "acme", id: "payments-skills", team: "Payments", name: "payments-skills", url: `file://${work}` });
  await ctx.store.recordSync("acme", "payments-skills", { head: execFileSync("git", ["rev-parse", "main"], { cwd: work, encoding: "utf8" }).trim() });
  return { ctx, team };
}

/** One app per orchestrator, as a running one is, so a sign-in begun is the one its return finishes. */
const apps = new WeakMap<OrchestratorContext, { app: ReturnType<typeof createApp>; who: { user: Principal } }>();
function call(ctx: OrchestratorContext, user: Principal, method: string, path: string, body?: unknown, cookie?: string) {
  let made = apps.get(ctx);
  if (!made) {
    const who = { user };
    const auth: MiddlewareHandler<OrchestratorEnv> = async (c, next) => {
      c.set("user", who.user);
      await next();
    };
    made = { app: createApp(ctx, auth), who };
    apps.set(ctx, made);
  }
  made.who.user = user;
  const headers: Record<string, string> = { ...(body === undefined ? {} : { "content-type": "application/json" }), ...(cookie ? { cookie } : {}) };
  return made.app.request(path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}

/** The browser's part: start a sign-in, approve it at the stand-in, come back with the cookie the start set. */
async function signIn(ctx: OrchestratorContext, user: Principal, start: string): Promise<string> {
  const res = await call(ctx, user, "POST", start);
  const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0]!;
  const back = new URL((await fetch((await res.json()).authorizeUrl, { redirect: "manual" })).headers.get("location")!);
  return (await call(ctx, user, "GET", back.pathname + back.search, undefined, cookie)).headers.get("location") ?? "";
}

describe("a team's server that signs people in, in the tasks people start", () => {
  it("given a team repository declaring a server with no credential, when anyone lists the team's servers, then it is there with the repository, connected for nobody", async () => {
    // given
    const { base } = await signedInServer();
    const { ctx } = await orchestrator_(`${base}/mcp`);

    // when
    const listed = await (await call(ctx, SAM, "GET", "/api/team-mcp-servers")).json();

    // then
    expect(listed.canManage).toBe(false);
    expect(listed.servers).toEqual([expect.objectContaining({ name: "tickets", url: `${base}/mcp`, repos: [{ id: "payments-skills", name: "payments-skills", team: "Payments" }], everyone: null, mine: null })]);
  });

  it("given nobody connected it, when Sam starts a task, then the log says it needs a sign-in, and the server gets no credential", async () => {
    // given
    const { base } = await signedInServer();
    const { ctx, team } = await orchestrator_(`${base}/mcp`);

    // when
    const forTask = await userMcpForTask(ctx, SAM, team);

    // then
    expect(forTask.servers).toEqual({});
    expect(forTask.notes).toEqual(["MCP server tickets needs a sign-in, and nobody connected it for this task; connect it under Integrations."]);
  });

  it("given an admin connected it for everyone's tasks and allowed a tool, when Sam starts a task, then it comes with the organization's sign-in, naming who connected it", async () => {
    // given
    const { base, state } = await signedInServer();
    const { ctx, team } = await orchestrator_(`${base}/mcp`);
    const { servers } = await (await call(ctx, ADA, "GET", "/api/team-mcp-servers")).json();
    const key = servers[0].key;
    expect(await signIn(ctx, ADA, `/api/team-mcp-servers/${key}/connect`)).toBe("/acme/integrations?connected=tickets");
    await call(ctx, ADA, "PATCH", `/api/team-mcp-servers/${key}`, { tools: ["get_ticket"] });

    // when
    const forTask = await userMcpForTask(ctx, SAM, team);

    // then
    expect(forTask.servers).toEqual({ tickets: { type: "http", url: `${base}/mcp`, headers: { Authorization: "Bearer ${TH_MCP_TICKETS}" } } });
    expect(forTask.secrets).toEqual({ TH_MCP_TICKETS: state.access });
    expect(forTask.tools).toEqual([{ server: "tickets", tool: "get_ticket" }]);
    expect(forTask.notes).toEqual(["MCP server tickets, as the team declares it, comes with the organization's sign-in, connected by Ada Admin."]);
    const listed = await (await call(ctx, SAM, "GET", "/api/team-mcp-servers")).json();
    expect(listed.servers[0].everyone).toMatchObject({ by: "Ada Admin", tools: ["get_ticket"] });
    expect(JSON.stringify(listed)).not.toContain(state.access);
  });

  it("given the organization's sign-in and Sam's own at the same address, when Sam starts a task, then Sam's own is used", async () => {
    // given
    const { base } = await signedInServer();
    const { ctx, team } = await orchestrator_(`${base}/mcp`);
    const key = (await (await call(ctx, ADA, "GET", "/api/team-mcp-servers")).json()).servers[0].key;
    await signIn(ctx, ADA, `/api/team-mcp-servers/${key}/connect`);
    await call(ctx, SAM, "POST", "/api/me/mcp-servers", { name: "tickets", transport: "http", url: `${base}/mcp`, auth: "oauth" });
    await signIn(ctx, SAM, "/api/me/mcp-servers/tickets/connect");
    await call(ctx, SAM, "PATCH", "/api/me/mcp-servers/tickets", { tools: ["get_ticket"] });

    // when
    const forTask = await userMcpForTask(ctx, SAM, team);

    // then
    expect(forTask.notes).toEqual(["MCP server tickets, as the team declares it, comes with Sam Member's own sign-in."]);
  });

  it("given a member, when they connect a team's server for everyone's tasks or change its tools, then they are refused and nothing is stored", async () => {
    // given
    const { base } = await signedInServer();
    const { ctx, team } = await orchestrator_(`${base}/mcp`);
    const key = (await (await call(ctx, SAM, "GET", "/api/team-mcp-servers")).json()).servers[0].key;

    // when
    const connect = await call(ctx, SAM, "POST", `/api/team-mcp-servers/${key}/connect`);
    const tools = await call(ctx, SAM, "PATCH", `/api/team-mcp-servers/${key}`, { tools: ["close_ticket"] });

    // then
    expect([connect.status, tools.status]).toEqual([403, 403]);
    expect((await userMcpForTask(ctx, SAM, team)).servers).toEqual({});
  });

  it("given the organization's sign-in, when an admin disconnects it, then tasks are back to needing one", async () => {
    // given
    const { base } = await signedInServer();
    const { ctx, team } = await orchestrator_(`${base}/mcp`);
    const key = (await (await call(ctx, ADA, "GET", "/api/team-mcp-servers")).json()).servers[0].key;
    await signIn(ctx, ADA, `/api/team-mcp-servers/${key}/connect`);

    // when
    await call(ctx, ADA, "DELETE", `/api/team-mcp-servers/${key}/connection`);
    const forTask = await userMcpForTask(ctx, SAM, team);

    // then
    expect(forTask.servers).toEqual({});
    expect(forTask.notes[0]).toMatch(/needs a sign-in, and nobody connected it/);
  });
});
