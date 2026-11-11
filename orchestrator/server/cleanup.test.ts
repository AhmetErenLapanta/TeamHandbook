import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OrchestratorContext } from "./app.js";
import { cleanupRound, cleanupSummary } from "./cleanup.js";
import { RETENTION_SETTING } from "./events.js";
import { openSqliteStore } from "./store.js";
import type { Store } from "./store.js";
import type { TaskRecord } from "./tasks/types.js";

let dir: string;
let store: Store;
const NOW = new Date("2026-11-03T12:00:00.000Z");
const daysAgo = (days: number) => new Date(NOW.getTime() - days * 86_400_000).toISOString();

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "th-cleanup-"));
  store = openSqliteStore(join(dir, "orchestrator.db"));
});

afterEach(async () => {
  await store.close();
  rmSync(dir, { recursive: true, force: true });
});

const task = (id: string): TaskRecord => ({ tenant: "acme", id, repoId: "payments-skills", team: "Payments", title: "t", description: "", issueUrl: null, issueKey: null, agent: "fake", status: "queued", createdBy: "ada@example.invalid", createdAt: daysAgo(30), startedAt: null, finishedAt: null, baseSha: null, tests: null, cost: { usd: null, inputTokens: null, outputTokens: null }, requestNumber: null, error: null });
const event = (id: string, at: string) => ({ tenant: "acme", id, at, kind: "account.changed", actor: { kind: "user" as const, id: "usr_a", email: "a@example.invalid", name: "A" }, repoId: null, subject: null, detail: "changed" });

describe("the hourly cleanup", () => {
  it("given an event past the organization's retention, an agent question past its time, an effect settled two weeks ago, an old signup step and fresh ones of each, when a round runs, then only the old ones go and one line says how many", async () => {
    // given
    const ctx = { store, tenant: "acme" } as OrchestratorContext;
    await store.setSetting("acme", RETENTION_SETTING, "365");
    await store.appendEvent(event("evt_old", daysAgo(400)));
    await store.appendEvent(event("evt_new", daysAgo(1)));
    await store.commitCommand({ tenant: "acme", taskId: "tsk_a", at: daysAgo(14), createTask: task("tsk_a"), effects: [{ kind: "tracker.move", payload: {}, replay: "replay-safe" }] });
    const effect = (await store.claimEffect("w", daysAgo(14), daysAgo(13)))!;
    await store.settleEffect("acme", effect.id, "w", { done: null }, daysAgo(14));
    await store.recordTaskRequest({ tenant: "acme", id: "req_old", taskId: "tsk_a", targetPosition: null, sourceKey: "k1", kind: "question", payload: {}, createdAt: daysAgo(1), expiresAt: daysAgo(0.5) });
    await store.recordTaskRequest({ tenant: "acme", id: "req_new", taskId: "tsk_a", targetPosition: null, sourceKey: "k2", kind: "question", payload: {}, createdAt: NOW.toISOString(), expiresAt: daysAgo(-1) });
    await store.recordIdentityEvent({ id: "ide_old", identityId: "idn_a", at: daysAgo(100), kind: "signup.started", provider: "google", emailDomain: "example.invalid", org: null });
    await store.recordIdentityEvent({ id: "ide_new", identityId: "idn_b", at: daysAgo(1), kind: "signup.started", provider: "google", emailDomain: "example.invalid", org: null });

    // when
    const report = await cleanupRound(store, [ctx], { signupDays: 90 }, NOW);

    // then
    expect(report).toMatchObject({ events: 1, expiredQuestions: 1, settledEffects: 1, signupSteps: 1 });
    expect(await store.getEvent("acme", "evt_old")).toBeNull();
    expect(await store.getEvent("acme", "evt_new")).not.toBeNull();
    expect((await store.taskRequests("acme", "tsk_a")).map((r) => [r.id, r.status])).toEqual([["req_old", "expired"], ["req_new", "pending"]]);
    expect((await store.identityEventsSince("2000-01-01T00:00:00.000Z")).map((e) => e.id)).toEqual(["ide_new"]);
    expect(cleanupSummary(report)).toBe("cleanup: 1 events, 1 agent questions expired, 1 settled effects, 1 signup steps");
  });

  it("given a self-hosted orchestrator and nothing past its time, when a round runs, then signup steps are not touched and nothing is said", async () => {
    // given
    await store.recordIdentityEvent({ id: "ide_old", identityId: "idn_a", at: daysAgo(100), kind: "signup.started", provider: "google", emailDomain: "example.invalid", org: null });

    // when
    const report = await cleanupRound(store, [{ store, tenant: "acme" } as OrchestratorContext], { signupDays: 0 }, NOW);

    // then
    expect(cleanupSummary(report)).toBeNull();
    expect(await store.identityEventsSince("2000-01-01T00:00:00.000Z")).toHaveLength(1);
  });
});
