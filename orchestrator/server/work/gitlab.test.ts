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

const SITE = "https://gitlab.example";
const TOKEN = "glpat-stand-in-token-0001";

const issue = (iid: number, over: Record<string, unknown>) => ({ iid, title: `Issue ${iid}`, state: "opened", labels: [], assignees: [], weight: null, web_url: `${SITE}/acme/payments/-/issues/${iid}`, issue_type: "issue", ...over });

/** A GitLab on no network, by path: one project, its board lists, a milestone, no iterations. */
function gitlab() {
  const asked: string[] = [];
  const send = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const path = url.pathname + url.search;
    asked.push(path);
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (new Headers(init?.headers).get("private-token") !== TOKEN) return json({}, 401);
    if (path.startsWith("/api/v4/projects?")) return json([{ id: 7, path_with_namespace: "acme/payments", web_url: `${SITE}/acme/payments` }]);
    if (path.startsWith("/api/v4/projects/7/boards")) return json([{ lists: [{ position: 1, label: { name: "In review" } }, { position: 0, label: { name: "Doing" } }] }]);
    if (path.startsWith("/api/v4/projects/7/milestones")) return json([{ id: 3, title: "Sprint 3", start_date: "2026-11-01", due_date: "2026-11-14", description: "Refunds" }]);
    if (path.startsWith("/api/v4/projects/7/iterations")) return json({ message: "403 Forbidden" }, 403);
    if (path.startsWith("/api/v4/projects/7/issues?milestone=Sprint%203")) {
      return json([
        issue(12, { labels: ["Doing", "priority::high"], assignees: [{ name: "Lin" }], weight: 3, epic: { iid: 2, title: "Refund accuracy" } }),
        issue(13, { labels: ["blocked"] }),
        issue(14, { state: "closed", labels: ["Doing"], weight: 2 }),
      ]);
    }
    return json([], 404);
  }) as typeof fetch;
  return { asked, send };
}

async function orchestrator_() {
  const ctx: OrchestratorContext = { store: openSqliteStore(":memory:"), dataDir: "unused", tenant: "acme", vault: createVault(randomBytes(32)) };
  await saveEnabled(ctx, TRACKER, { kind: "gitlab", url: SITE }, ADA);
  await storeSecret(ctx.store, ctx.vault!, ctx.tenant, TRACKER_TOKEN_SECRET, TOKEN, ADA.email);
  const fake = gitlab();
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
  return { call, asked: fake.asked };
}

describe("GitLab issues as a board", () => {
  it("given a project with board lists and an active milestone, when an admin opens it, then the milestone is the sprint and each issue sits in Open, its list or Closed, with its weight, priority, epic and block", async () => {
    // given
    const { call } = await orchestrator_();

    // when
    const boards = await call("/api/work/boards?source=tracker");
    const sprints = await call("/api/work/sprints?board=tracker~7");
    const items = await call(`/api/work/items?sprint=${encodeURIComponent(sprints.body.sprints[0].id)}`);

    // then
    expect(boards.body.boards).toEqual([{ id: "tracker~7", name: "acme/payments", type: "project", project: "acme/payments", url: `${SITE}/acme/payments`, team: null }]);
    expect(sprints.body.sprints).toEqual([{ id: "tracker~7~m3", name: "Sprint 3", state: "active", startsAt: "2026-11-01", endsAt: "2026-11-14", goal: "Refunds" }]);
    expect(items.body.columns.map((c: { name: string }) => c.name)).toEqual(["Open", "Doing", "In review", "Closed"]);
    expect(items.body.items[0]).toMatchObject({ key: "acme/payments#12", url: `${SITE}/acme/payments/-/issues/12`, status: { name: "Doing", category: "doing" }, column: "Doing", assignee: { name: "Lin" }, priority: "high", epic: { key: "&2", summary: "Refund accuracy" }, storyPoints: 3, blocked: false });
    expect(items.body.items.slice(1).map((i: { column: string; blocked: boolean }) => [i.column, i.blocked])).toEqual([["Open", true], ["Closed", false]]);
    expect(items.body.progress).toEqual({ todo: 1, doing: 1, done: 1, points: { total: 5, done: 2 } });
  });

  it("given the GitLab source, when it is listed, then it says it does not move issues yet", async () => {
    // given
    const { call } = await orchestrator_();

    // when
    const sources = await call("/api/work/sources");

    // then
    expect(sources.body.sources[0]).toMatchObject({ id: "tracker", kind: "gitlab", can: { write: false }, writeProblem: "The orchestrator does not move GitLab issues yet", problem: null });
  });
});
