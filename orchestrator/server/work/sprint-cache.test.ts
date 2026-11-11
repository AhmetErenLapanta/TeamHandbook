import { randomBytes } from "node:crypto";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { OrchestratorContext } from "../app.js";
import type { OrchestratorEnv, Principal } from "../auth.js";
import { saveEnabled } from "../integrations/records.js";
import { TRACKER, TRACKER_TOKEN_SECRET } from "../integrations/tracker.js";
import { openSqliteStore } from "../store.js";
import { UNKNOWN_COST } from "../tasks/types.js";
import { createVault, storeSecret } from "../vault.js";
import { FRESH_EVERY_MS, WORK_TTL_MS, WorkCache } from "./cache.js";
import { workRoutes } from "./routes.js";

const ADA: Principal = { id: "u-ada", name: "Ada Admin", email: "ada@example.invalid", role: "admin", ownedTeams: [] };
const SITE = "https://acme.atlassian.example";
const TOKEN = "ATATT3xFfGF0-stand-in-token-0002";
const SPRINT = "/api/work/items?sprint=tracker~7~9";

/** The lab's sprint on no network: the Customers board, its active sprint with three issues, and a teammate who moves one in Jira. */
function customers() {
  const status: Record<string, string> = { "HOO-412": "Ready for Dev", "HOO-413": "Ready for Dev", "HOO-414": "In Dev" };
  const reads = { sprint: 0 };
  const category = (s: string) => (s === "Done" ? "done" : s === "Ready for Dev" ? "new" : "indeterminate");
  const send = (async (input: string | URL) => {
    const url = new URL(String(input));
    const path = url.pathname + url.search;
    const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
    if (path.startsWith("/rest/agile/1.0/board?")) return json({ values: [{ id: 7, name: "Customers", type: "scrum", location: { projectKey: "HOO" } }], isLast: true });
    if (path.startsWith("/rest/agile/1.0/board/7/sprint?")) return json({ values: [{ id: 9, name: "Sprint 9", state: "active" }] });
    if (path.startsWith("/rest/agile/1.0/board/7/configuration")) return json({ columnConfig: { columns: ["Ready for Dev", "In Dev", "Code Review", "Done"].map((name, i) => ({ name, statuses: [{ id: String(i + 1) }] })) } });
    if (path.startsWith("/rest/api/3/status")) return json(["Ready for Dev", "In Dev", "Code Review", "Done"].map((name, i) => ({ id: String(i + 1), name })));
    if (path.startsWith("/rest/api/3/field")) return json([]);
    if (path.startsWith("/rest/agile/1.0/board/7/sprint/9/issue?")) {
      reads.sprint++;
      return json({ issues: Object.entries(status).map(([key, name]) => ({ key, fields: { summary: key, status: { name, statusCategory: { key: category(name) } }, labels: [] } })), total: 3 });
    }
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  return { status, reads, send };
}

async function orchestrator_() {
  const ctx: OrchestratorContext = { store: openSqliteStore(":memory:"), dataDir: "unused", tenant: "acme", vault: createVault(randomBytes(32)), publicUrl: "https://orchestrator.example.invalid" };
  await saveEnabled(ctx, TRACKER, { kind: "jira", url: SITE, email: "bot@example.invalid" }, ADA);
  await storeSecret(ctx.store, ctx.vault!, ctx.tenant, TRACKER_TOKEN_SECRET, TOKEN, ADA.email);
  const jira = customers();
  const clock = { now: Date.parse("2026-11-02T10:00:00.000Z") };
  const deps = { cache: new WorkCache(() => clock.now), send: jira.send };
  const app = new Hono<OrchestratorEnv>();
  app.use(async (c, next) => {
    c.set("user", ADA);
    await next();
  });
  app.route("/", workRoutes(ctx, deps));
  const read = async (path = SPRINT) => (await app.request(path)).json();
  const columnOf = (items: { key: string; column: string }[], key: string) => items.find((i) => i.key === key)!.column;
  return { ctx, app, jira, clock, read, columnOf };
}

describe("the lab's sprint as the board reads it", () => {
  it("given the sprint read once, when a teammate moves HOO-413 in Jira, then the board keeps the minute's answer, a fresh read shows the move, and so does the next read once the minute is past", async () => {
    // given
    const { jira, clock, read, columnOf } = await orchestrator_();
    await read();

    // when
    jira.status["HOO-413"] = "Code Review";
    const within = await read();
    clock.now += FRESH_EVERY_MS;
    const fresh = await read(`${SPRINT}&fresh=1`);
    jira.status["HOO-413"] = "Done";
    clock.now += WORK_TTL_MS + 1;
    const past = await read();

    // then
    expect([columnOf(within.items, "HOO-413"), within.stale]).toEqual(["Ready for Dev", false]);
    expect([columnOf(fresh.items, "HOO-413"), fresh.stale]).toEqual(["Code Review", false]);
    expect([columnOf(past.items, "HOO-413"), past.stale]).toEqual(["Code Review", true]);
    await vi.waitFor(async () => expect(columnOf((await read()).items, "HOO-413")).toBe("Done"));
    expect(within.progress).toEqual({ todo: 2, doing: 1, done: 0, points: null });
  });

  it("given the sprint read a moment ago, when three tasks start on its issues, then each issue shows its task at once, without Jira being asked again", async () => {
    // given
    const { ctx, jira, read } = await orchestrator_();
    await read();
    const readsBefore = jira.reads.sprint;

    // when
    for (const key of ["HOO-412", "HOO-413", "HOO-414"]) {
      await ctx.store.createTask({ tenant: "acme", id: `tsk_${key.toLowerCase().replace("-", "")}00001`, repoId: "customers-api", team: "Customers", title: key, description: "", issueUrl: `${SITE}/browse/${key}`, issueKey: key, agent: "claude", status: "running", createdBy: ADA.email, createdAt: "2026-11-02T10:01:00.000Z", startedAt: null, finishedAt: null, baseSha: null, tests: null, cost: UNKNOWN_COST, requestNumber: null, error: null });
    }
    const board = await read();

    // then
    expect(board.items.map((i: { key: string; tasks: { status: string }[] }) => [i.key, i.tasks.map((t) => t.status)])).toEqual([
      ["HOO-412", ["running"]],
      ["HOO-413", ["running"]],
      ["HOO-414", ["running"]],
    ]);
    expect(jira.reads.sprint).toBe(readsBefore);
  });
});
