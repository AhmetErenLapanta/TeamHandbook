import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rmSync } from "node:fs";
import { join } from "node:path";
import type { MiddlewareHandler } from "hono";
import { createApp } from "../app.js";
import type { OrchestratorEnv, Principal } from "../auth.js";
import { git } from "../git.js";
import { seededContext, storePrincipals } from "../test-fixtures.js";
import { fakeAgentAdapter } from "./agents.js";
import { MODEL_HOST, MODEL_KEY_STAND_IN } from "./egress.js";
import { createTaskRunner, NO_RUNNER } from "./runner.js";
import type { RunnerService } from "../runner-service.js";
import { machineProjectUrl } from "../projects.js";

const OWNER: Principal = { id: "o", name: "Olu Example", email: "olu@example.invalid", role: "owner", ownedTeams: [] };
const RUNNER_KEY = "sk-ant-api03-the-runner-key-0123456789abcdef";
const FAKE_AGENT = join(import.meta.dirname, "..", "..", "demo", "fake-agent.mjs");

const dirs: string[] = [];
beforeEach(() => vi.stubEnv("ORCHESTRATOR_MODE", "cloud"));
afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const as = (user: Principal): MiddlewareHandler<OrchestratorEnv> => async (c, next) => {
  c.set("user", user);
  await next();
};

/** A cloud orchestrator's demo organization; `runnerKey` is the operator's model key on the runner, if any. */
async function cloud(runnerKey?: string) {
  // Short, as a cloud orchestrator's data directory is: a task's proxy listens on a socket whose path has a limit.
  const { ctx, root, config } = await seededContext("th-cl-", undefined, "main", "/tmp");
  await storePrincipals(ctx, OWNER);
  dirs.push(root);
  // The stand-in calls no model; the same script as an agent that names a model credential stands in for one that does.
  const modelled = { ...fakeAgentAdapter(FAKE_AGENT), id: "modelled", label: "Stand-in with a model", credentialEnv: ["ANTHROPIC_API_KEY"] };
  ctx.tasks = createTaskRunner(ctx, { agents: [fakeAgentAdapter(FAKE_AGENT), modelled], isolation: { mode: "process", network: "open" }, testCommand: () => null, hostEnv: { PATH: process.env.PATH, ...(runnerKey ? { ANTHROPIC_API_KEY: runnerKey } : {}) }, cloud: true });
  const bare = new URL(config.repos.find((r) => r.id === "payments-skills")!.url).pathname;
  const call = (method: string, path: string, body?: unknown) => createApp(ctx, as(OWNER)).request(path, { method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { ctx, call, bare };
}

// Each case copies the seeded demo, and most run the stand-in through the proxy; on a busy machine that takes most of a minute.
describe("a task on a cloud orchestrator", { timeout: 120_000 }, () => {
  it("given no model key on the runner, when a task starts on an agent that calls a model, then it is refused before it waits in line, saying no runner carries it", async () => {
    // given
    const { ctx, call } = await cloud();

    // when
    const res = await call("POST", "/api/tasks", { repoId: "payments-skills", title: "Add the refund note", agent: "modelled" });

    // then
    expect([res.status, await res.json()]).toEqual([409, { error: NO_RUNNER, code: "no-runner" }]);
    expect((await ctx.store.taskPage(ctx.tenant, {}, null, 1)).tasks).toEqual([]);
  });

  it("given no model key on the runner and a connected machine of its person's, when a task starts on an agent that calls a model, then it is taken and waits for that machine, which runs it on the person's own sign-in", async () => {
    // given
    const { ctx, call } = await cloud();
    ctx.runnerService = { wake: () => {}, stop: () => {} } as unknown as RunnerService;

    // when
    const res = await call("POST", "/api/tasks", { repoId: "payments-skills", title: "Add the refund note", agent: "modelled" });

    // then
    expect(res.status).toBe(201);
    expect((await res.json()).task).toMatchObject({ status: "queued", runner: "local" });
  });

  it("given a folder without git on its person's connected machine, which the orchestrator never reads, and no model key on the runner, when the person starts a task there, then it is taken and waits for that machine", async () => {
    // given
    const { ctx, call } = await cloud();
    ctx.runnerService = { wake: () => {}, stop: () => {} } as unknown as RunnerService;
    await ctx.store.upsertRepo({ tenant: ctx.tenant, id: "shop", team: "Payments", name: "shop", url: machineProjectUrl("mch_laptop", "~/code/shop") });
    const seen = new Date().toISOString();
    await ctx.store.insertMachine({ tenant: ctx.tenant, id: "mch_laptop", userId: OWNER.id, name: "laptop", platform: "darwin", publicKey: "", agents: [], createdAt: seen, lastSeenAt: seen, revokedAt: null, tokenHash: "0".repeat(64) }, null);

    // when
    const res = await call("POST", "/api/tasks", { repoId: "shop", title: "Add a price list", agent: "modelled" });

    // then
    expect(res.status).toBe(201);
    expect((await res.json()).task).toMatchObject({ repoId: "shop", status: "queued", runner: "local" });
  });

  it("given no model key on the runner, when skills are suggested for an agent that calls a model, then none is suggested and the answer says why", async () => {
    // given
    const { call } = await cloud();

    // when
    const body = await (await call("POST", "/api/tasks/skill-suggestions", { repoId: "payments-skills", agent: "modelled" })).json();

    // then
    expect(body).toMatchObject({ suggestions: [], note: NO_RUNNER });
  });

  it("given an agent that calls no model, when its task runs, then it reaches its request through the proxy with no model route, and the start is in the event log", async () => {
    // given
    const { ctx, call } = await cloud();

    // when
    const started = (await (await call("POST", "/api/tasks", { repoId: "payments-skills", title: "Add the refund note", agent: "fake" })).json()).task;
    await ctx.tasks!.idle();

    // then
    expect((await ctx.store.getTask(ctx.tenant, started.id))?.status).toBe("needs-review");
    expect((await ctx.store.taskLog(ctx.tenant, started.id, 0)).map((l) => l.text)).toContain("The setup, the agent and the tests reach nothing, through the orchestrator's proxy.");
    expect((await ctx.store.eventPage(ctx.tenant, {}, null, 50)).events.filter((e) => e.kind === "task.started").map((e) => [e.subject, e.detail])).toEqual([[`task:${started.id}`, "Add the refund note on payments-skills"]]);
  });

  it("given the runner's model key, when a task runs on an agent that calls a model, then the agent holds only a stand-in key and the model host, and the runner's key never reaches it", async () => {
    // given
    const { ctx, call, bare } = await cloud(RUNNER_KEY);

    // when
    const started = (await (await call("POST", "/api/tasks", { repoId: "payments-skills", title: "Add the refund note", agent: "modelled", description: "stand-in: write env ANTHROPIC_API_KEY\nstand-in: print env ANTHROPIC_BASE_URL" })).json()).task;
    await ctx.tasks!.idle();

    // then
    const log = (await ctx.store.taskLog(ctx.tenant, started.id, 0)).map((l) => l.text);
    expect(git(["show", `task/${started.id}:env-ANTHROPIC_API_KEY.txt`], bare).trim()).toBe(MODEL_KEY_STAND_IN);
    expect(log).toContain(`ANTHROPIC_BASE_URL=http://${MODEL_HOST}`);
    expect(log).toContain("The setup, the agent and the tests reach nothing besides the model, through the orchestrator's proxy.");
    expect(log.join("\n")).not.toContain(RUNNER_KEY);
    expect((await ctx.store.getTask(ctx.tenant, started.id))?.status).toBe("needs-review");
  });

  it("given an orchestrator that no longer offers a model key page, when it is asked for, then there is no such page", async () => {
    // given
    const { call } = await cloud();

    // when
    const res = await call("GET", "/api/org/model-key");

    // then
    expect(res.status).toBe(404);
  });
});
