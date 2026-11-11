import { describe, expect, it } from "vitest";
import { createUser, principalOf, removeUser, setupFirstOwner } from "./accounts.js";
import { createApp } from "./app.js";
import { openSqliteStore } from "./store.js";
import type { Store } from "./store.js";
import { mintTaskToken, TASK_TOKEN_HOURS, TASK_TOKEN_SCOPES, verifyTaskToken } from "./task-tokens.js";
import type { TaskStatus } from "./tasks/types.js";

const TENANT = "acme";
const PASSWORD = "correct horse battery";

async function organization() {
  const store = openSqliteStore(":memory:");
  const owner = await principalOf(store, await setupFirstOwner(store, TENANT, "code", { code: "code", email: "ada@example.invalid", password: PASSWORD }));
  const member = await createUser(store, TENANT, new Set(), { email: "max@example.invalid", role: "member", password: PASSWORD }, owner);
  return { store, owner, member, ctx: { store, tenant: TENANT } };
}

async function task(store: Store, id: string, createdBy: string, status: TaskStatus = "running") {
  const at = new Date().toISOString();
  await store.createTask({ tenant: TENANT, id, repoId: "payments-skills", team: "Payments", title: "t", description: "", issueUrl: null, issueKey: null, agent: "fake", status, createdBy, createdAt: at, startedAt: at, finishedAt: null, baseSha: null, tests: null, cost: { usd: null, inputTokens: null, outputTokens: null }, requestNumber: null, error: null });
}

describe("the credential a task's agent calls the orchestrator with", () => {
  it("given a running task Max started, when its token is checked, then it speaks for Max as he is now, capped at tasks and requests, and the organization keeps only its hash", async () => {
    // given
    const { store, ctx } = await organization();
    await task(store, "tsk_1", "max@example.invalid");

    // when
    const { token } = await mintTaskToken(ctx, { id: "tsk_1" });
    const checked = await verifyTaskToken(ctx, token);

    // then
    expect(token).toMatch(/^th_tt_[A-Za-z0-9_-]{43}$/);
    expect(checked).toMatchObject({ taskId: "tsk_1", user: { email: "max@example.invalid", role: "member", key: { id: "task:tsk_1", scopes: TASK_TOKEN_SCOPES } } });
    const rows = await store.listSettings(TENANT, "task.token.");
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain(token.slice("th_tt_".length));
  });

  it("given tokens, when one is revoked, one is past its time, one's task has finished, one's starter was removed, one is another organization's and one is not a task token, then each speaks for nobody", async () => {
    // given
    const { store, owner, member, ctx } = await organization();
    // Each refusal has a cause of its own: only the last task's starter is the one removed.
    await task(store, "tsk_revoked", "ada@example.invalid");
    await task(store, "tsk_old", "ada@example.invalid");
    await task(store, "tsk_done", "ada@example.invalid", "needs-review");
    await task(store, "tsk_gone", member.id);
    const revoked = await mintTaskToken(ctx, { id: "tsk_revoked" });
    const old = await mintTaskToken(ctx, { id: "tsk_old" }, new Date(Date.now() - (TASK_TOKEN_HOURS + 1) * 3_600_000));
    const done = await mintTaskToken(ctx, { id: "tsk_done" });
    const gone = await mintTaskToken(ctx, { id: "tsk_gone" });

    // when
    await revoked.revoke();
    await removeUser(store, TENANT, member.id, owner);
    const answers = await Promise.all([
      verifyTaskToken(ctx, revoked.token),
      verifyTaskToken(ctx, old.token),
      verifyTaskToken(ctx, done.token),
      verifyTaskToken(ctx, gone.token),
      verifyTaskToken({ store, tenant: "globex" }, done.token),
      verifyTaskToken(ctx, "th_sk_0123456789ab_notatasktoken"),
    ]);

    // then
    expect(answers).toEqual([null, null, null, null, null, null]);
  });

  it("given a task token, when it is sent to a route that takes API keys, then it is no credential there", async () => {
    // given
    const { store, ctx } = await organization();
    await task(store, "tsk_1", "max@example.invalid");
    const { token } = await mintTaskToken(ctx, { id: "tsk_1" });

    // when
    const res = await createApp({ store, dataDir: "unused", tenant: TENANT, allowedHosts: null }).request("/api/repos", { headers: { authorization: `Bearer ${token}` } });

    // then
    expect(res.status).toBe(401);
  });
});
