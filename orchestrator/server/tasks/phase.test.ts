import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MiddlewareHandler } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { seed } from "../../demo/seed.js";
import { createApp, syncRepo } from "../app.js";
import type { OrchestratorContext } from "../app.js";
import type { OrchestratorEnv, Principal } from "../auth.js";
import type { RequestStatus } from "../forge/types.js";
import { openSqliteStore } from "../store.js";
import { storePrincipals } from "../test-fixtures.js";
import { fakeAgentAdapter } from "./agents.js";
import { taskPhase } from "./phase.js";
import { createTaskRunner } from "./runner.js";
import type { RunnerOptions } from "./runner.js";
import type { TaskRecord, TaskTarget } from "./types.js";
import { UNKNOWN_COST } from "./types.js";

const ADMIN: Principal = { id: "a", name: "Ada Example", email: "ada@example.invalid", role: "admin", ownedTeams: [] };
const FAKE_AGENT = join(import.meta.dirname, "..", "..", "demo", "fake-agent.mjs");

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const as = (user: Principal): MiddlewareHandler<OrchestratorEnv> => async (c, next) => {
  c.set("user", user);
  await next();
};

const one = (status: TaskRecord["status"], more: Partial<TaskRecord> = {}) => ({ status, repoId: "payments-skills", requestNumber: null, ...more }) as TaskRecord;
const target = (repoId: string, status: TaskTarget["status"], requestNumber: number | null = null): TaskTarget => ({ repoId, status, reason: "", baseSha: null, branch: null, tests: null, requestNumber, error: null, cost: UNKNOWN_COST });
const requests = (statuses: Record<string, RequestStatus>) => (repoId: string, number: number) => statuses[`${repoId}#${number}`] ?? null;

describe("a task's phase", () => {
  it("given tasks on one repository at each point of their run, when their phase is read, then it follows the stage while they run and the request once they end", () => {
    // when
    const phases = [
      one("queued"),
      one("running"),
      one("running", { stage: "tests" }),
      one("running", { stage: "request" }),
      one("needs-review", { requestNumber: 4 }),
      one("needs-review", { requestNumber: 5 }),
      one("needs-review", { requestNumber: 6 }),
      one("failed"),
      one("cancelled"),
    ].map((task) => taskPhase(task, requests({ "payments-skills#4": "open", "payments-skills#5": "merged", "payments-skills#6": "closed" })));

    // then
    expect(phases).toEqual(["planned", "working", "tests", "request", "review", "merged", "failed", "failed", "failed"]);
  });

  it("given tasks over several repositories, when their phase is read, then it is the least advanced repository's, a failed one fails it, and it is merged only when every request is", () => {
    // given
    const over = (status: TaskRecord["status"], targets: TaskTarget[]) => one(status, { targetMode: "orchestrator", targets });
    const statuses = requests({ "a#1": "merged", "b#2": "open", "c#3": "merged" });

    // when
    const phases = [
      over("running", []),
      over("running", [target("a", "request", 1), target("b", "tests"), target("c", "planned")]),
      over("running", [target("a", "request", 1), target("b", "failed"), target("c", "skipped")]),
      over("needs-review", [target("a", "request", 1), target("b", "request", 2)]),
      over("needs-review", [target("a", "request", 1), target("c", "request", 3)]),
    ].map((task) => taskPhase(task, statuses));

    // then
    expect(phases).toEqual(["planned", "tests", "failed", "review", "merged"]);
  });
});

/** The demo's payments-skills behind a runner whose agent is the stand-in. */
async function seeded(overrides: Partial<RunnerOptions> = {}) {
  const root = mkdtempSync(join(tmpdir(), "orchestrator-task-phase-"));
  dirs.push(root);
  const { configFile } = seed(join(root, "demo"));
  const config = JSON.parse(readFileSync(configFile, "utf8"));
  const ctx: OrchestratorContext = { store: openSqliteStore(":memory:"), dataDir: join(root, "data"), tenant: config.tenant };
  await storePrincipals(ctx, ADMIN);
  const entry = config.repos.find((r: { id: string }) => r.id === "payments-skills");
  await ctx.store.upsertRepo({ ...entry, tenant: config.tenant });
  await syncRepo(ctx, "payments-skills");
  ctx.tasks = createTaskRunner(ctx, { agents: [fakeAgentAdapter(FAKE_AGENT)], isolation: { mode: "process", network: "open" }, testCommand: () => "true", hostEnv: { PATH: process.env.PATH }, ...overrides });
  return { ctx, repo: (await ctx.store.getRepo(ctx.tenant, "payments-skills"))! };
}

// Each case runs an agent, the tests and a request, and one merges it.
describe("a task's phase as it runs", { timeout: 60_000 }, () => {
  it("given a tracker hook, when a task runs to its request and the request is merged, then the hook hears working and review, the stage moves, and the task reads review and then merged", async () => {
    // given
    const heard: string[] = [];
    const { ctx, repo } = await seeded({ onPhase: async (task, phase) => void heard.push(`${task.title}: ${phase}`) });
    const app = createApp(ctx, as(ADMIN));

    // when
    const started = await ctx.tasks!.start({ repo, title: "Add the refund note", description: "", agent: "fake", user: ADMIN });
    await ctx.tasks!.idle();
    const before = (await (await app.request(`/api/tasks/${started.id}?after=0`)).json()).task;
    const number = before.requestNumber;
    await app.request(`/api/repos/payments-skills/requests/${number}/merge`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    const after = (await (await app.request(`/api/tasks/${started.id}?after=0`)).json()).task;

    // then
    expect(heard).toEqual(["Add the refund note: working", "Add the refund note: review"]);
    expect([before.stage, before.phase, after.phase]).toEqual(["request", "review", "merged"]);
  });

  it("given a tracker hook that fails, when a task runs, then the task still opens its request and its log says the issue was not moved", async () => {
    // given
    const { ctx, repo } = await seeded({ onPhase: async () => { throw new Error("the tracker refused the move"); } });

    // when
    const started = await ctx.tasks!.start({ repo, title: "Add the refund note", description: "", agent: "fake", user: ADMIN });
    await ctx.tasks!.idle();

    // then
    expect((await ctx.store.getTask(ctx.tenant, started.id))?.status).toBe("needs-review");
    const log = (await ctx.store.taskLog(ctx.tenant, started.id, 0)).map((l) => l.text);
    expect(log.filter((l) => l === "The issue was not moved on the tracker: the tracker refused the move")).toHaveLength(2);
  });
});
