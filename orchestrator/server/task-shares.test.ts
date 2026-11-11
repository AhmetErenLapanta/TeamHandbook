import type { MiddlewareHandler } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import type { OrchestratorContext } from "./app.js";
import type { OrchestratorEnv, Principal } from "./auth.js";
import { openSqliteStore } from "./store.js";
import { sharesTask } from "./task-shares.js";
import type { TaskRecord } from "./tasks/types.js";

function as(user: Principal): MiddlewareHandler<OrchestratorEnv> {
  return async (c, next) => {
    c.set("user", user);
    await next();
  };
}

// Pat started a Payments task; Lin owns Platform; Max and Vic own nothing, Vic is a viewer.
const PAT: Principal = { id: "usr_pat", name: "Pat", email: "pat@example.invalid", role: "member", ownedTeams: [] };
const LIN: Principal = { id: "usr_lin", name: "Lin", email: "lin@example.invalid", role: "member", ownedTeams: ["Platform"] };
const MAX: Principal = { id: "usr_max", name: "Max", email: "max@example.invalid", role: "member", ownedTeams: [] };
const VIC: Principal = { id: "usr_vic", name: "Vic", email: "vic@example.invalid", role: "viewer", ownedTeams: [] };
const OLU: Principal = { id: "usr_olu", name: "Olu", email: "olu@example.invalid", role: "member", ownedTeams: ["Payments"] };

let ctx: OrchestratorContext;

beforeEach(async () => {
  ctx = { store: openSqliteStore(":memory:"), dataDir: "unused", tenant: "acme" };
  const task: TaskRecord = { tenant: "acme", id: "tsk_a", repoId: "payments-skills", team: "Payments", title: "Retry webhooks", description: "", issueUrl: null, issueKey: null, agent: "fake", status: "needs-review", createdBy: PAT.email, createdAt: new Date().toISOString(), startedAt: null, finishedAt: null, baseSha: null, tests: null, cost: { usd: null, inputTokens: null, outputTokens: null }, requestNumber: null, error: null };
  await ctx.store.createTask(task);
  for (const p of [PAT, LIN, MAX, VIC, OLU]) await ctx.store.insertUser({ tenant: "acme", id: p.id, email: p.email, name: p.name, role: p.role, passwordHash: null, oidcIssuer: null, oidcSubject: null, forgeLogin: null, createdAt: new Date().toISOString() });
  await ctx.store.setOwnedTeams("acme", LIN.id, ["Platform"]);
  await ctx.store.setOwnedTeams("acme", OLU.id, ["Payments"]);
});

const call = (user: Principal, method: string, path: string, body?: unknown) =>
  createApp(ctx, as(user)).request(path, { method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

describe("sharing a task with a teammate", () => {
  it("given Pat's task, when Pat shares it with Max, then Max is listed by name, the log says so, and sharing again or with someone outside the organization is refused", async () => {
    // when
    const shared = await call(PAT, "POST", "/api/tasks/tsk_a/shares", { email: "Max@example.invalid" });
    const listed = await (await call(PAT, "GET", "/api/tasks/tsk_a/shares")).json();
    const again = await call(PAT, "POST", "/api/tasks/tsk_a/shares", { email: MAX.email });
    const outsider = await call(PAT, "POST", "/api/tasks/tsk_a/shares", { email: "eve@elsewhere.invalid" });
    const teamOwner = await call(PAT, "POST", "/api/tasks/tsk_a/shares", { email: OLU.email });
    const events = (await ctx.store.eventPage("acme", {}, null, 20)).events.map((e) => e.kind);

    // then
    expect(shared.status).toBe(201);
    expect(listed.shares).toEqual([expect.objectContaining({ userId: MAX.id, name: "Max", email: MAX.email, sharedBy: PAT.id })]);
    expect([again.status, (await again.json()).code]).toEqual([409, "already-reads"]);
    expect([outsider.status, (await outsider.json()).code]).toEqual([409, "not-a-member"]);
    expect([teamOwner.status, (await teamOwner.json()).code]).toEqual([409, "already-reads"]);
    expect(events).toContain("task.shared");
  });

  it("given a task, when someone who does not read it, a viewer or an API key tries to share it, then none can, and only the sharer, the team's owner or a manager takes a share back", async () => {
    // given
    await call(PAT, "POST", "/api/tasks/tsk_a/shares", { email: MAX.email });

    // when
    const lin = await call(LIN, "POST", "/api/tasks/tsk_a/shares", { email: MAX.email });
    const viewer = await call(VIC, "POST", "/api/tasks/tsk_a/shares", { email: LIN.email });
    const key = await call({ ...PAT, key: { id: "k", owner: { kind: "user", id: PAT.id }, scopes: { repositories: "read", requests: "write", tasks: "write", usage: "none", members: "none", settings: "none", keys: "none" }, expiresAt: null } }, "POST", "/api/tasks/tsk_a/shares", { email: LIN.email });
    const byLin = await call(LIN, "DELETE", `/api/tasks/tsk_a/shares/${MAX.id}`);
    const byOwner = await call(OLU, "DELETE", `/api/tasks/tsk_a/shares/${MAX.id}`);
    const left = await (await call(PAT, "GET", "/api/tasks/tsk_a/shares")).json();

    // then
    expect([lin.status, viewer.status, key.status]).toEqual([404, 404, 403]);
    expect([byLin.status, byOwner.status]).toEqual([404, 204]);
    expect(left.shares).toEqual([]);
  });
});

describe("who passes a task on", () => {
  it("given a task Pat started on Payments and shared with Max, when each person is asked whether they share it, then Pat and Payments' owner do, and Max, a viewer and an API key do not", () => {
    // given
    const task = { team: "Payments", createdBy: PAT.email, sharedWith: [MAX.id] };
    const key = { id: "k", owner: { kind: "user" as const, id: PAT.id }, scopes: { repositories: "read" as const, requests: "write" as const, tasks: "write" as const, usage: "none" as const, members: "none" as const, settings: "none" as const, keys: "none" as const }, expiresAt: null };

    // when
    const answers = [PAT, OLU, MAX, VIC, { ...PAT, key }].map((user) => sharesTask(user, task));

    // then
    expect(answers).toEqual([true, true, false, false, false]);
  });
});
