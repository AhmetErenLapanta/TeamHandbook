import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createUser, principalOf, setupFirstOwner } from "./accounts.js";
import { createApp } from "./app.js";
import type { OrchestratorContext } from "./app.js";
import type { Principal } from "./auth.js";
import { newId } from "./ids.js";
import { openSqliteStore } from "./store.js";
import { fakeAgentAdapter } from "./tasks/agents.js";
import { createTaskRunner } from "./tasks/runner.js";
import type { TaskRecord } from "./tasks/types.js";

const TENANT = "acme";

describe("finding a word in a task's log", () => {
  it("given a task with a long log of its person, when they find a word, a word with a percent sign, a word in other case, one that is too short, one that is in more than a hundred lines, and a teammate who cannot read the task finds, then the matches come with their line numbers across the whole log, the percent matches only itself, case is ignored, and the teammate is told no such task", async () => {
    // given
    const store = openSqliteStore(":memory:");
    const owner = await principalOf(store, await setupFirstOwner(store, TENANT, "code", { code: "code", email: "ada@example.invalid", password: "correct horse battery" }));
    const max = await principalOf(store, await createUser(store, TENANT, new Set(["Shop"]), { email: "max@example.invalid", role: "member", password: "correct horse battery" }, owner));
    const lee = await principalOf(store, await createUser(store, TENANT, new Set(["Other"]), { email: "lee@example.invalid", role: "member", password: "correct horse battery" }, owner));
    const ctx: OrchestratorContext = { store, mode: "self-hosted", dataDir: "/nonexistent", tenant: TENANT, allowedHosts: null };
    const task: TaskRecord = { tenant: TENANT, id: newId("tsk"), repoId: "shop", team: "Shop", title: "t", description: "", issueUrl: null, issueKey: null, agent: "fake", status: "needs-review", createdBy: max.email, createdAt: "2026-11-12T10:00:00.000Z", startedAt: null, finishedAt: null, baseSha: null, tests: null, cost: { usd: null, inputTokens: null, outputTokens: null }, requestNumber: null, error: null };
    ctx.tasks = createTaskRunner(ctx, { agents: [fakeAgentAdapter(join(import.meta.dirname, "..", "demo", "fake-agent.mjs"))], isolation: { mode: "process", network: "open" }, testCommand: () => null, hostEnv: { PATH: process.env.PATH } });
    await store.createTask(task);
    const lines = Array.from({ length: 2500 }, (_, i) => (i === 2300 ? "ran the Migration for orders" : i === 40 ? "disk at 100% full" : i === 41 ? "disk at 1000 full" : `step ${i} repeats`));
    await store.appendTaskLog(TENANT, task.id, lines);
    const as = (user: Principal) => createApp(ctx, async (c, next) => { c.set("user", user); await next(); });
    const find = async (user: Principal, q: string) => {
      const res = await as(user).request(`/api/tasks/${task.id}/find?q=${encodeURIComponent(q)}`);
      return { status: res.status, body: await res.json() };
    };

    // when
    const migration = await find(max, "migration");
    const percent = await find(max, "100%");
    const short = await find(max, "m");
    const many = await find(max, "repeats");
    const stranger = await find(lee, "migration");

    // then
    expect(migration.body).toEqual({ matches: [{ seq: 2301, text: "ran the Migration for orders" }], more: false });
    expect(percent.body.matches.map((m: { seq: number }) => m.seq)).toEqual([41]);
    expect([short.status, short.body.code]).toEqual([400, "bad-find"]);
    expect([many.body.matches.length, many.body.more]).toEqual([100, true]);
    expect([stranger.status, stranger.body]).toEqual([404, { error: "unknown task", code: "not-found" }]);
  });
});
