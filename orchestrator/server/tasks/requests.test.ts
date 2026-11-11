import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { MiddlewareHandler } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import type { OrchestratorContext } from "../app.js";
import type { OrchestratorEnv, Principal } from "../auth.js";
import type { RunnerService } from "../runner-service.js";
import type { NewTaskRequest } from "../task-requests.js";
import { seededContext, storePrincipals } from "../test-fixtures.js";
import { fakeAgentAdapter } from "./agents.js";
import { createTaskRunner } from "./runner.js";
import { replayProgram, writeTranscript } from "./transcript.js";
import type { TaskRecord } from "./types.js";

const ADA: Principal = { id: "ada", name: "Ada Example", email: "ada@example.invalid", role: "member", ownedTeams: ["Payments"] };
const GRACE: Principal = { id: "grace", name: "Grace Example", email: "grace@example.invalid", role: "admin", ownedTeams: [] };

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const as = (user: Principal): MiddlewareHandler<OrchestratorEnv> => async (c, next) => {
  c.set("user", user);
  await next();
};

/** The seeded Payments repository, a runner whose stand-in agent holds until `release` exists, and Ada's task on it, running. */
async function running(): Promise<{ ctx: OrchestratorContext; task: TaskRecord; release: string }> {
  const { ctx, root } = await seededContext("orchestrator-requests-", ["payments-skills"]);
  await storePrincipals(ctx, ADA);
  dirs.push(root);
  const release = join(root, "release");
  const transcript = join(root, "held.ndjson");
  writeTranscript(transcript, { agent: "fake", cliVersion: "none", source: "hand", expect: { args: [], stdin: [] }, steps: [{ until: release }, { emit_inbound: { type: "result", summary: "Done." } }], exit: 0 }, []);
  ctx.tasks = createTaskRunner(ctx, { agents: [fakeAgentAdapter(replayProgram(root, transcript))], isolation: { mode: "process", network: "open" }, testCommand: () => null, hostEnv: { PATH: process.env.PATH } });
  const task = await ctx.tasks.start({ repo: (await ctx.store.getRepo(ctx.tenant, "payments-skills"))!, title: "Add a note", description: "", agent: "fake", user: ADA });
  return { ctx, task, release };
}

const asked = (ctx: OrchestratorContext, task: TaskRecord, kind: NewTaskRequest["kind"], id = "req-1") =>
  ctx.store.recordTaskRequest({ tenant: ctx.tenant, id, taskId: task.id, targetPosition: null, sourceKey: id, kind, payload: kind === "question" ? { questions: [{ key: "q1", title: "Which database?", choice: "text" }] } : { tool: "Bash", target: "npm test" }, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 600_000).toISOString() });

const answer = (ctx: OrchestratorContext, user: Principal, task: TaskRecord, id: string, body: unknown) =>
  createApp(ctx, as(user)).request(`/api/tasks/${task.id}/requests/${id}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

describe("what a task's agent asks, answered in the browser", { timeout: 120_000 }, () => {
  it("given a command the agent asks to run, when the task is read and the person who started it allows it once, then the read carries it, it is answered once, the runner's waiting poll is woken, the event log says so and a second answer is refused", async () => {
    // given
    const { ctx, task, release } = await running();
    await asked(ctx, task, "command");
    // The task's page draws its cards from the task it reads, so the read carries what the agent asked.
    const read = await (await createApp(ctx, as(ADA)).request(`/api/tasks/${task.id}`)).json();
    let woken = 0;
    ctx.runnerService = { wake: () => void (woken += 1) } as unknown as RunnerService;

    // when
    const first = await answer(ctx, ADA, task, "req-1", { answer: { decision: "allow_once" } });
    const again = await answer(ctx, ADA, task, "req-1", { answer: { decision: "deny" } });
    const listed = await (await createApp(ctx, as(ADA)).request(`/api/tasks/${task.id}/requests`)).json();
    writeFileSync(release, "");
    await ctx.tasks!.idle();

    // then
    expect(first.status).toBe(200);
    expect(woken).toBe(1);
    expect((await first.json()).request).toMatchObject({ id: "req-1", status: "answered", answer: { decision: "allow_once" }, answeredBy: ADA.email, answeredVia: "web" });
    expect([again.status, (await again.json()).error]).toEqual([409, "this request is no longer waiting for an answer"]);
    expect(listed.requests).toEqual([expect.objectContaining({ id: "req-1", status: "answered" })]);
    expect(listed.requests[0]).not.toHaveProperty("tenant");
    expect(read.task.requests).toEqual([expect.objectContaining({ id: "req-1", kind: "command", status: "pending" })]);
    expect((await ctx.store.eventPage(ctx.tenant, {}, null, 50)).events.filter((e) => e.kind === "task.request.answered")).toEqual([expect.objectContaining({ actor: expect.objectContaining({ email: ADA.email }), subject: `task:${task.id}`, detail: "answered the agent's command request with allow_once" })]);
  });

  it("given an admin who reads the task and an answer of the wrong shape, when each answers, then the admin is told there is no such request, the shape is refused and the request still waits", async () => {
    // given
    const { ctx, task, release } = await running();
    await asked(ctx, task, "secret");

    // when
    const byAdmin = await answer(ctx, GRACE, task, "req-1", { answer: { provided: true } });
    const withValue = await answer(ctx, ADA, task, "req-1", { answer: { text: "the-value-itself" } });
    const unknown = await answer(ctx, ADA, task, "req-9", { answer: { provided: true } });
    const pending = await ctx.store.taskRequests(ctx.tenant, task.id);
    writeFileSync(release, "");
    await ctx.tasks!.idle();

    // then
    expect([byAdmin.status, (await byAdmin.json()).error]).toEqual([404, "unknown request"]);
    expect([withValue.status, (await withValue.json()).error]).toEqual([400, "a secret is answered only with whether it was provided; its value never reaches the orchestrator's store"]);
    expect(unknown.status).toBe(404);
    expect(pending).toEqual([expect.objectContaining({ status: "pending", answer: null })]);
  });

  it("given a question still pending when the task's agent ends, when it is answered, then it has expired as not resumable and the answer is refused", async () => {
    // given
    const { ctx, task, release } = await running();
    await asked(ctx, task, "question");

    // when
    writeFileSync(release, "");
    await ctx.tasks!.idle();
    const late = await answer(ctx, ADA, task, "req-1", { answer: { answers: { q1: { chosen: [], other: "Use the staging database." } } } });

    // then
    expect(late.status).toBe(409);
    expect(await ctx.store.taskRequests(ctx.tenant, task.id)).toEqual([expect.objectContaining({ status: "expired", responseCapability: "not_resumable" })]);
  });
});
