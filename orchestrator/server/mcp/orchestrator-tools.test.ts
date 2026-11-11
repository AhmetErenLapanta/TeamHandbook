import { describe, expect, it } from "vitest";
import type { OrchestratorContext } from "../app.js";
import type { Principal } from "../auth.js";
import { openSqliteStore } from "../store.js";
import type { TaskRecord } from "../tasks/types.js";
import { UNKNOWN_COST } from "../tasks/types.js";
import { ORCHESTRATOR_TOOLS } from "./orchestrator-tools.js";
import type { AgentSession, Orchestrator } from "./orchestrator-tools.js";

const PAT: Principal = { id: "u-pat", name: "Pat Owner", email: "pat@example.invalid", role: "member", ownedTeams: ["Payments"] };

function task(id: string, over: Partial<TaskRecord> = {}): TaskRecord {
  return {
    tenant: "acme", id, repoId: "payments-api", team: "Payments", title: id, description: "", issueUrl: null, issueKey: null, agent: "claude", status: "running",
    createdBy: PAT.email, createdAt: "2026-11-02T10:00:00.000Z", startedAt: null, finishedAt: null, baseSha: null, tests: null, cost: UNKNOWN_COST, requestNumber: null, error: null, ...over,
  };
}

/** An orchestrator with the parent task, the child it delegated, a task of someone else's, and an orchestrator that records what it is asked. */
async function orchestrator_() {
  const ctx: OrchestratorContext = { store: openSqliteStore(":memory:"), dataDir: "unused", tenant: "acme" };
  for (const repo of [{ id: "payments-api", team: "Payments" }, { id: "payments-web", team: "Payments" }, { id: "lending-api", team: "Lending" }]) {
    await ctx.store.upsertRepo({ tenant: "acme", id: repo.id, team: repo.team, name: repo.id, url: `https://gitlab.example/acme/${repo.id}.git` });
  }
  await ctx.store.createTask(task("tsk_parent000001"));
  await ctx.store.createTask(task("tsk_child0000001", { repoId: "payments-web", status: "needs-review", requestNumber: 4 }));
  await ctx.store.createTask(task("tsk_other0000001", { repoId: "lending-api", team: "Lending", requestNumber: 9 }));
  for (const [repoId, number] of [["payments-web", 4], ["lending-api", 9]] as const) {
    await ctx.store.saveRequest({ tenant: "acme", repoId, number, provider: "gitlab", url: `https://gitlab.example/acme/${repoId}/-/merge_requests/${number}`, branch: "b", headSha: "a".repeat(40), title: "t", status: "open", createdAt: "2026-11-02T10:30:00.000Z", createdBy: "x" });
  }
  const asked: string[] = [];
  const orchestrator: Orchestrator = {
    delegate: async (_s, input) => (asked.push(`delegate ${input.repoId} wait=${input.wait} ${input.timeoutSeconds}${input.mode ? ` mode=${input.mode}` : ""}`), { taskId: "tsk_new00000001", status: "queued" }),
    cancel: async (_s, id) => void asked.push(`cancel ${id}`),
    family: async () => ["tsk_child0000001"],
  };
  const session: AgentSession = { task: (await ctx.store.getTask("acme", "tsk_parent000001"))!, user: PAT };
  const tool = (name: string) => ORCHESTRATOR_TOOLS.find((t) => t.name === name)!;
  const call = (name: string, args: Record<string, unknown>) => tool(name).run(args, ctx, session, orchestrator);
  return { call, asked };
}

describe("the orchestrator's tools in a task's agent session", () => {
  it("given a parent and the child it delegated, when the agent asks for their status and another task's, then it reads its family alone", async () => {
    // given
    const { call } = await orchestrator_();

    // when
    const own = await call("task_status", {});
    const child = await call("task_status", { task: "tsk_child0000001" });
    const other = call("task_status", { task: "tsk_other0000001" });

    // then
    expect(own).toMatchObject({ task: "tsk_parent000001", status: "running", phase: "working" });
    expect(child).toMatchObject({ task: "tsk_child0000001", phase: "review", requests: [{ repo: "payments-web", number: 4, status: "open", url: "https://gitlab.example/acme/payments-web/-/merge_requests/4" }] });
    await expect(other).rejects.toThrow("no such task among this task and the ones it delegated");
  });

  it("given the agent delegating, when it asks for a repository of its team and one of another team's, then only the first reaches the runner", async () => {
    // given
    const { call, asked } = await orchestrator_();

    // when
    const started = await call("delegate_task", { repo: "payments-web", prompt: "Add the refund column", wait: true, timeout_seconds: 99_999, mode: "auto-accept-edits" });
    const refused = call("delegate_task", { repo: "lending-api", prompt: "Change lending" });

    // then
    expect(started).toEqual({ task: "tsk_new00000001", status: "queued" });
    await expect(refused).rejects.toThrow("no repository by that id that this task's person may start a task on");
    expect(asked).toEqual(["delegate payments-web wait=true 1800 mode=auto-accept-edits"]);
  });

  it("given the agent cancelling, when it names its child and then itself, then the child is cancelled and itself is not", async () => {
    // given
    const { call, asked } = await orchestrator_();

    // when
    await call("task_cancel", { task: "tsk_child0000001" });
    const self = call("task_cancel", { task: "tsk_parent000001" });

    // then
    await expect(self).rejects.toThrow("a task does not cancel itself");
    expect(asked).toEqual(["cancel tsk_child0000001"]);
  });

  it("given requests of its family and of another task, when the agent asks for them, then it reads only its family's", async () => {
    // given
    const { call } = await orchestrator_();

    // when
    const own = await call("request_status", { repo: "payments-web", number: 4 });
    const other = call("request_status", { repo: "lending-api", number: 9 });

    // then
    expect(own).toMatchObject({ repo: "payments-web", number: 4, status: "open" });
    await expect(other).rejects.toThrow("no such request");
  });

  it("given the tools' descriptions, when they are measured, then what the model reads of them stays within its budget", () => {
    // given
    const described = JSON.stringify(ORCHESTRATOR_TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })));

    // when
    const bytes = Buffer.byteLength(described);

    // then
    expect(ORCHESTRATOR_TOOLS.map((t) => t.name)).toEqual(["delegate_task", "task_status", "task_cancel", "request_status", "suggest_skill"]);
    expect(bytes).toBeLessThan(2_500);
  });
});
