import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createUser, principalOf, setupFirstOwner, startSession } from "../server/accounts.js";
import { createApp } from "../server/app.js";
import type { OrchestratorContext } from "../server/app.js";
import { CSRF_HEADER, sessionCookie } from "../server/auth.js";
import { createRunnerService } from "../server/runner-service.js";
import { openSqliteStore } from "../server/store.js";
import type { TaskRecord } from "../server/tasks/types.js";
import { connect } from "./connect.js";
import { httpLink } from "./http-link.js";
import type { TaskOutcome } from "./link.js";
import { startRunnerLoop } from "./loop.js";
import type { Fetch } from "./profile.js";
import { FENCE_MS, RENEW_MS } from "./task.js";
import type { ExecutorHooks, TaskExecutor } from "./task.js";

const MAX = "max@example.invalid";
const WORK = (id: string) => ({ prompt: "Task: Add a note", mode: "auto" as const, choices: null, repo: { url: "https://gitlab.example.invalid/acme/payments-skills.git", baseBranch: "main", baseSha: "a".repeat(40) }, branch: `task/${id}`, rules: [], setup: { plugin: null, mcpTools: [], deniedTools: [] }, limits: { timeoutMs: 1_800_000, testCommand: null } });
const task = (id: string): TaskRecord => ({ tenant: "acme", id, repoId: "payments-skills", team: "Payments", title: "Add a note", description: "", issueUrl: null, issueKey: null, agent: "fake", status: "queued", createdBy: MAX, createdAt: new Date().toISOString(), startedAt: null, finishedAt: null, baseSha: null, tests: null, cost: { usd: null, inputTokens: null, outputTokens: null }, requestNumber: null, error: null, runner: "local" });

/** A team's orchestrator in this process behind a line that can be cut, as a deploy or a proxy cuts it. */
async function orchestratorBehindALine() {
  const store = openSqliteStore(":memory:");
  const owner = await principalOf(store, await setupFirstOwner(store, "acme", "code", { code: "code", email: "ada@example.invalid", password: "correct horse battery" }));
  const max = await createUser(store, "acme", new Set(["Payments"]), { email: MAX, role: "member", password: "correct horse battery" }, owner);
  const ctx: OrchestratorContext = { store, dataDir: "unused", tenant: "acme", allowedHosts: null, runnerService: createRunnerService({ tenant: "acme", store, describeWork: async (id) => WORK(id) }) };
  const app = createApp(ctx);
  const line = { down: false };
  const fetchImpl: Fetch = async (input, init) => {
    if (line.down) throw new TypeError("fetch failed");
    const url = new URL(String(input));
    return app.request(url.pathname + url.search, init);
  };
  const cookie = `${sessionCookie("acme")}=${(await startSession(store, "acme", max.id)).token}`;
  const { csrf } = await (await app.request("/api/me", { headers: { cookie } })).json();
  const { code } = await (await app.request("/api/machines/pair", { method: "POST", headers: { cookie, [CSRF_HEADER]: csrf, "content-type": "application/json" }, body: "{}" })).json();
  return { store, line, fetchImpl, code: code as string };
}

/** An agent that says one thing, waits for the test, then says another and ends; stopped, it ends interrupted. */
function heldAgent() {
  let hooks: ExecutorHooks | null = null;
  let finish: () => void = () => {};
  const executor: TaskExecutor = {
    run: (_task, given) =>
      new Promise<TaskOutcome>((resolve) => {
        hooks = given;
        given.onEvent({ type: "message", text: "before the outage" });
        finish = () => {
          given.onEvent({ type: "message", text: "after the outage" });
          resolve({ status: "needs-review", error: null, nativeSessionId: null, branch: "task/t", position: null, request: null });
        };
        given.signal.addEventListener("abort", () => resolve({ status: "interrupted", error: String(given.signal.reason), nativeSessionId: null, branch: null, position: null, request: null }));
      }),
  };
  return { executor, hooks: () => hooks, finish: () => finish() };
}

const settle = async (ms: number) => {
  await vi.advanceTimersByTimeAsync(ms);
};

describe("a machine's runner when the line to its orchestrator is cut", () => {
  let dataDir: string;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    dataDir = mkdtempSync(join(tmpdir(), "runner-outage-"));
  });
  afterEach(() => {
    vi.useRealTimers();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("given a task running, when the line is down for less than the fence, then the runner keeps its agent, sends what it said once the line is back, and the task ends for review", async () => {
    const org = await orchestratorBehindALine();
    const profile = await connect({ address: "https://orchestrator.example.invalid", code: org.code, dataDir, name: "max-laptop", platform: "darwin-arm64", fetch: org.fetchImpl });
    await org.store.createTask(task("tsk_cut_1"));
    const agent = heldAgent();
    const loop = startRunnerLoop(httpLink(profile, org.fetchImpl), agent.executor, { mask: (t) => t });
    await settle(1_000);

    org.line.down = true;
    await settle(FENCE_MS - RENEW_MS);
    expect(agent.hooks()!.signal.aborted).toBe(false);
    org.line.down = false;
    await settle(RENEW_MS);
    agent.finish();
    await settle(5_000);
    const stopping = loop.stop();
    await settle(30_000);
    await stopping;

    expect((await org.store.getTask("acme", "tsk_cut_1"))!.status).toBe("needs-review");
    expect((await org.store.taskLog("acme", "tsk_cut_1", 0)).map((l) => l.text)).toEqual(["before the outage", "after the outage"]);
  });

  it("given a task running, when the line stays down past the fence, then the runner stops its agent, reports nothing, and the orchestrator holds the task as interrupted once the lease runs out", async () => {
    const org = await orchestratorBehindALine();
    const profile = await connect({ address: "https://orchestrator.example.invalid", code: org.code, dataDir, name: "max-laptop", platform: "darwin-arm64", fetch: org.fetchImpl });
    await org.store.createTask(task("tsk_cut_2"));
    const agent = heldAgent();
    const loop = startRunnerLoop(httpLink(profile, org.fetchImpl), agent.executor, { mask: (t) => t });
    await settle(1_000);

    org.line.down = true;
    await settle(FENCE_MS + RENEW_MS);
    expect(agent.hooks()!.signal.aborted).toBe(true);
    await settle(60_000);
    await org.store.expireLeases(new Date().toISOString());
    const stopping = loop.stop();
    await settle(30_000);
    await stopping;

    expect((await org.store.getTask("acme", "tsk_cut_2"))!.status).toBe("interrupted");
  });
});
