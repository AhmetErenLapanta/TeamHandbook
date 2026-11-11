import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MiddlewareHandler } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import type { OrchestratorContext } from "../app.js";
import type { OrchestratorEnv, Principal } from "../auth.js";
import { openSqliteStore } from "../store.js";
import { createVault, readSecret, vaultFor } from "../vault.js";
import { SLACK_WEBHOOK_SECRET } from "./slack.js";
import { closeStandIns, signedInServer } from "./mcp-stand-in.js";
import { atlassianServer, OAUTH_CALLBACK, toolWrites, userMcpForTask } from "./personal-mcp.js";

const SAM: Principal = { id: "u-sam", name: "Sam Member", email: "sam@example.invalid", role: "member", ownedTeams: [] };
const LIN: Principal = { id: "u-lin", name: "Lin Member", email: "lin@example.invalid", role: "member", ownedTeams: [] };
const PUBLIC_URL = "https://orchestrator.example.invalid";

afterEach(closeStandIns);

/** One orchestrator per test, as a running one is: who calls is set per request, the sign-ins under way stay. */
const apps = new WeakMap<OrchestratorContext, { app: ReturnType<typeof createApp>; who: { user: Principal } }>();

function appOf(ctx: OrchestratorContext) {
  let made = apps.get(ctx);
  if (!made) {
    const who = { user: SAM };
    const auth: MiddlewareHandler<OrchestratorEnv> = async (c, next) => {
      c.set("user", who.user);
      await next();
    };
    made = { app: createApp(ctx, auth), who };
    apps.set(ctx, made);
  }
  return made;
}

function orchestrator_(local = true): OrchestratorContext {
  return { store: openSqliteStore(":memory:"), dataDir: "unused", tenant: "acme", allowedHosts: null, vault: createVault(randomBytes(32)), publicUrl: PUBLIC_URL, localMcp: local };
}

function call(ctx: OrchestratorContext, user: Principal, method: string, path: string, body?: unknown) {
  const { app, who } = appOf(ctx);
  who.user = user;
  return app.request(path, { method, ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) });
}

/** Connect as the browser does: the orchestrator answers with the sign-in page's address and a cookie for this browser. */
async function connect(ctx: OrchestratorContext, user: Principal, name: string): Promise<{ authorizeUrl: string; cookie: string }> {
  const res = await call(ctx, user, "POST", `/api/me/mcp-servers/${name}/connect`);
  const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0]!;
  return { authorizeUrl: (await res.json()).authorizeUrl, cookie };
}

/** The browser's part of a sign-in: open the sign-in page, follow it back to the orchestrator's return address with the cookies it holds. */
async function signIn(ctx: OrchestratorContext, authorizeUrl: string, cookie: string): Promise<string> {
  const page = await fetch(authorizeUrl, { redirect: "manual" });
  const back = new URL(page.headers.get("location")!);
  expect(back.origin + back.pathname).toBe(`${PUBLIC_URL}${OAUTH_CALLBACK}`);
  const res = await appOf(ctx).app.request(back.pathname + back.search, { headers: cookie ? { cookie } : {} });
  return res.headers.get("location") ?? "";
}

async function connected(ctx: OrchestratorContext, base: string): Promise<void> {
  expect((await call(ctx, SAM, "POST", "/api/me/mcp-servers", { name: "tickets", description: "Our ticket desk", transport: "http", url: `${base}/mcp`, auth: "oauth" })).status).toBe(201);
  const { authorizeUrl, cookie } = await connect(ctx, SAM, "tickets");
  expect(await signIn(ctx, authorizeUrl, cookie)).toBe("/acme/integrations?connected=tickets");
}

describe("a person's own MCP server with a sign-in", () => {
  it("given a server that signs people in, when Sam connects it and picks a tool, then a task Sam starts gets it with the token in a variable the definition only names", async () => {
    // given
    const ctx = orchestrator_();
    const { base, state } = await signedInServer();
    await connected(ctx, base);

    // when
    const listed = await (await call(ctx, SAM, "GET", "/api/me/mcp-servers/tickets/tools")).json();
    await call(ctx, SAM, "PATCH", "/api/me/mcp-servers/tickets", { tools: ["get_ticket"] });
    const forTask = await userMcpForTask(ctx, SAM);

    // then
    expect(listed.tools.map((t: { name: string; writes: boolean; reads: boolean }) => [t.name, t.writes, t.reads])).toEqual([["get_ticket", false, true], ["close_ticket", true, false], ["ticket_summary", false, false], ["getAndArchive", true, false]]);
    expect(forTask).toEqual({
      servers: { tickets: { type: "http", url: `${base}/mcp`, headers: { Authorization: "Bearer ${TH_MCP_TICKETS}" } } },
      tools: [{ server: "tickets", tool: "get_ticket" }],
      secrets: { TH_MCP_TICKETS: state.access },
      notes: ["MCP server tickets, Sam Member's own, comes with Sam Member's own sign-in."],
    });
    const shown = await (await call(ctx, SAM, "GET", "/api/me/mcp-servers")).text();
    expect(shown).not.toContain(state.access);
    expect(shown).not.toContain(state.refresh);
    expect(await userMcpForTask(ctx, LIN)).toEqual({ servers: {}, tools: [], secrets: {}, notes: [] });
  });

  it("given an access token about to expire, when a task starts, then it is refreshed first and the task gets the new one", async () => {
    // given
    const ctx = orchestrator_();
    const { base, state } = await signedInServer({ expiresIn: 30 });
    await connected(ctx, base);
    await call(ctx, SAM, "PATCH", "/api/me/mcp-servers/tickets", { tools: ["get_ticket"] });
    const first = state.access;

    // when
    const forTask = await userMcpForTask(ctx, SAM);

    // then
    expect(state.issued).toBe(2);
    expect(forTask.secrets.TH_MCP_TICKETS).toBe(state.access);
    expect(forTask.secrets.TH_MCP_TICKETS).not.toBe(first);
  });

  it("given a sign-in that has lapsed and cannot be refreshed, when a task starts, then the server is left out with a note and the task gets nothing of it", async () => {
    // given
    const ctx = orchestrator_();
    const { base } = await signedInServer({ expiresIn: 30, refuseRefresh: true });
    await connected(ctx, base);
    await call(ctx, SAM, "PATCH", "/api/me/mcp-servers/tickets", { tools: ["get_ticket"] });

    // when
    const forTask = await userMcpForTask(ctx, SAM);

    // then
    expect(forTask).toEqual({ servers: {}, tools: [], secrets: {}, notes: ["Your MCP server tickets is left out: its sign-in has lapsed; connect it again under Integrations."] });
  });

  it("given a sign-in's return address used twice, or with a state nobody issued, when the browser arrives, then nothing is stored the second time or for the unknown state", async () => {
    // given
    const ctx = orchestrator_();
    const { base, state } = await signedInServer();
    await call(ctx, SAM, "POST", "/api/me/mcp-servers", { name: "tickets", description: "", transport: "http", url: `${base}/mcp`, auth: "oauth" });
    const { authorizeUrl, cookie } = await connect(ctx, SAM, "tickets");
    const back = new URL((await fetch(authorizeUrl, { redirect: "manual" })).headers.get("location")!);
    const returning = (path: string) => appOf(ctx).app.request(path, { headers: { cookie } });

    // when
    const first = await returning(back.pathname + back.search);
    const again = await returning(back.pathname + back.search);
    const forged = await returning(`${OAUTH_CALLBACK}?state=made-up&code=code-1`);

    // then
    expect(first.headers.get("location")).toBe("/acme/integrations?connected=tickets");
    expect(again.headers.get("location")).toMatch(/problem=That%20sign-in%20is%20unknown%20or%20expired/);
    expect(forged.headers.get("location")).toMatch(/problem=/);
    expect(state.issued).toBe(1);
  });

  it("given a second org on the orchestrator, when its sign-in returns, then the browser goes back to that org's Integrations", async () => {
    // given
    const ctx = { ...orchestrator_(), tenant: "globex", webBase: "/globex/" };
    const { base } = await signedInServer();
    await call(ctx, SAM, "POST", "/api/me/mcp-servers", { name: "tickets", description: "", transport: "http", url: `${base}/mcp`, auth: "oauth" });
    const { authorizeUrl, cookie } = await connect(ctx, SAM, "tickets");

    // when
    const landed = await signIn(ctx, authorizeUrl, cookie);

    // then
    expect(landed).toBe("/globex/integrations?connected=tickets");
  });

  it("given Sam's sign-in link opened and approved in Lin's browser, when the server sends Lin's browser back, then nothing is stored for Sam and Sam's server stays unconnected", async () => {
    // given
    const ctx = orchestrator_();
    const { base, state } = await signedInServer();
    await call(ctx, SAM, "POST", "/api/me/mcp-servers", { name: "tickets", description: "", transport: "http", url: `${base}/mcp`, auth: "oauth" });
    const { authorizeUrl } = await connect(ctx, SAM, "tickets");

    // when
    const landed = await signIn(ctx, authorizeUrl, "");

    // then
    expect(landed).toBe(`/acme/integrations?problem=${encodeURIComponent("That sign-in was begun in another browser; connect the server again from this one.")}`);
    expect(state.issued).toBe(0);
    expect((await (await call(ctx, SAM, "GET", "/api/me/mcp-servers")).json()).servers[0].credential).toMatchObject({ set: false });
  });

  it("given a team server by the same name at another address, when a task starts, then the person's server is left out for the team's", async () => {
    // given
    const ctx = orchestrator_();
    const { base } = await signedInServer();
    await connected(ctx, base);
    await call(ctx, SAM, "PATCH", "/api/me/mcp-servers/tickets", { tools: ["get_ticket"] });

    // when
    const forTask = await userMcpForTask(ctx, SAM, { tickets: { type: "http", url: "https://team.example.invalid/mcp" } });

    // then
    expect(forTask.servers).toEqual({});
    expect(forTask.notes).toEqual([
      "Your MCP server tickets is left out: the team repository declares a server by that name at another address.",
      "MCP server tickets needs a sign-in, and nobody connected it for this task; connect it under Integrations.",
    ]);
  });

  it("given a team server by the same name at the same address, when a task starts, then the team's definition goes to it with the person's own sign-in", async () => {
    // given
    const ctx = orchestrator_();
    const { base, state } = await signedInServer();
    await connected(ctx, base);
    await call(ctx, SAM, "PATCH", "/api/me/mcp-servers/tickets", { tools: ["get_ticket"] });
    const team = { tickets: { type: "http", url: `${base}/mcp/`, description: "The team's tickets" } };

    // when
    const forTask = await userMcpForTask(ctx, SAM, team);

    // then
    expect(forTask.servers).toEqual({ tickets: { type: "http", url: `${base}/mcp/`, description: "The team's tickets", headers: { Authorization: "Bearer ${TH_MCP_TICKETS}" } } });
    expect(forTask.secrets).toEqual({ TH_MCP_TICKETS: state.access });
    expect(forTask.notes).toEqual(["MCP server tickets, as the team declares it, comes with Sam Member's own sign-in."]);
  });
});

describe("which of a server's tools can change things", () => {
  it("given what servers say of their tools and the names of those that say nothing, when each is read, then a hint decides first, the name next, and a name that does not read as reading counts as writing", () => {
    // given
    const tools: [string, Parameters<typeof toolWrites>[1]][] = [
      ["getJiraIssue", undefined],
      ["searchJiraIssuesUsingJql", undefined],
      ["lookupJiraAccountId", undefined],
      ["createJiraIssue", undefined],
      ["transitionJiraIssue", undefined],
      ["atlassianUserInfo", undefined],
      ["addCommentToJiraIssue", { readOnlyHint: false }],
      ["atlassianUserInfo", { readOnlyHint: true }],
      ["getAndArchive", { readOnlyHint: true, destructiveHint: true }],
    ];

    // when
    const verdicts = tools.map(([name, hints]) => toolWrites(name, hints));

    // then
    expect(verdicts).toEqual([false, false, false, true, true, true, true, false, true]);
  });

  it("given names that start with a reading verb's letters but go on as another word, when each is read with no hint, then only a verb that ends at a separator, a digit or a capital reads", () => {
    // when
    const verdicts = ["lists_delete", "listing_update", "views_create", "Gets", "list_issues", "list-issues", "listIssues", "ListIssues", "get2", "list"].map((name) => toolWrites(name));

    // then
    expect(verdicts).toEqual([true, true, true, true, false, false, false, false, false, false]);
  });

  it("given Sam picks a reading tool and two writing ones of a loaded server, when a task starts, then all three reach it as picked and the page names the writing ones", async () => {
    // given
    const ctx = orchestrator_();
    const { base } = await signedInServer();
    await connected(ctx, base);
    await call(ctx, SAM, "GET", "/api/me/mcp-servers/tickets/tools");

    // when
    await call(ctx, SAM, "PATCH", "/api/me/mcp-servers/tickets", { tools: ["get_ticket", "close_ticket", "getAndArchive"] });
    const forTask = await userMcpForTask(ctx, SAM);
    const view = (await (await call(ctx, SAM, "GET", "/api/me/mcp-servers")).json()).servers[0];

    // then
    expect(forTask.tools.map((t) => t.tool)).toEqual(["close_ticket", "getAndArchive", "get_ticket"]);
    expect(view.writing).toEqual(["close_ticket", "getAndArchive"]);
  });
});

describe("what a person's own MCP server may be", () => {
  it("given addresses on a private network or this machine, when a member adds them on an orchestrator that keeps to public hosts, then each is refused and nothing is kept", async () => {
    // given
    const ctx = orchestrator_(false);
    const addresses = ["http://127.0.0.1:9/mcp", "https://10.0.0.5/mcp", "https://192.168.1.20/mcp", "https://169.254.169.254/mcp", "https://localhost/mcp", "http://tickets.example.invalid/mcp"];

    // when
    const statuses = await Promise.all(addresses.map(async (url, i) => (await call(ctx, SAM, "POST", "/api/me/mcp-servers", { name: `s${i}`, transport: "http", url, auth: "none" })).status));

    // then
    expect(statuses).toEqual(addresses.map(() => 400));
    expect((await (await call(ctx, SAM, "GET", "/api/me/mcp-servers")).json()).servers).toEqual([]);
  });

  it("given a server with a static token, when it is read back and given to a task, then the token is in the task's secrets and nowhere on the page", async () => {
    // given
    const ctx = orchestrator_(false);
    const token = "tok_stand_in_0123456789";
    await call(ctx, SAM, "POST", "/api/me/mcp-servers", { name: "wiki", transport: "http", url: "https://wiki.example.invalid/mcp", auth: "token", token });
    await call(ctx, SAM, "PATCH", "/api/me/mcp-servers/wiki", { tools: ["search"] });

    // when
    const page = await (await call(ctx, SAM, "GET", "/api/me/mcp-servers")).text();
    const forTask = await userMcpForTask(ctx, SAM);

    // then
    expect(page).not.toContain(token);
    expect(JSON.parse(page).servers[0].credential).toMatchObject({ set: true });
    expect(forTask.servers.wiki).toEqual({ type: "http", url: "https://wiki.example.invalid/mcp", headers: { Authorization: "Bearer ${TH_MCP_WIKI}" } });
    expect(forTask.secrets).toEqual({ TH_MCP_WIKI: token });
  });

  it("given a command that carries a literal secret in its arguments, when it is added, then it is refused by the share rule", async () => {
    // given
    const ctx = orchestrator_(false);

    // when
    const res = await call(ctx, SAM, "POST", "/api/me/mcp-servers", { name: "db", transport: "stdio", command: "npx", args: ["db-mcp", "--token", "ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789"], auth: "none" });

    // then
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/^this server is not taken as written/);
  });
});

describe("Jira in one step from Integrations", () => {
  afterEach(() => {
    delete process.env.ORCHESTRATOR_ATLASSIAN_MCP_URL;
  });

  it("given Atlassian's server standing in, when Sam signs in with Atlassian and presses it again, then the server is Sam's own with its reading tools alone, signed in, and no second one is added", async () => {
    // given
    const ctx = orchestrator_();
    const { base } = await signedInServer();
    process.env.ORCHESTRATOR_ATLASSIAN_MCP_URL = `${base}/mcp`;

    // when
    const res = await call(ctx, SAM, "POST", "/api/integrations/jira/sign-in");
    const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0]!;
    const back = await signIn(ctx, (await res.json()).authorizeUrl, cookie);
    const again = await call(ctx, SAM, "POST", "/api/integrations/jira/sign-in");
    const { servers } = await (await call(ctx, SAM, "GET", "/api/me/mcp-servers")).json();
    const card = await atlassianServer(ctx, SAM.id);

    // then
    expect(back).toBe("/acme/integrations?connected=atlassian");
    expect(again.status).toBe(200);
    expect(servers.map((s: { name: string; url: string; auth: string; tools: string[]; writing: string[] }) => [s.name, s.url, s.auth, s.tools, s.writing])).toEqual([
      ["atlassian", `${base}/mcp`, "oauth", ["getAccessibleAtlassianResources", "getVisibleJiraProjects", "searchJiraIssuesUsingJql", "getJiraIssue"], []],
    ]);
    expect(card).toEqual({ name: "atlassian", connected: true });
  });

  it("given one person's own orchestrator with no public address set, when they sign in with Atlassian, then the sign-in returns to the address their browser reached it at", async () => {
    // given
    const ctx: OrchestratorContext = { ...orchestrator_(), publicUrl: undefined };
    const { base } = await signedInServer();
    process.env.ORCHESTRATOR_ATLASSIAN_MCP_URL = `${base}/mcp`;
    process.env.ORCHESTRATOR_MODE = "local";

    // when
    const res = await call(ctx, SAM, "POST", "/api/integrations/jira/sign-in");

    // then
    delete process.env.ORCHESTRATOR_MODE;
    expect(res.status).toBe(200);
    expect(new URL((await res.json()).authorizeUrl).searchParams.get("redirect_uri")).toBe(`http://localhost${OAUTH_CALLBACK}`);
  });

  it("given a team's orchestrator with no public address set, when someone signs in with Atlassian, then it says which setting to set", async () => {
    // given
    const ctx: OrchestratorContext = { ...orchestrator_(), publicUrl: undefined };
    const { base } = await signedInServer();
    process.env.ORCHESTRATOR_ATLASSIAN_MCP_URL = `${base}/mcp`;
    process.env.ORCHESTRATOR_MODE = "self-hosted";

    // when
    const res = await call(ctx, SAM, "POST", "/api/integrations/jira/sign-in");

    // then
    delete process.env.ORCHESTRATOR_MODE;
    expect([res.status, (await res.json()).error]).toEqual([409, "set ORCHESTRATOR_PUBLIC_URL to the address this orchestrator is reached at; a sign-in returns there"]);
  });

  it("given a server of Sam's already named atlassian at another address, when Sam signs in with Atlassian, then it is refused with what to do and nothing is changed", async () => {
    // given
    const ctx = orchestrator_();
    const { base } = await signedInServer();
    process.env.ORCHESTRATOR_ATLASSIAN_MCP_URL = `${base}/mcp`;
    await call(ctx, SAM, "POST", "/api/me/mcp-servers", { name: "atlassian", transport: "http", url: `${base}/other`, auth: "oauth" });

    // when
    const res = await call(ctx, SAM, "POST", "/api/integrations/jira/sign-in");

    // then
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/^You already have a server named atlassian at another address\. Remove it under Your MCP servers/);
    expect(await atlassianServer(ctx, SAM.id)).toBeNull();
  });

  it("given Linear's server standing in, when Sam signs in with Linear from the catalogue, then it is Sam's own server, signed in, with only the tools both the server and the name say read, the service's own prefix read past, a read-only-marked ticket_summary left off", async () => {
    // given
    const ctx = orchestrator_();
    const { base } = await signedInServer({ tools: [{ name: "get_ticket", description: "Reads a ticket" }, { name: "close_ticket", description: "Closes a ticket" }, { name: "ticket_summary", description: "Sums up a ticket", annotations: { readOnlyHint: true } }, { name: "linear_list_issues", description: "Lists issues", annotations: { readOnlyHint: true } }, { name: "linear_create_issue", description: "Creates an issue" }] });
    process.env.ORCHESTRATOR_CATALOG_LINEAR_URL = `${base}/mcp`;

    // when
    const res = await call(ctx, SAM, "POST", "/api/integrations/catalog/linear/sign-in");
    const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0]!;
    const back = await signIn(ctx, (await res.json()).authorizeUrl, cookie);
    const unknown = await call(ctx, SAM, "POST", "/api/integrations/catalog/nowhere/sign-in");

    // then
    delete process.env.ORCHESTRATOR_CATALOG_LINEAR_URL;
    expect(back).toBe("/acme/integrations?connected=linear");
    const { servers } = await (await call(ctx, SAM, "GET", "/api/me/mcp-servers")).json();
    expect(servers.map((s: { name: string; tools: string[]; writing: string[] }) => [s.name, s.tools, s.writing])).toEqual([["linear", ["get_ticket", "linear_list_issues"], []]]);
    expect(unknown.status).toBe(404);
  });
});


describe("the client the orchestrator registers with a server's sign-in", () => {
  const registrations = (state: { calls: string[] }) => state.calls.filter((c) => c === "POST /register").length;

  it("given Sam signed in to a server once, when Sam connects it again, then the client registered the first time signs in and nothing is registered again", async () => {
    // given
    const ctx = orchestrator_();
    const { base, state } = await signedInServer();
    await connected(ctx, base);

    // when
    const { authorizeUrl, cookie } = await connect(ctx, SAM, "tickets");
    const back = await signIn(ctx, authorizeUrl, cookie);

    // then
    expect(back).toBe("/acme/integrations?connected=tickets");
    expect(registrations(state)).toBe(1);
    expect(new URL(authorizeUrl).searchParams.get("client_id")).toBe(state.clientId);
  });

  it("given a server that has forgotten the kept client, when Sam signs in, then the sign-in says the server refused it, and the next connect registers a new client and signs in", async () => {
    // given
    const ctx = orchestrator_();
    const { base, state } = await signedInServer();
    await connected(ctx, base);
    state.clientId = "client-forgotten";

    // when
    const refused = await connect(ctx, SAM, "tickets");
    const first = await signIn(ctx, refused.authorizeUrl, refused.cookie);
    const again = await connect(ctx, SAM, "tickets");
    const second = await signIn(ctx, again.authorizeUrl, again.cookie);

    // then
    expect(decodeURIComponent(first)).toContain("problem=the server's sign-in refused (401: invalid_client)");
    expect(second).toBe("/acme/integrations?connected=tickets");
    expect(registrations(state)).toBe(2);
  });

  it("given a sign-in begun with the kept client and never finished, when Sam connects again, then a new client is registered, since a server that forgot one never sends the browser back", async () => {
    // given
    const ctx = orchestrator_();
    const { base, state } = await signedInServer();
    await connected(ctx, base);
    await connect(ctx, SAM, "tickets");

    // when
    const { authorizeUrl, cookie } = await connect(ctx, SAM, "tickets");
    const back = await signIn(ctx, authorizeUrl, cookie);

    // then
    expect(registrations(state)).toBe(2);
    expect(back).toBe("/acme/integrations?connected=tickets");
  });
});

describe("GitLab's own MCP server, signed in from the GitLab card", () => {
  it("given the organization's GitLab, when Sam signs in with GitLab, then GitLab's MCP server at that GitLab's own address becomes Sam's, allowed only its reading tools, whatever the request names", async () => {
    // given
    const { base } = await signedInServer({ path: "/api/v4/mcp" });
    const ctx: OrchestratorContext = { ...orchestrator_(), forgeApps: { gitlab: { kind: "gitlab", webUrl: base, apiUrl: `${base}/api/v4`, clientId: "operator-app", clientSecret: "operator-secret" } } };

    // when
    const res = await call(ctx, SAM, "POST", "/api/integrations/gitlab/sign-in", { url: "https://elsewhere.example/mcp" });
    const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0]!;
    const back = await signIn(ctx, (await res.json()).authorizeUrl, cookie);
    const servers = (await (await call(ctx, SAM, "GET", "/api/me/mcp-servers")).json()).servers;

    // then
    expect(back).toBe("/acme/integrations?connected=gitlab");
    expect(servers.map((s: { name: string; url: string; tools: string[] }) => [s.name, s.url, s.tools])).toEqual([["gitlab", `${base}/api/v4/mcp`, ["get_ticket"]]]);
  });
});

describe("a sign-in kept in the data folder", () => {
  it("given Sam signed in on an orchestrator that keeps its data in a folder, when it is stopped and started again on the same folder, then Sam is still signed in, the server and its tools are theirs, and a task gets the same token", async () => {
    // given
    const dir = mkdtempSync(join(tmpdir(), "orchestrator-restart-"));
    const start = () => {
      const sealing = vaultFor({}, dir, true);
      return { store: openSqliteStore(join(dir, "orchestrator.db")), dataDir: dir, tenant: "acme", allowedHosts: null, vault: sealing.vault, publicUrl: PUBLIC_URL, localMcp: true } as OrchestratorContext;
    };
    const { base, state } = await signedInServer();
    const first = start();
    await connected(first, base);
    await call(first, SAM, "PATCH", "/api/me/mcp-servers/tickets", { tools: ["get_ticket"] });
    await first.store.close();

    // when
    const second = start();

    // then
    const servers = (await (await call(second, SAM, "GET", "/api/me/mcp-servers")).json()).servers;
    expect(servers.map((s: { name: string; tools: string[]; credential: { set: boolean } }) => [s.name, s.tools, s.credential.set])).toEqual([["tickets", ["get_ticket"], true]]);
    expect((await userMcpForTask(second, SAM)).secrets).toEqual({ TH_MCP_TICKETS: state.access });
    await second.store.close();
  });
});

const ADA: Principal = { id: "u-ada", name: "Ada Admin", email: "ada@example.invalid", role: "admin", ownedTeams: [] };

/** Slack on no network: its approval screen sends the browser back with a code, and the code buys a channel's webhook address and a token the orchestrator does not keep. */
async function slackStandIn() {
  const seen = { exchanged: [] as URLSearchParams[] };
  const server: Server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const url = new URL(req.url!, `http://${req.headers.host}`);
      if (url.pathname === "/oauth/v2/authorize") {
        const back = new URL(url.searchParams.get("redirect_uri")!);
        back.searchParams.set("code", "slack-code");
        back.searchParams.set("state", url.searchParams.get("state")!);
        res.writeHead(302, { location: back.toString() });
        return res.end();
      }
      const form = new URLSearchParams(raw);
      seen.exchanged.push(form);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(form.get("code") === "slack-code" && form.get("client_secret") === "slack-app-secret" ? { ok: true, access_token: "xoxb-not-kept", incoming_webhook: { url: `http://127.0.0.1:${(server.address() as { port: number }).port}/services/T1/B1/hook`, channel: "#builds" } } : { ok: false, error: "invalid_code" }));
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  process.env.ORCHESTRATOR_SLACK_URL = base;
  process.env.ORCHESTRATOR_SLACK_CLIENT_ID = "slack-app-id";
  process.env.ORCHESTRATOR_SLACK_CLIENT_SECRET = "slack-app-secret";
  return { base, seen, stop: () => server.close() };
}

describe("Add to Slack", () => {
  // A team's orchestrator: with no mode set the default is local, where the cards ask the machine's gh and glab.
  beforeEach(() => {
    process.env.ORCHESTRATOR_MODE = "self-hosted";
  });

  afterEach(() => {
    delete process.env.ORCHESTRATOR_MODE;
    delete process.env.ORCHESTRATOR_SLACK_URL;
    delete process.env.ORCHESTRATOR_SLACK_CLIENT_ID;
    delete process.env.ORCHESTRATOR_SLACK_CLIENT_SECRET;
  });

  it("given a Slack app set up by whoever runs the orchestrator, when an admin adds Slack and approves it there, then the channel's webhook address is sealed, every event is posted, the token Slack also names is not kept, and a member cannot start it", async () => {
    // given
    const ctx = orchestrator_();
    const slack = await slackStandIn();
    const before = (await (await call(ctx, ADA, "GET", "/api/integrations")).json()).integrations.find((c: { id: string }) => c.id === "slack");

    // when
    const member = await call(ctx, SAM, "POST", "/api/integrations/slack/add");
    const res = await call(ctx, ADA, "POST", "/api/integrations/slack/add");
    const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0]!;
    const back = await signIn(ctx, (await res.json()).authorizeUrl, cookie);
    const after = await (await call(ctx, ADA, "GET", "/api/integrations")).text();

    // then
    slack.stop();
    expect(before).toMatchObject({ state: "off", addable: true, redirectUri: `${PUBLIC_URL}${OAUTH_CALLBACK}` });
    expect(member.status).toBe(403);
    expect(back).toBe("/acme/integrations?slack=added");
    expect(slack.seen.exchanged[0]!.get("redirect_uri")).toBe(`${PUBLIC_URL}${OAUTH_CALLBACK}`);
    expect(await readSecret(ctx.store, ctx.vault!, "acme", SLACK_WEBHOOK_SECRET)).toBe(`${slack.base}/services/T1/B1/hook`);
    const card = JSON.parse(after).integrations.find((c: { id: string }) => c.id === "slack");
    expect(card).toMatchObject({ state: "connected", enabledBy: "Ada Admin" });
    expect(card.events).toHaveLength(7);
    expect(after).not.toContain("xoxb-not-kept");
    expect(after).not.toContain("/services/T1/B1/hook");
  });

  it("given Slack refusing the code, or no Slack app set, when an admin adds Slack, then Slack stays off and the answer says what to do", async () => {
    // given
    const ctx = orchestrator_();
    const unset = await call(ctx, ADA, "POST", "/api/integrations/slack/add");
    const slack = await slackStandIn();
    slack.seen.exchanged.length = 0;
    process.env.ORCHESTRATOR_SLACK_CLIENT_SECRET = "a-wrong-secret";

    // when
    const res = await call(ctx, ADA, "POST", "/api/integrations/slack/add");
    const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0]!;
    const back = await signIn(ctx, (await res.json()).authorizeUrl, cookie);

    // then
    slack.stop();
    expect(unset.status).toBe(409);
    expect((await unset.json()).error).toContain("ORCHESTRATOR_SLACK_CLIENT_ID");
    expect(decodeURIComponent(back)).toBe("/acme/integrations?slackProblem=Slack refused to add the orchestrator (invalid_code)");
    expect((await (await call(ctx, ADA, "GET", "/api/integrations")).json()).integrations.find((c: { id: string }) => c.id === "slack").state).toBe("off");
  });
});
