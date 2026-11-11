import { describe, expect, it } from "vitest";
import type { Principal } from "../auth.js";
import { openSqliteStore } from "../store.js";
import { UNKNOWN_COST } from "../tasks/types.js";
import type { TaskRecord } from "../tasks/types.js";
import { seesRequest } from "./request-access.js";

const member = (email: string, ownedTeams: string[] = []): Principal => ({ id: email, name: email, email, role: "member", ownedTeams, restrictedTeams: [] });

describe("who reads a request a task opened on another of its repositories", () => {
  it("given a task over two repositories whose second one opened request #3, when people ask for #3 there, then it is read as the task is, by its starter and the first team's owner, not by a member of either team", async () => {
    const store = openSqliteStore(":memory:");
    const ctx = { store, tenant: "acme" };
    await store.upsertRepo({ tenant: "acme", id: "api", team: "Payments", name: "api", url: "https://gitlab.example.invalid/acme/api.git" });
    const web = await store.upsertRepo({ tenant: "acme", id: "web", team: "Frontend", name: "web", url: "https://gitlab.example.invalid/acme/web.git" });
    const task: TaskRecord = { tenant: "acme", id: "tsk_twofold01", repoId: "api", team: "Payments", title: "Add retry", description: "", issueUrl: null, issueKey: null, agent: "fake", status: "needs-review", createdBy: "pat@example.invalid", createdAt: "2026-11-03T00:00:00.000Z", startedAt: null, finishedAt: null, baseSha: null, tests: null, cost: UNKNOWN_COST, requestNumber: null, error: null };
    await store.createTask(task);
    await store.setTaskTargets("acme", task.id, [{ repoId: "web", status: "request", reason: "", baseSha: null, branch: "handbook/retry", tests: null, requestNumber: 3, error: null, cost: UNKNOWN_COST }]);
    const opened = { createdBy: "pat@example.invalid" };

    expect(await seesRequest(ctx, member("pat@example.invalid"), web, 3, opened)).toBe(true);
    expect(await seesRequest(ctx, member("owner@example.invalid", ["Payments"]), web, 3, opened)).toBe(true);
    expect(await seesRequest(ctx, member("max@example.invalid"), web, 3, opened)).toBe(false);
    expect(await seesRequest(ctx, member("fran@example.invalid", ["Frontend"]), web, 3, opened)).toBe(false);
    expect(await seesRequest(ctx, member("max@example.invalid"), web, 4, null)).toBe(true);
  });
});
