import { randomBytes } from "node:crypto";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { OrchestratorContext } from "../app.js";
import type { OrchestratorEnv, Principal } from "../auth.js";
import { openSqliteStore } from "../store.js";
import { createVault } from "../vault.js";
import { WorkCache } from "./cache.js";
import { mcpJiraProvider, READ_TOOLS, WRITE_TOOLS } from "./mcp-jira.js";
import { workRoutes } from "./routes.js";
import { saveWrites } from "./writes.js";

const SAM: Principal = { id: "u-sam", name: "Sam Member", email: "sam@example.invalid", role: "member", ownedTeams: [] };
const PAT: Principal = { id: "u-pat", name: "Pat Owner", email: "pat@example.invalid", role: "member", ownedTeams: ["Payments"] };
const CLOUD = "11111111-2222-3333-4444-555555555555";
const SITE = "https://acme.atlassian.example";
const MCP = "https://mcp.atlassian.example/mcp";

const SPRINT = { id: 34, name: "Sprint 34", state: "active", startDate: "2026-11-01T00:00:00.000Z", endDate: "2026-11-14T00:00:00.000Z", goal: "Refunds" };
const ISSUES = [
  { key: "PAY-142", fields: { summary: "Round refunds half to even", status: { name: "In Dev", statusCategory: { key: "indeterminate" } }, issuetype: { name: "Story" }, labels: [], customfield_10020: [SPRINT] } },
  { key: "PAY-143", fields: { summary: "Ledger export", status: { name: "Ready for Dev", statusCategory: { key: "new" } }, issuetype: { name: "Task" }, labels: [], customfield_10020: [SPRINT, { id: 35, name: "Sprint 35", state: "future" }] } },
];

/** An issue done last month: no open work is in Done today, yet the board still has its column. */
const DONE_LATELY = [{ key: "PAY-120", fields: { summary: "Statement export", status: { name: "Done", statusCategory: { key: "done" } }, issuetype: { name: "Story" }, labels: [] } }];

/** A project with no sprints, read as a Kanban board: a story Sam has, a bug nobody has, and what Jira leaves out of a board, its epic. */
const KANBAN = [
  { key: "PAY-150", fields: { summary: "Show the refund's reason", status: { name: "In Development", statusCategory: { key: "indeterminate" } }, issuetype: { name: "Story" }, assignee: { displayName: "Sam Member" }, labels: [], parent: { key: "PAY-100", fields: { summary: "Refund accuracy", issuetype: { name: "Epic", hierarchyLevel: 1 } } } } },
  { key: "PAY-151", fields: { summary: "The refund total rounds down", status: { name: "Ready for Development", statusCategory: { key: "new" } }, issuetype: { name: "Bug" }, assignee: null, labels: [] } },
];

/** Atlassian's remote MCP server on no network: the tools the orchestrator calls, and every search it was sent. */
function atlassian() {
  const searches: string[] = [];
  const called: string[] = [];
  const send = (async (_input: string | URL, init?: RequestInit) => {
    const message = JSON.parse(String(init?.body));
    if (message.id === undefined) return new Response(null, { status: 202 });
    const result = (value: unknown) => new Response(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: value }), { headers: { "content-type": "application/json" } });
    if (message.method === "initialize") return result({ protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "atlassian", version: "1" } });
    const { name, arguments: args } = message.params as { name: string; arguments: { jql?: string } };
    called.push(name);
    const text = (value: unknown) => result({ content: [{ type: "text", text: JSON.stringify(value) }] });
    if (name === "getAccessibleAtlassianResources") return text([{ id: CLOUD, url: SITE, name: "acme" }]);
    if (name === "getVisibleJiraProjects") return text({ values: [{ key: "PAY", name: "Payments" }] });
    if (name === "searchJiraIssuesUsingJql") {
      searches.push(args.jql!);
      // Jira answers "assigned to me" for whoever the server signed in; here that is Sam.
      const mine = <T extends { fields: object }>(issues: T[]) => (args.jql!.includes("assignee = currentUser()") ? issues.filter((i) => (i.fields as { assignee?: { displayName?: string } | null }).assignee?.displayName === "Sam Member") : issues);
      if (args.jql!.includes("statusCategoryChangedDate >= -14d") && !args.jql!.includes("sprint")) return text({ issues: mine(KANBAN), isLast: true });
      if (args.jql!.includes("updated >= -90d")) return text({ issues: [...ISSUES, ...DONE_LATELY], isLast: true });
      return text({ issues: args.jql!.includes("sprint = 34") || args.jql!.includes("openSprints") ? mine(ISSUES) : [], isLast: true });
    }
    return result({ isError: true, content: [] });
  }) as typeof fetch;
  return { searches, send, called };
}

/** `writes` lets the orchestrator change issues, as an owner does under Integrations; off is the orchestrator's default. */
function orchestrator_(writes = true) {
  const ctx: OrchestratorContext = { store: openSqliteStore(":memory:"), dataDir: "unused", tenant: "acme", vault: createVault(randomBytes(32)) };
  const ready = writes ? saveWrites(ctx, true) : Promise.resolve();
  const fake = atlassian();
  const who = { user: SAM };
  const app = new Hono<OrchestratorEnv>();
  app.use(async (c, next) => {
    c.set("user", who.user);
    await next();
  });
  app.route("/", workRoutes(ctx, { cache: new WorkCache(), send: fake.send }));
  const call = async (user: Principal, path: string, init?: RequestInit) => {
    await ready;
    who.user = user;
    const res = await app.request(path, init);
    return { status: res.status, body: await res.json() };
  };
  const connect = (user: Principal, tools: string[] = ["getJiraIssue", ...READ_TOOLS]) => ctx.store.setSetting(ctx.tenant, `mcp.personal.${user.id}`, JSON.stringify([{ name: "atlassian", description: "", transport: "http", url: MCP, auth: "none", tools, addedAt: "2026-11-01T00:00:00.000Z" }]));
  return { call, connect, searches: fake.searches, called: fake.called };
}

describe("Jira through a person's own Atlassian MCP server", () => {
  it("given Sam's server allowed to read Jira, when Sam opens the project's board, then its sprints come from the issues and its columns from every status of the project's last three months, done ones too, in Jira's order", async () => {
    // given
    const { call, connect, searches } = orchestrator_();
    await connect(SAM);

    // when
    const boards = await call(SAM, "/api/work/boards?source=mcp:atlassian");
    const board = boards.body.boards[0].id;
    const sprints = await call(SAM, `/api/work/sprints?board=${encodeURIComponent(board)}`);
    const items = await call(SAM, `/api/work/items?sprint=${encodeURIComponent(sprints.body.sprints[0].id)}`);

    // then
    expect(boards.body.boards).toEqual([{ id: `mcp:atlassian~${CLOUD}.PAY`, name: "Payments", type: "project", project: "PAY", url: `${SITE}/browse/PAY`, team: null }]);
    expect(sprints.body.sprints.map((s: { id: string; state: string }) => [s.id, s.state])).toEqual([[`mcp:atlassian~${CLOUD}.PAY~34`, "active"], [`mcp:atlassian~${CLOUD}.PAY~35`, "future"]]);
    expect(items.body.columns).toEqual([{ name: "Ready for Dev", statuses: ["Ready for Dev"] }, { name: "In Dev", statuses: ["In Dev"] }, { name: "Done", statuses: ["Done"] }]);
    expect(items.body.items.map((i: { key: string; url: string; column: string }) => [i.key, i.url, i.column])).toEqual([["PAY-142", `${SITE}/browse/PAY-142`, "In Dev"], ["PAY-143", `${SITE}/browse/PAY-143`, "Ready for Dev"]]);
    expect(searches).toContain('project = "PAY" AND issuetype != Epic AND sprint = 34 ORDER BY rank');
  });

  it("given Sam's board, when Pat, who has no such server, sends its id back, then it is unknown and the server is not asked", async () => {
    // given
    const { call, connect, searches } = orchestrator_();
    await connect(SAM);
    const board = (await call(SAM, "/api/work/boards?source=mcp:atlassian")).body.boards[0].id;
    const before = searches.length;

    // when
    const asked = await call(PAT, `/api/work/items?backlog=${encodeURIComponent(board)}`);

    // then
    expect(asked.status).toBe(404);
    expect(searches.length).toBe(before);
  });

  it("given a board id carrying JQL, when it is sent back, then it is unknown and no query is made", async () => {
    // given
    const { call, connect, searches } = orchestrator_();
    await connect(SAM);

    // when
    const asked = await call(SAM, `/api/work/items?backlog=${encodeURIComponent(`mcp:atlassian~${CLOUD}.PAY" OR project != "X`)}`);

    // then
    expect(asked.status).toBe(404);
    expect(searches).toEqual([]);
  });

  it("given project keys in their shape and ones carrying JQL, when the provider checks them, then only the shape passes, before any list is read", () => {
    // given
    const provider = mcpJiraProvider({ name: "atlassian", url: MCP, tools: [] }, undefined, async (_key, load) => load(), atlassian().send);

    // when
    const checked = [`${CLOUD}.PAY`, `${CLOUD}.PAY" OR project != "X`, `${CLOUD}.pay`, "PAY"].map((b) => provider.boardPattern.test(b));

    // then
    expect(checked).toEqual([true, false, false, false]);
  });

  it("given Sam's server with and without the tools that move an issue, when Sam lists sources, then it moves issues only with them, and says which tool is not allowed", async () => {
    // given
    const { call, connect } = orchestrator_();

    // when
    await connect(SAM, ["getJiraIssue", ...READ_TOOLS, "getTransitionsForJiraIssue"]);
    const without = (await call(SAM, "/api/work/sources")).body.sources[0];
    await connect(SAM, ["getJiraIssue", ...READ_TOOLS, ...WRITE_TOOLS]);
    const withThem = (await call(SAM, "/api/work/sources")).body.sources[0];
    await connect(SAM, ["getJiraIssue"]);
    const unread = (await call(SAM, "/api/work/sources")).body.sources[0];

    // then
    expect([without.can.write, without.writeProblem]).toEqual([false, "Your atlassian server does not allow transitionJiraIssue"]);
    expect([withThem.can.write, withThem.writeProblem, withThem.problem]).toEqual([true, null, null]);
    expect(unread.problem).toBe("Your atlassian server does not allow getAccessibleAtlassianResources or getVisibleJiraProjects or searchJiraIssuesUsingJql");
  });

  it("given Sam's server allowed to move issues but changing issues off, when Sam moves an issue by hand on the board, then it is refused and the server is never asked for a move", async () => {
    // given
    const { call, connect, called } = orchestrator_(false);
    await connect(SAM, ["getJiraIssue", ...READ_TOOLS, ...WRITE_TOOLS]);
    const board = (await call(SAM, "/api/work/boards?source=mcp:atlassian")).body.boards[0].id;

    // when
    const moved = await call(SAM, "/api/work/items/PAY-142/transition", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ board, column: "Done" }) });

    // then
    expect(moved.status).toBe(400);
    expect(moved.body.error).toMatch(/^Changing issues in Jira is off/);
    expect(called.filter((n) => WRITE_TOOLS.includes(n))).toEqual([]);
    expect(called.filter((n) => READ_TOOLS.includes(n)).length).toBeGreaterThan(0);
  });

  it("given a project with no sprints, when Sam opens it as a Kanban board, then its cards are its stories and bugs with their epic as the parent line, the epic itself is no card, the done ones are the last two weeks', and My work is what Jira says is Sam's", async () => {
    // given
    const { call, connect, searches } = orchestrator_();
    await connect(SAM);
    const board = (await call(SAM, "/api/work/boards?source=mcp:atlassian")).body.boards[0].id;

    // when
    const read = await call(SAM, `/api/work/items?board=${encodeURIComponent(board)}`);

    // then
    expect(read.body.items.map((i: { key: string; type: string; epic: { summary: string } | null; assignee: { name: string; you?: boolean } | null }) => [i.key, i.type, i.epic?.summary ?? null, i.assignee])).toEqual([
      ["PAY-150", "Story", "Refund accuracy", { name: "Sam Member", you: true }],
      ["PAY-151", "Bug", null, null],
    ]);
    expect(searches).toEqual(expect.arrayContaining([
      'project = "PAY" AND issuetype != Epic AND (statusCategory != Done OR statusCategoryChangedDate >= -14d) ORDER BY rank',
      'project = "PAY" AND issuetype != Epic AND (statusCategory != Done OR statusCategoryChangedDate >= -14d) AND assignee = currentUser()',
    ]));
  });

  it("given Sam's board with a column per status, when Sam groups them into To do and Doing, sends a status the board lacks, and then resets, then the board shows Sam's columns with the status left out on its own, refuses the unknown one, and goes back", async () => {
    // given
    const { call, connect } = orchestrator_();
    await connect(SAM);
    const board = (await call(SAM, "/api/work/boards?source=mcp:atlassian")).body.boards[0].id;
    const put = (body: unknown) => call(SAM, `/api/work/boards/${encodeURIComponent(board)}/columns`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

    // when
    const arranged = await put({ columns: [{ name: "To do", statuses: ["Ready for Dev"] }, { name: "Doing", statuses: ["In Dev"] }] });
    const unknown = await put({ columns: [{ name: "Later", statuses: ["Parked"] }] });
    const read = await call(SAM, `/api/work/items?board=${encodeURIComponent(board)}`);
    const reset = await put({ columns: null });

    // then
    expect(arranged.body.columns).toEqual([{ name: "To do", statuses: ["Ready for Dev"] }, { name: "Doing", statuses: ["In Dev"] }, { name: "Done", statuses: ["Done"] }]);
    expect([unknown.status, unknown.body.error]).toEqual([400, "each column holds statuses this board has, each status in one column"]);
    expect(read.body.columns.map((c: { name: string }) => c.name)).toEqual(["To do", "Doing", "Done"]);
    expect(reset.body.columns.map((c: { name: string }) => c.name)).toEqual(["Ready for Dev", "In Dev", "Done"]);
  });
});

