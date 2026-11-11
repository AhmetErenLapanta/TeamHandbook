import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MiddlewareHandler } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { seed } from "../../demo/seed.js";
import { createApp, syncRepo } from "../app.js";
import type { OrchestratorContext } from "../app.js";
import type { OrchestratorEnv, Principal } from "../auth.js";
import { openSqliteStore } from "../store.js";
import { storePrincipals } from "../test-fixtures.js";
import { fakeAgentAdapter } from "./agents.js";
import { MAX_BATCH } from "./routes.js";
import { createTaskRunner } from "./runner.js";

const ADMIN: Principal = { id: "a", name: "Ada Example", email: "ada@example.invalid", role: "admin", ownedTeams: [] };
const PAYMENTS_OWNER: Principal = { id: "p", name: "Pat Example", email: "pat@example.invalid", role: "member", ownedTeams: ["Payments"] };
const FAKE_AGENT = join(import.meta.dirname, "..", "..", "demo", "fake-agent.mjs");

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const as = (user: Principal): MiddlewareHandler<OrchestratorEnv> => async (c, next) => {
  c.set("user", user);
  await next();
};

/** The demo's two skills repositories behind a runner that works one task at a time. */
async function seeded() {
  const root = mkdtempSync(join(tmpdir(), "orchestrator-task-batch-"));
  dirs.push(root);
  const { configFile } = seed(join(root, "demo"));
  const config = JSON.parse(readFileSync(configFile, "utf8"));
  const ctx: OrchestratorContext = { store: openSqliteStore(":memory:"), dataDir: join(root, "data"), tenant: config.tenant };
  await storePrincipals(ctx, ADMIN, PAYMENTS_OWNER);
  for (const repo of config.repos) {
    await ctx.store.upsertRepo({ ...repo, tenant: config.tenant });
    await syncRepo(ctx, repo.id);
  }
  ctx.tasks = createTaskRunner(ctx, { agents: [fakeAgentAdapter(FAKE_AGENT)], isolation: { mode: "process", network: "open" }, testCommand: () => null, hostEnv: { PATH: process.env.PATH }, concurrency: 1 });
  const batch = (user: Principal, body: unknown) => createApp(ctx, as(user)).request("/api/tasks/batch", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { ctx, batch };
}

describe("starting several tasks at once", () => {
  it("given three items, one on a repository that does not exist, when they are started together, then the other two wait in the organization's one queue in order and the third is refused by its index", async () => {
    // given
    const { ctx, batch } = await seeded();

    // when
    const res = await batch(ADMIN, { agent: "fake", items: [{ repoId: "payments-skills", title: "Add the refund note" }, { repoId: "nowhere", title: "Lost" }, { repoId: "platform-skills", title: "Add the on-call note" }] });
    const body = await res.json();
    await ctx.tasks!.idle();

    // then
    expect(res.status).toBe(200);
    expect(body.refused).toEqual([{ index: 1, error: "unknown repository" }]);
    expect(body.started.map((t: { title: string; repoId: string; queuePosition: number | null }) => [t.title, t.repoId, t.queuePosition])).toEqual([
      ["Add the refund note", "payments-skills", null],
      ["Add the on-call note", "platform-skills", 1],
    ]);
    const done = await Promise.all(body.started.map((t: { id: string }) => ctx.store.getTask(ctx.tenant, t.id)));
    expect(done.map((t) => t!.status)).toEqual(["needs-review", "needs-review"]);
  });

  it("given a team's owner, when a batch names their team's repository and another team's, then only the other team's item is refused", async () => {
    // given
    const { ctx, batch } = await seeded();

    // when
    const body = await (await batch(PAYMENTS_OWNER, { agent: "fake", items: [{ repoId: "payments-skills", title: "Add the refund note" }, { repoId: "platform-skills", title: "Add the on-call note" }] })).json();
    await ctx.tasks!.idle();

    // then
    expect(body.started.map((t: { repoId: string }) => t.repoId)).toEqual(["payments-skills"]);
    expect(body.refused).toEqual([{ index: 1, error: "this team keeps its tasks to its owners" }]);
  });

  it("given a monthly budget under which no task has reported a cost, when a batch of three starts, then the first waits or runs and holds what is left, and the other two are refused for the budget", async () => {
    // given
    const { ctx, batch } = await seeded();
    const app = createApp(ctx, as(ADMIN));
    await app.request("/api/policies", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ policy: { name: "Monthly task budget", audience: { kind: "workspace" }, rules: [{ kind: "task-budget", monthlyUsd: 5, per: "member" }] } }) });
    const item = (title: string) => ({ repoId: "payments-skills", title });

    // when
    const body = await (await batch(ADMIN, { agent: "fake", items: [item("First"), item("Second"), item("Third")] })).json();
    await ctx.tasks!.idle();

    // then
    expect(body.started.map((t: { title: string }) => t.title)).toEqual(["First"]);
    expect(body.refused).toEqual([1, 2].map((index) => ({ index, code: "task-budget", error: 'The task budget in "Monthly task budget" is spent: $0.00 of $5.00 this month for you, and $5.00 is held for 1 task still waiting or running.' })));
  });

  it("given batches that are empty, too long, or hold something other than tasks, when they are sent, then each is refused whole and nothing starts", async () => {
    // given
    const { ctx, batch } = await seeded();
    const one = { repoId: "payments-skills", title: "Add the refund note" };

    // when
    const answers = await Promise.all([{ agent: "fake", items: [] }, { agent: "fake", items: Array.from({ length: MAX_BATCH + 1 }, () => one) }, { agent: "fake", items: [one, "a task"] }, { agent: "fake" }].map((body) => batch(ADMIN, body)));

    // then
    for (const res of answers) expect([res.status, (await res.json()).error]).toEqual([400, `items is a list of 1 to ${MAX_BATCH} tasks to start`]);
    expect((await ctx.store.taskPage(ctx.tenant, {}, null, 1)).tasks).toEqual([]);
  });
});
