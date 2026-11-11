import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OrchestratorContext } from "./app.js";
import { effectOf, startEffects } from "./effect-handlers.js";
import { taskPaths } from "./tasks/isolation.js";
import type { EffectDefinition } from "./effect-handlers.js";
import { openSqliteStore } from "./store.js";
import type { Store } from "./store.js";
import type { TaskRecord } from "./tasks/types.js";

let dir: string;
let store: Store;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "th-effect-handlers-"));
  store = openSqliteStore(join(dir, "orchestrator.db"));
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await store.close();
  rmSync(dir, { recursive: true, force: true });
});

const task = (tenant: string, id: string): TaskRecord => ({ tenant, id, repoId: "payments-skills", team: "Payments", title: "t", description: "", issueUrl: null, issueKey: null, agent: "fake", status: "queued", createdBy: "ada@example.invalid", createdAt: new Date().toISOString(), startedAt: null, finishedAt: null, baseSha: null, tests: null, cost: { usd: null, inputTokens: null, outputTokens: null }, requestNumber: null, error: null });

async function queue(tenant: string, taskId: string, kind: string): Promise<void> {
  await store.commitCommand({ tenant, taskId, at: new Date().toISOString(), createTask: task(tenant, taskId), effects: [{ kind, payload: { column: "Review" }, replay: "replay-safe" }] });
}

async function settled(tenant: string, taskId: string): Promise<string> {
  for (let i = 0; i < 300; i += 1) {
    const [effect] = await store.taskEffects(tenant, taskId);
    if (effect && effect.status !== "pending") return effect.status;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return "pending";
}

describe("the effects a process carries out", () => {
  it("given a defined kind queued for a served organization and one for an organization this process does not serve, when the effects start, then the first runs with its organization's context and the second is left for the process that serves it", async () => {
    // given
    const seen: string[] = [];
    const definitions: Record<string, EffectDefinition> = { "tracker.move": { replay: "replay-safe", run: async (ctx, effect) => (seen.push(`${ctx.tenant}:${effect.payload.column}`), "moved") } };
    const served = [{ tenant: "acme" } as OrchestratorContext];
    await queue("acme", "tsk_a", "tracker.move");
    await queue("globex", "tsk_b", "tracker.move");

    // when
    const stop = startEffects(store, () => served, "test-worker", definitions);
    const ours = await settled("acme", "tsk_a");
    await stop();

    // then
    expect([ours, seen]).toEqual(["done", ["acme:Review"]]);
    expect((await store.taskEffects("globex", "tsk_b"))[0]!.status).toBe("pending");
  });

  it("given no kind defined, when the effects start, then no worker runs and a queued effect stays pending", async () => {
    // given
    await queue("acme", "tsk_a", "tracker.move");

    // when
    const stop = startEffects(store, () => [{ tenant: "acme" } as OrchestratorContext], "test-worker", {});
    await new Promise((resolve) => setTimeout(resolve, 50));
    await stop();

    // then
    expect((await store.taskEffects("acme", "tsk_a"))[0]).toMatchObject({ status: "pending", attempts: 0 });
  });

  it("given a finished task's checkout, git directory and container, when its cleanup effect runs, then all three are gone and the effect is done, the container named after the task", async () => {
    // given
    const ctx = { tenant: "acme", dataDir: join(dir, "data") } as OrchestratorContext;
    const paths = taskPaths(ctx.dataDir, "acme", "tsk_a");
    for (const d of [paths.work, paths.git]) mkdirSync(d, { recursive: true });
    writeFileSync(join(paths.work, "left.txt"), "x");
    const bin = join(dir, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "docker"), `#!/bin/sh\necho "$*" >> ${join(dir, "docker-calls")}\nexit 0\n`);
    chmodSync(join(bin, "docker"), 0o755);
    vi.stubEnv("PATH", `${bin}:${process.env.PATH}`);
    await store.commitCommand({ tenant: "acme", taskId: "tsk_a", at: new Date().toISOString(), createTask: task("acme", "tsk_a"), effects: [effectOf("task.cleanup", { container: true })] });

    // when
    const stop = startEffects(store, () => [ctx], "test-worker");
    const status = await settled("acme", "tsk_a");
    await stop();

    // then
    expect(status).toBe("done");
    expect([existsSync(paths.root), existsSync(paths.git)]).toEqual([false, false]);
    expect(readFileSync(join(dir, "docker-calls"), "utf8").trim()).toBe("rm -f teamhandbook-task-acme-tsk_a");
  });
});
