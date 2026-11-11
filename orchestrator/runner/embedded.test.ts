import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRunnerService } from "../server/runner-service.js";
import { memoryStore, task } from "../server/runner-service.fixture.js";
import { RESTARTED, startEmbeddedRunner } from "./embedded.js";
import { RunnerState } from "./state.js";
import type { TaskExecutor } from "./task.js";

const ADA = "ada@example.invalid";
const mask = (text: string) => text;

describe("the runner inside a local orchestrator", () => {
  let dataDir: string;
  beforeEach(() => {
    vi.useFakeTimers();
    dataDir = mkdtempSync(join(tmpdir(), "embedded-runner-"));
  });
  afterEach(() => {
    vi.useRealTimers();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("given a crash that left an agent running and its task leased, when the orchestrator starts again, then the agent is ended and the task is interrupted with Continue", async () => {
    const mem = memoryStore();
    mem.queued.push(task("tsk-1", ADA));
    const service = createRunnerService({ tenant: "acme", store: mem.store });
    await service.poll(ADA, "this-machine", 0, true, new AbortController().signal);
    await service.request("tsk-1", mem.leases.get("tsk-1")!.leaseId, { id: "toolu_1", kind: "command", tool: "Bash", summary: "npm test" });
    new RunnerState(join(dataDir, "runner", "local", "processes.json")).add({ taskId: "tsk-1", pgid: 4242, root: "/stand-in/tasks/tsk-1" });
    const killed: number[] = [];

    const started = await startEmbeddedRunner({ service, person: ADA, holder: "this-machine", executor: { run: () => new Promise(() => {}) }, dataDir, mask, kill: (pgid) => (killed.push(pgid), true) });

    expect(killed).toEqual([4242]);
    expect(started).toMatchObject({ recovered: ["tsk-1"], ended: 1 });
    expect(mem.ended["tsk-1"]).toEqual({ status: "interrupted", error: RESTARTED, nativeSession: null, branch: null });
    expect(mem.requests[0]).toMatchObject({ status: "expired", responseCapability: "not_resumable" });
    expect(new RunnerState(join(dataDir, "runner", "local", "processes.json")).read()).toEqual([]);
    const stopping = started.loop.stop();
    await vi.advanceTimersByTimeAsync(2_000);
    await stopping;
  });

  it("given a task whose agent started, when it runs and when it ends, then its process group is on record for its user alone and gone afterwards", async () => {
    const mem = memoryStore();
    const service = createRunnerService({ tenant: "acme", store: mem.store });
    const file = join(dataDir, "runner", "local", "processes.json");
    let seenWhileRunning: unknown = null;
    const executor: TaskExecutor = {
      async run(_task, hooks) {
        hooks.onProcess(5151, "/stand-in/tasks/tsk-2");
        seenWhileRunning = JSON.parse(readFileSync(file, "utf8"));
        return { status: "needs-review", error: null, nativeSessionId: null, branch: "handbook/tsk-2", position: null, request: null };
      },
    };
    const started = await startEmbeddedRunner({ service, person: ADA, holder: "this-machine", executor, dataDir, mask, kill: () => false });

    mem.queued.push(task("tsk-2", ADA));
    service.wake();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(seenWhileRunning).toEqual([{ taskId: "tsk-2", pgid: 5151, root: "/stand-in/tasks/tsk-2" }]);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(new RunnerState(file).read()).toEqual([]);
    expect(mem.ended["tsk-2"]?.status).toBe("needs-review");
    const stopping = started.loop.stop();
    await vi.advanceTimersByTimeAsync(2_000);
    await stopping;
  });
});
