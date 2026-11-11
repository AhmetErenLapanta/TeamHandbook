import { randomBytes } from "node:crypto";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { OrchestratorContext } from "../app.js";
import type { OrchestratorEnv } from "../auth.js";
import { saveEnabled } from "../integrations/records.js";
import { TRACKER, TRACKER_TOKEN_SECRET } from "../integrations/tracker.js";
import { openSqliteStore } from "../store.js";
import { createVault, storeSecret } from "../vault.js";
import { WorkCache } from "./cache.js";
import { ADA } from "./jira-stand-in.js";
import { workRoutes } from "./routes.js";

const KEY = "lin_api_stand-in-key-0001";
const TEAM = "11111111-2222-3333-4444-555555555555";
const KANBAN = "66666666-7777-8888-9999-000000000000";
const CYCLE = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const issue = (identifier: string, state: [string, string], over: Record<string, unknown> = {}) => ({ identifier, title: `Issue ${identifier}`, url: `https://linear.app/acme/issue/${identifier}/x`, priority: 0, priorityLabel: "No priority", estimate: null, assignee: null, labels: { nodes: [] }, state: { name: state[0], type: state[1] }, parent: null, ...over });

/** Linear's GraphQL API on no network: two teams, one with cycles, its states, a cycle and their issues; every query it was sent is kept. */
function linear() {
  const queries: string[] = [];
  const send = (async (_input: string | URL, init?: RequestInit) => {
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (new Headers(init?.headers).get("authorization") !== KEY) return json({ errors: [{ message: "Authentication required" }] }, 401);
    const { query } = JSON.parse(String(init?.body)) as { query: string };
    queries.push(query);
    if (query.includes("teams(")) return json({ data: { organization: { urlKey: "acme" }, teams: { nodes: [{ id: TEAM, key: "ENG", name: "Engineering", cyclesEnabled: true }, { id: KANBAN, key: "OPS", name: "Operations", cyclesEnabled: false }] } } });
    if (query.includes("cycles(")) return json({ data: { team: { cycles: { nodes: [{ id: CYCLE, number: 14, name: null, startsAt: "2026-11-02T00:00:00.000Z", endsAt: "2026-11-16T00:00:00.000Z", isActive: true, isFuture: false, description: "Refunds" }] } } } });
    if (query.includes("states {")) return json({ data: { team: { states: { nodes: [{ name: "Done", type: "completed", position: 0 }, { name: "In Review", type: "started", position: 2 }, { name: "Todo", type: "unstarted", position: 0 }, { name: "In Progress", type: "started", position: 1 }, { name: "Backlog", type: "backlog", position: 0 }] } } } });
    if (query.includes("node: cycle(")) {
      return json({ data: { node: { issues: { nodes: [
        issue("ENG-12", ["In Progress", "started"], { priority: 2, priorityLabel: "High", estimate: 3, assignee: { name: "Lin Dev", email: "lin@example.invalid" }, parent: { identifier: "ENG-1", title: "Refund accuracy" } }),
        issue("ENG-13", ["Todo", "unstarted"], { labels: { nodes: [{ name: "blocked" }] } }),
        issue("ENG-14", ["Done", "completed"]),
      ], pageInfo: { hasNextPage: false, endCursor: null } } } } });
    }
    if (query.includes("node: team(")) return json({ data: { node: { issues: { nodes: [issue("OPS-3", ["Todo", "unstarted"])], pageInfo: { hasNextPage: false, endCursor: null } } } } });
    return json({ errors: [{ message: "unknown query" }] });
  }) as typeof fetch;
  return { queries, send };
}

async function orchestrator_() {
  const ctx: OrchestratorContext = { store: openSqliteStore(":memory:"), dataDir: "unused", tenant: "acme", vault: createVault(randomBytes(32)) };
  await saveEnabled(ctx, TRACKER, { kind: "linear", url: "https://linear.app/acme" }, ADA);
  await storeSecret(ctx.store, ctx.vault!, ctx.tenant, TRACKER_TOKEN_SECRET, KEY, ADA.email);
  const fake = linear();
  const app = new Hono<OrchestratorEnv>();
  app.use(async (c, next) => {
    c.set("user", ADA);
    await next();
  });
  app.route("/", workRoutes(ctx, { cache: new WorkCache(), send: fake.send }));
  const call = async (path: string) => {
    const res = await app.request(path);
    return { status: res.status, body: await res.json() };
  };
  return { call, queries: fake.queries };
}

describe("Linear read with a person's API key", () => {
  it("given a workspace with a team on cycles, when an admin opens its board, then the team is the board, the active cycle the sprint, the columns the team's states in Linear's order, and each issue reads like the tracker's card", async () => {
    // given
    const { call } = await orchestrator_();

    // when
    const sources = await call("/api/work/sources");
    const boards = await call("/api/work/boards?source=tracker");
    const sprints = await call(`/api/work/sprints?board=${encodeURIComponent(`tracker~${TEAM}`)}`);
    const items = await call(`/api/work/items?sprint=${encodeURIComponent(sprints.body.sprints[0].id)}`);

    // then
    expect(sources.body.sources).toEqual([expect.objectContaining({ id: "tracker", kind: "linear", name: "Linear (linear.app)", can: expect.objectContaining({ write: false }), writeProblem: "The orchestrator does not move Linear issues yet" })]);
    expect(boards.body.boards.map((b: { name: string; type: string; project: string; url: string }) => [b.name, b.type, b.project, b.url])).toEqual([["Engineering", "scrum", "ENG", "https://linear.app/acme/team/ENG"], ["Operations", "kanban", "OPS", "https://linear.app/acme/team/OPS"]]);
    expect(sprints.body.sprints.map((s: { name: string; state: string; goal: string }) => [s.name, s.state, s.goal])).toEqual([["Cycle 14", "active", "Refunds"]]);
    expect(items.body.columns.map((c: { name: string }) => c.name)).toEqual(["Backlog", "Todo", "In Progress", "In Review", "Done"]);
    expect(items.body.items.map((i: { key: string; column: string; priority: string | null; storyPoints: number | null; epic: { summary: string } | null; blocked: boolean; status: { category: string } }) => [i.key, i.column, i.priority, i.storyPoints, i.epic?.summary ?? null, i.blocked, i.status.category])).toEqual([
      ["ENG-12", "In Progress", "High", 3, "Refund accuracy", false, "doing"],
      ["ENG-13", "Todo", null, null, null, true, "todo"],
      ["ENG-14", "Done", null, null, null, false, "done"],
    ]);
  });

  it("given a team with cycles off, when its board is read whole, then it reads the team's open issues and the last two weeks' done ones, and only ever queries", async () => {
    // given
    const { call, queries } = await orchestrator_();

    // when
    const items = await call(`/api/work/items?board=${encodeURIComponent(`tracker~${KANBAN}`)}`);

    // then
    expect(items.body.items.map((i: { key: string }) => i.key)).toEqual(["OPS-3"]);
    expect(queries.some((q) => q.includes('completedAt: { gt: "-P2W" }'))).toBe(true);
    expect(queries.every((q) => q.trimStart().startsWith("query"))).toBe(true);
  });
});
