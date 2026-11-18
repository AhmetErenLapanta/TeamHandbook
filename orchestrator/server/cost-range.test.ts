import { describe, expect, it } from "vitest";
import { createUser, principalOf, setupFirstOwner } from "./accounts.js";
import type { OrchestratorContext } from "./app.js";
import { costRange } from "./cost-range.js";
import { openSqliteStore } from "./store.js";
import type { TaskRecord } from "./tasks/types.js";

const TENANT = "acme";
const NOW = Date.parse("2026-11-12T12:00:00.000Z");
const at = (daysAgo: number) => new Date(NOW - daysAgo * 86_400_000).toISOString();

function task(id: string, usd: number | null, fields: Partial<TaskRecord> = {}): TaskRecord {
  return { tenant: TENANT, id, repoId: "shop", team: "Shop", title: id, description: "", issueUrl: null, issueKey: null, agent: "claude-code", status: "needs-review", createdBy: "max@example.invalid", createdAt: at(3), startedAt: null, finishedAt: at(3), baseSha: null, tests: null, cost: { usd, inputTokens: null, outputTokens: null }, requestNumber: null, error: null, ...fields };
}

describe("what tasks like the next one have cost", () => {
  it("given a project's finished tasks with one agent, one with another, ones too old, unfinished or of unknown cost, and a teammate's, when the range is read for the agent, then it is the lower and upper quarter of the counted ones, a range of too few is none, and a teammate's tasks are not counted", async () => {
    // given
    const store = openSqliteStore(":memory:");
    const owner = await principalOf(store, await setupFirstOwner(store, TENANT, "code", { code: "code", email: "ada@example.invalid", password: "correct horse battery" }));
    const max = await principalOf(store, await createUser(store, TENANT, new Set(["Shop"]), { email: "max@example.invalid", role: "member", password: "correct horse battery" }, owner));
    const ctx: OrchestratorContext = { store, mode: "self-hosted", dataDir: "/nonexistent", tenant: TENANT, allowedHosts: null };
    for (const [i, usd] of [0.2, 0.4, 0.6, 0.8, 1.0, 1.2, 1.4, 1.6, 1.8].entries()) await store.createTask(task(`tsk_c${i}`, usd));
    await store.createTask(task("tsk_other", 9, { agent: "opencode" }));
    await store.createTask(task("tsk_old", 50, { createdAt: at(200) }));
    await store.createTask(task("tsk_running", 70, { status: "running", finishedAt: null }));
    await store.createTask(task("tsk_unknown", null));
    await store.createTask(task("tsk_lees", 99, { team: "Other", createdBy: "lee@example.invalid" }));

    // when
    const range = await costRange(ctx, max, "shop", "claude-code", NOW);
    const few = await costRange(ctx, max, "shop", "opencode", NOW);
    const seesAll = await costRange(ctx, owner, "shop", "claude-code", NOW);

    // then
    expect(range).toEqual({ tasks: 9, lowUsd: 0.6, highUsd: 1.4 });
    expect(few).toEqual({ tasks: 1, lowUsd: null, highUsd: null });
    expect(seesAll.tasks).toBe(10);
  });
});
