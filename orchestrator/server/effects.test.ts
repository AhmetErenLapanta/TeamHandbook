import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { effectWorker, EffectRefused, retryDelayMs } from "./effects.js";
import type { EffectHandler, EffectInput } from "./effects.js";
import { Metrics } from "./metrics.js";
import { openSqliteStore } from "./store.js";
import type { Store } from "./store.js";
import type { TaskRecord } from "./tasks/types.js";

let dir: string;
let store: Store;
let clock: number;
const START = Date.parse("2026-11-02T10:00:00.000Z");

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "th-effects-"));
  store = openSqliteStore(join(dir, "orchestrator.db"));
  clock = START;
});

afterEach(async () => {
  await store.close();
  rmSync(dir, { recursive: true, force: true });
});

const task = (id: string): TaskRecord => ({ tenant: "acme", id, repoId: "payments-skills", team: "Payments", title: "t", description: "", issueUrl: null, issueKey: null, agent: "fake", status: "queued", createdBy: "ada@example.invalid", createdAt: new Date(START).toISOString(), startedAt: null, finishedAt: null, baseSha: null, tests: null, cost: { usd: null, inputTokens: null, outputTokens: null }, requestNumber: null, error: null });

async function queue(taskId: string, ...effects: EffectInput[]): Promise<void> {
  await store.commitCommand({ tenant: "acme", taskId, at: new Date(clock).toISOString(), createTask: task(taskId), effects });
}

function worker(handlers: Record<string, EffectHandler>, counted = new Metrics()) {
  return { counted, run: effectWorker({ store, handlers, by: "w1", tenants: () => ["acme"], now: () => new Date(clock), counted }) };
}

const move = (column: string): EffectInput => ({ kind: "tracker.move", payload: { issue: "PAY-1", column }, replay: "replay-safe" });

describe("the effect worker", () => {
  it("given a task's two effects, when the worker drains, then each is carried out in order once and counted", async () => {
    // given
    const seen: string[] = [];
    await queue("tsk_a", move("In progress"), move("Review"));
    const { counted, run } = worker({ "tracker.move": async (e) => (seen.push(String(e.payload.column)), `moved to ${e.payload.column}`) });

    // when
    const done = await run.drain();

    // then
    expect([done, seen]).toEqual([2, ["In progress", "Review"]]);
    expect((await store.taskEffects("acme", "tsk_a")).map((e) => [e.status, e.result])).toEqual([["done", "moved to In progress"], ["done", "moved to Review"]]);
    expect([...counted.effects]).toEqual([["tracker.move\0done", 2]]);
  });

  it("given a handler that keeps failing, when the worker drains as time passes, then it is tried again after 100, 200, 400 and 800 ms and fails at the fifth attempt with its last error", async () => {
    // given
    await queue("tsk_a", move("Review"));
    let calls = 0;
    const { run } = worker({ "tracker.move": async () => Promise.reject(new Error(`the tracker did not answer (${++calls})`)) });

    // when
    const waits: number[] = [];
    await run.drain();
    for (let attempt = 1; attempt < 5; attempt += 1) {
      const due = Date.parse((await store.taskEffects("acme", "tsk_a"))[0]!.dueAt);
      waits.push(due - clock);
      clock = due - 1;
      expect(await run.drain()).toBe(0);
      clock = due;
      await run.drain();
    }

    // then
    expect(waits).toEqual([100, 200, 400, 800]);
    expect((await store.taskEffects("acme", "tsk_a"))[0]).toMatchObject({ status: "failed", attempts: 5, lastError: "the tracker did not answer (5)" });
  });

  it("given a handler that refuses, a kind no handler knows and an error that carries a token, when the worker drains, then the first two fail at once and the third's error is kept masked", async () => {
    // given
    await queue("tsk_a", move("Gone"));
    await queue("tsk_b", { kind: "unknown.kind", payload: {}, replay: "replay-safe" });
    await queue("tsk_c", { kind: "review.check", payload: { sha: "abc" }, replay: "replay-safe" });
    const { run } = worker({
      "tracker.move": async () => Promise.reject(new EffectRefused("the issue is gone")),
      "review.check": async () => Promise.reject(new Error(`the forge said no to ghp_${"a".repeat(36)}`)),
    });

    // when
    await run.drain();

    // then
    expect((await store.taskEffects("acme", "tsk_a"))[0]).toMatchObject({ status: "failed", attempts: 1, lastError: "the issue is gone" });
    expect((await store.taskEffects("acme", "tsk_b"))[0]).toMatchObject({ status: "failed", lastError: "no handler carries out unknown.kind effects" });
    const masked = (await store.taskEffects("acme", "tsk_c"))[0]!;
    expect(masked.status).toBe("pending");
    expect(masked.lastError).toMatch(/^\[withheld: /);
    expect(masked.lastError).not.toContain("ghp_");
  });

  it("given effects of three tasks, when the worker is started with two loops and stopped once they are done, then every effect is carried out", async () => {
    // given
    await queue("tsk_a", move("One"));
    await queue("tsk_b", move("Two"));
    await queue("tsk_c", move("Three"));
    const done = new Set<string>();
    const run = effectWorker({ store, handlers: { "tracker.move": async (e) => (done.add(e.taskId), null) }, by: "w1", tenants: () => ["acme"], concurrency: 2, idleMs: 10, counted: new Metrics() });

    // when
    run.start();
    for (let i = 0; i < 200 && done.size < 3; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    await run.stop();

    // then
    expect([...done].sort()).toEqual(["tsk_a", "tsk_b", "tsk_c"]);
  });

  it("given the attempts so far, when the next wait is worked out, then it doubles from 100 ms and stops at 30 s", () => {
    expect([1, 2, 3, 9, 10, 20].map(retryDelayMs)).toEqual([100, 200, 400, 25_600, 30_000, 30_000]);
  });
});
