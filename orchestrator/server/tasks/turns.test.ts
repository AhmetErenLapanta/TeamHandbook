import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { OrchestratorContext } from "../app.js";
import { openSqliteStore } from "../store.js";
import { purgeTurns } from "./turns.js";
import type { TaskRecord } from "./types.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("a task's turn snapshots, kept no longer than they are read", () => {
  it("given snapshot folders of a task that ended long ago, one that ended today, one whose starter has no account now and one no task owns, when the cleanup runs, then only the recent task of a person still here keeps its folder and its turns", async () => {
    // given
    const dataDir = mkdtempSync(join(tmpdir(), "th-turns-"));
    dirs.push(dataDir);
    const ctx: Pick<OrchestratorContext, "store" | "tenant" | "dataDir"> = { store: openSqliteStore(":memory:"), tenant: "acme", dataDir };
    await ctx.store.insertUser({ tenant: "acme", id: "usr_ada", email: "ada@example.invalid", name: "Ada Example", role: "member", passwordHash: null, oidcIssuer: null, oidcSubject: null, forgeLogin: null, createdAt: "2026-01-01T00:00:00.000Z" });
    const task = (id: string, createdBy: string, finishedAt: string): TaskRecord => ({ tenant: "acme", id, repoId: "payments-skills", team: "Payments", title: id, description: "", issueUrl: null, issueKey: null, agent: "fake", status: "needs-review", createdBy, createdAt: finishedAt, startedAt: finishedAt, finishedAt, baseSha: null, tests: null, cost: { usd: null, inputTokens: null, outputTokens: null }, requestNumber: null, error: null });
    const tasks = [task("tsk_old", "ada@example.invalid", "2026-08-01T10:00:00.000Z"), task("tsk_recent", "ada@example.invalid", "2026-11-12T10:00:00.000Z"), task("tsk_left", "bo@example.invalid", "2026-11-12T10:00:00.000Z")];
    for (const t of tasks) {
      await ctx.store.createTask(t);
      await ctx.store.updateTask("acme", t.id, { status: "needs-review", finishedAt: t.finishedAt });
      await ctx.store.openTaskTurn({ tenant: "acme", taskId: t.id, n: 1, at: t.finishedAt!, said: "Add a note", place: "task", start: "a".repeat(40) });
    }
    const folder = (id: string) => join(dataDir, "task-turns", "acme", id);
    for (const id of ["tsk_old", "tsk_recent", "tsk_left", "tsk_orphan"]) mkdirSync(folder(id), { recursive: true });

    // when
    const removed = await purgeTurns(ctx, "2026-10-13T00:00:00.000Z");

    // then
    expect(removed).toBe(3);
    expect(["tsk_old", "tsk_recent", "tsk_left", "tsk_orphan"].map((id) => existsSync(folder(id)))).toEqual([false, true, false, false]);
    expect(await Promise.all(["tsk_old", "tsk_recent", "tsk_left"].map(async (id) => (await ctx.store.taskTurns("acme", id)).length))).toEqual([0, 1, 0]);
  });
});
