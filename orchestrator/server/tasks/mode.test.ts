import { rmSync } from "node:fs";
import { join } from "node:path";
import type { MiddlewareHandler } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import type { OrchestratorContext } from "../app.js";
import type { OrchestratorEnv, Principal } from "../auth.js";
import { seededContext, storePrincipals } from "../test-fixtures.js";
import { fakeAgentAdapter } from "./agents.js";
import type { AgentAdapter } from "./agents.js";
import { createTaskRunner } from "./runner.js";
import { startRefusals } from "./targets.js";

const ADMIN: Principal = { id: "a", name: "Ada Example", email: "ada@example.invalid", role: "admin", ownedTeams: [] };
const FAKE_AGENT = join(import.meta.dirname, "..", "..", "demo", "fake-agent.mjs");

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const as = (user: Principal): MiddlewareHandler<OrchestratorEnv> => async (c, next) => {
  c.set("user", user);
  await next();
};

async function orchestrator_(agent: AgentAdapter = fakeAgentAdapter(FAKE_AGENT)): Promise<{ ctx: OrchestratorContext; start: (body: Record<string, unknown>) => Response | Promise<Response> }> {
  const { ctx, root } = await seededContext("orchestrator-mode-", ["payments-skills"]);
  await storePrincipals(ctx, ADMIN);
  dirs.push(root);
  ctx.tasks = createTaskRunner(ctx, { agents: [agent], isolation: { mode: "process", network: "open" }, testCommand: () => null, hostEnv: { PATH: process.env.PATH } });
  const app = createApp(ctx, as(ADMIN));
  const start = (body: Record<string, unknown>) => app.request("/api/tasks", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ repoId: "payments-skills", title: "Add a note", agent: "fake", ...body }) });
  return { ctx, start };
}

describe("the mode a task runs in", { timeout: 120_000 }, () => {
  it("given a start that names no mode, when it is taken, then the task runs in Auto, says so, and the form is told each agent's modes", async () => {
    // given
    const { ctx, start } = await orchestrator_();

    // when
    const res = await start({});
    const options = await (await createApp(ctx, as(ADMIN)).request("/api/tasks/options")).json();
    await ctx.tasks!.idle();

    // then
    expect(res.status).toBe(201);
    expect((await ctx.store.getTask(ctx.tenant, (await res.json()).task.id))!.mode).toBe("auto");
    expect(options.agents).toEqual([expect.objectContaining({ id: "fake", modes: ["approval-required", "auto-accept-edits", "auto"], options: [] })]);
  });

  it("given an agent that runs only in Auto, when modes it does not run in and a word that is no mode are asked for, then each is refused and no task waits", async () => {
    // given
    const { twoWay: _, ...oneRun } = fakeAgentAdapter(FAKE_AGENT);
    const { ctx, start } = await orchestrator_(oneRun);

    // when
    const asking = await start({ mode: "approval-required" });
    const full = await start({ mode: "full-access" });
    const made = await start({ mode: "yolo" });

    // then
    expect([asking.status, await asking.json()]).toEqual([409, { error: "this agent runs in Auto, not in Approval required", code: "mode-not-offered" }]);
    expect(full.status).toBe(409);
    expect([made.status, (await made.json()).error]).toEqual([400, "mode is one of approval-required, auto-accept-edits, auto, full-access"]);
    expect(await ctx.store.listTasks(ctx.tenant)).toEqual([]);
  });

  it("given choices the agent does not offer and choices that are not text, when each is asked for, then each is refused and no task waits", async () => {
    // given
    const { ctx, start } = await orchestrator_();

    // when
    const model = await start({ choices: { model: "opus" } });
    const shape = await start({ choices: { model: 4 } });

    // then
    expect([model.status, (await model.json()).error]).toEqual([400, "this agent offers no model choice"]);
    expect([shape.status, (await shape.json()).error]).toEqual([400, "choices names an option and the value picked for it, as text"]);
    expect(await ctx.store.listTasks(ctx.tenant)).toEqual([]);
  });

  it("given an agent that offers a model, when a task starts with one of its models, then the task keeps the choice and its agent is started with it", async () => {
    // given
    const stand = fakeAgentAdapter(FAKE_AGENT);
    const started: unknown[] = [];
    const offering: AgentAdapter = {
      ...stand,
      capabilities: { ...stand.capabilities, options: [{ id: "model", label: "Model", choices: [{ value: "opus", label: "Opus" }] }] },
      invocation: (paths, task, setup, personal) => {
        started.push(task.choices);
        return stand.invocation(paths, task, setup, personal);
      },
    };
    const { ctx, start } = await orchestrator_(offering);

    // when
    const res = await start({ choices: { model: "opus" } });
    await ctx.tasks!.idle();

    // then
    expect(res.status).toBe(201);
    expect((await ctx.store.getTask(ctx.tenant, (await res.json()).task.id))!.choices).toEqual({ model: "opus" });
    expect(started).toEqual([{ model: "opus" }]);
  });

  it("given a policy that holds Payments to Auto-accept edits, when a task starts naming no mode, then it runs in Auto-accept edits, the most its agent offers within that ceiling", async () => {
    // given
    const { ctx, start } = await orchestrator_();
    await ctx.store.putPolicy({ tenant: ctx.tenant, id: "pol_careful", name: "Payments edits only", audience: JSON.stringify({ kind: "workspace" }), rules: JSON.stringify([{ kind: "task-mode", ceiling: "auto-accept-edits", repos: ["payments-*"] }]), updatedAt: new Date().toISOString(), updatedBy: ADMIN.email });

    // when
    const res = await start({});
    await ctx.tasks!.idle();

    // then
    expect(res.status).toBe(201);
    expect((await ctx.store.getTask(ctx.tenant, (await res.json()).task.id))!.mode).toBe("auto-accept-edits");
  });

  it("given a policy that holds Payments to Auto-accept edits, when a task asks for Auto by name, then it is refused naming the mode to start it in, and no task waits", async () => {
    // given
    const { ctx, start } = await orchestrator_();
    await ctx.store.putPolicy({ tenant: ctx.tenant, id: "pol_careful", name: "Payments edits only", audience: JSON.stringify({ kind: "workspace" }), rules: JSON.stringify([{ kind: "task-mode", ceiling: "auto-accept-edits", repos: ["payments-*"] }]), updatedAt: new Date().toISOString(), updatedBy: ADMIN.email });

    // when
    const res = await start({ mode: "auto" });

    // then
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('"Payments edits only" lets tasks on payments-skills run up to Auto-accept edits; this task asked for Auto. Start it in Auto-accept edits or below.');
    expect(await ctx.store.listTasks(ctx.tenant)).toEqual([]);
  });

  it("given an agent that runs only in Auto and a ceiling below it, when a task starts naming no mode, then it is refused for the Auto it would run in, and no task waits", async () => {
    // given
    const { twoWay: _, ...oneRun } = fakeAgentAdapter(FAKE_AGENT);
    const { ctx, start } = await orchestrator_(oneRun);
    await ctx.store.putPolicy({ tenant: ctx.tenant, id: "pol_careful", name: "Payments edits only", audience: JSON.stringify({ kind: "workspace" }), rules: JSON.stringify([{ kind: "task-mode", ceiling: "auto-accept-edits", repos: ["payments-*"] }]), updatedAt: new Date().toISOString(), updatedBy: ADMIN.email });

    // when
    const res = await start({});

    // then
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('"Payments edits only" lets tasks on payments-skills run up to Auto-accept edits; this task runs in Auto. Start it in Auto-accept edits or below.');
    expect(await ctx.store.listTasks(ctx.tenant)).toEqual([]);
  });

  it("given a ceiling below Auto, when a start that names no mode is read against the policies, as skill suggestions and the repositories offered to a task are, then it passes, and one asking for Auto is refused", async () => {
    // given
    const { ctx } = await orchestrator_();
    await ctx.store.putPolicy({ tenant: ctx.tenant, id: "pol_ask", name: "Ask first", audience: JSON.stringify({ kind: "workspace" }), rules: JSON.stringify([{ kind: "task-mode", ceiling: "approval-required", repos: ["*"] }]), updatedAt: new Date().toISOString(), updatedBy: ADMIN.email });
    const repo = (await ctx.store.getRepo(ctx.tenant, "payments-skills"))!;

    // when
    const unnamed = (await startRefusals(ctx, ADMIN))(repo);
    const asked = (await startRefusals(ctx, ADMIN, undefined, "auto"))(repo);

    // then
    expect(unnamed).toBeNull();
    expect(asked?.code).toBe("task-mode");
  });
});
