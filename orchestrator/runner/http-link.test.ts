import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createUser, principalOf, setupFirstOwner, startSession } from "../server/accounts.js";
import { createApp } from "../server/app.js";
import type { OrchestratorContext } from "../server/app.js";
import { CSRF_HEADER, sessionCookie } from "../server/auth.js";
import { createRunnerService } from "../server/runner-service.js";
import { openSqliteStore } from "../server/store.js";
import type { TaskRecord } from "../server/tasks/types.js";
import { BATCH_BYTES, EVENTS_PER_BATCH } from "../shared/runner-wire.js";
import { connect } from "./connect.js";
import { MachineRefused, batches, httpLink } from "./http-link.js";
import type { NumberedEvent, TaskOutcome } from "./link.js";
import { startRunnerLoop } from "./loop.js";
import { startMachineRunner } from "./machine.js";
import { orgDir } from "./profile.js";
import { RunnerState } from "./state.js";
import type { Fetch } from "./profile.js";
import type { TaskExecutor } from "./task.js";

const ADDRESS = "https://orchestrator.example.invalid";
const MAX = "max@example.invalid";
const WORK = { prompt: "Task: Add a note", mode: "approval-required" as const, choices: null, repo: { url: "https://gitlab.example.invalid/acme/payments-skills.git", baseBranch: "main", baseSha: "a".repeat(40) }, branch: "", rules: [], setup: { plugin: { name: "payments", version: "1.4.0" }, mcpTools: [], deniedTools: ["WebFetch"] }, limits: { timeoutMs: 1_800_000, testCommand: null } };

const task = (id: string): TaskRecord => ({ tenant: "acme", id, repoId: "payments-skills", team: "Payments", title: "Add a note", description: "", issueUrl: null, issueKey: null, agent: "fake", status: "queued", createdBy: MAX, createdAt: new Date().toISOString(), startedAt: null, finishedAt: null, baseSha: null, tests: null, cost: { usd: null, inputTokens: null, outputTokens: null }, requestNumber: null, error: null, runner: "local" });

/** A team's orchestrator answered in this process, with Max signed in to a browser; no address resolves and no byte leaves the machine. */
async function orchestrator() {
  const store = openSqliteStore(":memory:");
  const owner = await principalOf(store, await setupFirstOwner(store, "acme", "code", { code: "code", email: "ada@example.invalid", password: "correct horse battery" }));
  const max = await createUser(store, "acme", new Set(["Payments"]), { email: MAX, role: "member", password: "correct horse battery" }, owner);
  const service = createRunnerService({ tenant: "acme", store, describeWork: async (id) => ({ ...WORK, branch: `task/${id}` }) });
  const ctx: OrchestratorContext = { store, dataDir: "unused", tenant: "acme", allowedHosts: null, runnerService: service };
  const app = createApp(ctx);
  const fetchImpl: Fetch = async (input, init) => {
    const url = new URL(String(input));
    return app.request(url.pathname + url.search, init);
  };
  const cookie = `${sessionCookie("acme")}=${(await startSession(store, "acme", max.id)).token}`;
  const { csrf } = await (await app.request("/api/me", { headers: { cookie } })).json();
  const browser = (path: string, method: string, body?: unknown) => app.request(path, { method, headers: { cookie, [CSRF_HEADER]: csrf, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { store, service, fetchImpl, browser };
}

describe("a machine's runner reaching a team's orchestrator over HTTP", () => {
  let dataDir: string;
  beforeEach(() => void (dataDir = mkdtempSync(join(tmpdir(), "runner-http-"))));
  afterEach(() => rmSync(dataDir, { recursive: true, force: true }));

  it("given Max's paired machine and his task queued, when its runner takes it with the task's whole description, asks and is answered, then events, the question, the answer, the request it opened and the outcome all travel the signed calls, and a request the orchestrator cannot match is not taken", async () => {
    const org = await orchestrator();
    const { code } = await (await org.browser("/api/machines/pair", "POST", {})).json();
    const profile = await connect({ address: ADDRESS, code, dataDir, name: "max-laptop", platform: "darwin-arm64", fetch: org.fetchImpl });
    await org.store.upsertRepo({ id: "payments-skills", tenant: "acme", team: "Payments", name: "payments-skills", url: "https://gitlab.example.invalid/acme/payments-skills.git" });
    await org.store.createTask(task("tsk_http_1"));
    const outcome: TaskOutcome = { status: "needs-review", error: null, nativeSessionId: null, branch: "task/tsk_http_1", position: null, request: null };
    let answered: unknown = null;
    let verdict: unknown = null;
    let given: unknown = null;
    const executor: TaskExecutor = {
      async run(leased, hooks) {
        given = leased.work;
        hooks.log("Checked out payments-skills.");
        hooks.record({ baseSha: "abc1234000000000000000000000000000000000" });
        hooks.record({ branch: "task/tsk_http_1" });
        answered = await hooks.decide({ id: "toolu_1", kind: "command", tool: "Bash", summary: "npm test" });
        hooks.onEvent({ type: "message", text: "done" });
        verdict = await hooks.reportRequest!({ number: 7, url: "https://gitlab.example.invalid/acme/payments-skills/-/merge_requests/7", headSha: "d".repeat(40) });
        return outcome;
      },
    };
    const loop = startRunnerLoop(httpLink(profile, org.fetchImpl), executor, { mask: (t) => t });

    let asked = null as Awaited<ReturnType<typeof org.store.taskRequests>>[number] | null;
    for (let i = 0; i < 100 && !asked; i++) {
      [asked = null] = (await org.store.taskRequests("acme", "tsk_http_1")).filter((r) => r.status === "pending");
      if (!asked) await new Promise((r) => setTimeout(r, 50));
    }
    await org.store.answerTaskRequest("acme", asked!.id, { decision: "allow_once" }, MAX, "web", new Date().toISOString());
    org.service.wake();
    for (let i = 0; i < 100 && (await org.store.getTask("acme", "tsk_http_1"))!.status !== "needs-review"; i++) await new Promise((r) => setTimeout(r, 50));
    await loop.stop();

    expect(given).toEqual({ ...WORK, branch: "task/tsk_http_1", setup: { ...WORK.setup, ownSetup: false, folderSettings: false } });
    expect(answered).toEqual({ decision: "allow-once" });
    expect(verdict).toMatchObject({ ok: false, reason: expect.any(String) });
    expect((await org.store.getTask("acme", "tsk_http_1"))!).toMatchObject({ status: "needs-review", baseSha: "abc1234000000000000000000000000000000000" });
    expect((await org.store.taskLog("acme", "tsk_http_1", 0)).map((l) => l.text)).toEqual(["Checked out payments-skills.", "done"]);
    expect(await org.store.taskLease("acme", "tsk_http_1")).toMatchObject({ claimedBy: profile.machineId, leaseId: null });
  });

  it("given a machine its person removed in Settings, when its runner polls, then it is told the orchestrator no longer takes it", async () => {
    const org = await orchestrator();
    const { code } = await (await org.browser("/api/machines/pair", "POST", {})).json();
    const profile = await connect({ address: ADDRESS, code, dataDir, name: "max-laptop", platform: "darwin-arm64", fetch: org.fetchImpl });
    expect((await org.browser(`/api/machines/${profile.machineId}`, "DELETE")).ok).toBe(true);

    await expect(httpLink(profile, org.fetchImpl).poll(0, true, new AbortController().signal)).rejects.toBeInstanceOf(MachineRefused);
  });

  it("given more events than one call carries, when they are split, then no part passes the count or the size and none is lost", () => {
    const big = "x".repeat(4_000);
    const events: NumberedEvent[] = Array.from({ length: 1_200 }, (_, i) => ({ n: i + 1, event: { type: "output", text: big } }));

    const parts = batches(events);

    expect(parts.flat().map((e) => e.n)).toEqual(events.map((e) => e.n));
    expect(Math.max(...parts.map((p) => p.length))).toBeLessThanOrEqual(EVENTS_PER_BATCH);
    expect(Math.max(...parts.map((p) => Buffer.byteLength(JSON.stringify(p))))).toBeLessThanOrEqual(BATCH_BYTES + 1_000);
  });

  it("given a machine paired with a team and an agent a crash left running for it, when its runner starts, then that agent is ended, its agents and what it can do show on its row, the team's next task runs, and stopping still reports the end", async () => {
    const org = await orchestrator();
    const { code } = await (await org.browser("/api/machines/pair", "POST", {})).json();
    await connect({ address: ADDRESS, code, dataDir, name: "max-laptop", platform: "darwin-arm64", fetch: org.fetchImpl });
    new RunnerState(join(orgDir(dataDir, "acme"), "processes.json")).add({ taskId: "tsk_old", pgid: 4343, root: "/stand-in/tasks/tsk_old" });
    const killed: number[] = [];
    let ran: string | null = null;
    const executor: TaskExecutor = {
      run: (leased, hooks) =>
        new Promise((resolve) => {
          ran = leased.id;
          hooks.signal.addEventListener("abort", () => resolve({ status: "interrupted", error: (hooks.signal.reason as Error).message, nativeSessionId: null, branch: null, position: null, request: null }));
        }),
    };
    await org.store.createTask(task("tsk_http_2"));

    const machine = startMachineRunner({ dataDir, home: dataDir, executor, fetch: org.fetchImpl, mask: (t) => t, kill: (pgid) => (killed.push(pgid), true), agents: async () => [{ id: "claude-code", installed: true, version: "2.1.316", supported: "ok", signIn: "signed-in" }] });
    for (let i = 0; i < 100 && !ran; i++) await new Promise((r) => setTimeout(r, 20));
    await machine.stop();

    expect(machine.orgs).toEqual(["acme"]);
    expect(killed).toEqual([4343]);
    expect(ran).toBe("tsk_http_2");
    expect((await org.store.getTask("acme", "tsk_http_2"))!.status).toBe("interrupted");
    expect((await org.store.listMachines("acme", null))[0]!.agents).toEqual([{ id: "claude-code", installed: true, version: "2.1.316", supported: "ok", signIn: "signed-in" }]);
    expect((await org.store.listMachines("acme", null))[0]!.features).toEqual(["workspace-continues"]);
  });
});
