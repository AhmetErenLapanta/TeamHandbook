import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createUser, principalOf, setupFirstOwner, startSession } from "./accounts.js";
import { createApp } from "./app.js";
import type { OrchestratorContext } from "./app.js";
import { CSRF_HEADER, sessionCookie } from "./auth.js";
import type { Principal } from "./auth.js";
import { deleteTaskSecret, dropTaskSecrets, giveTaskSecret, listTaskSecrets, secretKey, secretsForTask, setTaskSecret, sweepTaskSecrets, UnreadTaskSecret } from "./task-secrets.js";
import { newId } from "./ids.js";
import type { TaskRunner } from "./tasks/runner.js";
import type { TaskRecord, TaskStatus } from "./tasks/types.js";
import { openSqliteStore } from "./store.js";
import { fakeOpCli } from "./test-fixtures.js";
import { createVault } from "./vault.js";

const TENANT = "acme";
const CODE = "setup-code-for-tests";
const PASSWORD = "correct horse battery";
const VALUE = "stand-in-secret-value-0001";
const ITEM = "op://Payments/npm/credential";
const ITEM_VALUE = "stand-in-op-value-0002";

const dirs: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** The orchestrator's op stand-in, holding `items`, in a folder of its own. */
function opHolding(items: Record<string, string>): void {
  const dir = mkdtempSync(join(tmpdir(), "th-task-secrets-op-"));
  dirs.push(dir);
  fakeOpCli(dir, items);
}

async function organization(withVault = true): Promise<{ ctx: OrchestratorContext; owner: Principal; admin: Principal; member: Principal }> {
  const store = openSqliteStore(":memory:");
  const ctx: OrchestratorContext = { store, dataDir: "unused", tenant: TENANT, allowedHosts: null, vault: withVault ? createVault(randomBytes(32)) : null };
  for (const [id, team] of [["payments-skills", "Payments"], ["payments-api", "Payments"], ["platform-skills", "Platform"]] as const) {
    await store.upsertRepo({ tenant: TENANT, id, team, name: id, url: `/nowhere/${id}.git` });
  }
  const owner = await principalOf(store, await setupFirstOwner(store, TENANT, CODE, { code: CODE, email: "ada@example.invalid", password: PASSWORD }));
  const admin = await principalOf(store, await createUser(store, TENANT, new Set(["Payments"]), { email: "grace@example.invalid", role: "admin" }, owner));
  const member = await principalOf(store, await createUser(store, TENANT, new Set(["Payments"]), { email: "max@example.invalid", role: "member", teams: ["Payments"] }, owner));
  return { ctx, owner, admin, member };
}

describe("writing task secrets", () => {
  it("given an admin, when they set a team secret, then the list names it with who and when, and the store holds it sealed, never as written", async () => {
    // given
    const { ctx, admin } = await organization();

    // when
    await setTaskSecret(ctx, admin, { scope: "team", target: "Payments", name: "NPM_TOKEN", value: VALUE });

    // then
    expect(await listTaskSecrets(ctx)).toEqual([{ scope: "team", target: "Payments", name: "NPM_TOKEN", updatedAt: expect.any(String), updatedBy: "grace@example.invalid" }]);
    const sealed = await ctx.store.getSecret(TENANT, secretKey("team", "Payments", "NPM_TOKEN"));
    expect(sealed).not.toBeNull();
    expect(sealed).not.toContain(VALUE);
    expect(JSON.stringify(await listTaskSecrets(ctx))).not.toContain(VALUE);
  });

  it("given a member who owns the team, a key, an orchestrator without a vault, a reserved name and a team no repository belongs to, when each sets a secret, then each is refused and nothing is kept", async () => {
    // given
    const { ctx, owner, member } = await organization();
    const bare = await organization(false);

    // when
    const attempts = await Promise.allSettled([
      setTaskSecret(ctx, member, { scope: "team", target: "Payments", name: "NPM_TOKEN", value: VALUE }),
      setTaskSecret(ctx, { ...owner, key: { id: "k", owner: { kind: "user", id: owner.id }, scopes: {} as never, expiresAt: null } }, { scope: "team", target: "Payments", name: "NPM_TOKEN", value: VALUE }),
      setTaskSecret(bare.ctx, bare.owner, { scope: "team", target: "Payments", name: "NPM_TOKEN", value: VALUE }),
      setTaskSecret(ctx, owner, { scope: "repo", target: "payments-skills", name: "PATH", value: "/tmp" }),
      setTaskSecret(ctx, owner, { scope: "repo", target: "payments-skills", name: "LD_PRELOAD", value: "x" }),
      setTaskSecret(ctx, owner, { scope: "team", target: "Ghosts", name: "NPM_TOKEN", value: VALUE }),
      setTaskSecret(ctx, owner, { scope: "repo", target: "payments-skills", name: "npm token", value: VALUE }),
    ]);

    // then
    expect(attempts.map((a) => (a.status === "rejected" ? (a.reason as { status: number }).status : 200))).toEqual([403, 403, 409, 400, 400, 404, 400]);
    expect(await listTaskSecrets(ctx)).toEqual([]);
  });
});

describe("the secrets a task runs with", () => {
  it("given a team secret, a repository secret of the same name and secrets of another team and repository, when a task on payments-skills asks, then it gets the team's and its repository's, the repository's winning", async () => {
    // given
    const { ctx, owner } = await organization();
    await setTaskSecret(ctx, owner, { scope: "team", target: "Payments", name: "NPM_TOKEN", value: "team-value" });
    await setTaskSecret(ctx, owner, { scope: "team", target: "Payments", name: "SENTRY_DSN", value: "team-dsn" });
    await setTaskSecret(ctx, owner, { scope: "repo", target: "payments-skills", name: "NPM_TOKEN", value: "repo-value" });
    await setTaskSecret(ctx, owner, { scope: "repo", target: "payments-api", name: "API_ONLY", value: "other-repo" });
    await setTaskSecret(ctx, owner, { scope: "team", target: "Platform", name: "PLATFORM_ONLY", value: "other-team" });

    // when
    const secrets = await secretsForTask(ctx, "payments-skills", "Payments");

    // then
    expect(secrets).toEqual([
      { name: "NPM_TOKEN", value: "repo-value" },
      { name: "SENTRY_DSN", value: "team-dsn" },
    ]);
  });

  it("given a sealed value copied under another secret's name, and an orchestrator restarted without its key, when a task asks, then neither opens and the task is not given a value", async () => {
    // given
    const { ctx, owner } = await organization();
    await setTaskSecret(ctx, owner, { scope: "team", target: "Payments", name: "NPM_TOKEN", value: VALUE });
    const sealed = (await ctx.store.getSecret(TENANT, secretKey("team", "Payments", "NPM_TOKEN")))!;
    await ctx.store.putSecret(TENANT, secretKey("team", "Payments", "COPIED"), sealed, "someone");

    // when
    const copied = secretsForTask(ctx, "payments-skills", "Payments");
    const keyless = secretsForTask({ ...ctx, vault: null }, "payments-skills", "Payments");

    // then
    await expect(copied).rejects.toThrow();
    await expect(keyless).rejects.toThrow(/ORCHESTRATOR_SECRET_KEY/);
  });

  it("given a secret, when an admin deletes it, then the next task does not get it", async () => {
    // given
    const { ctx, admin } = await organization();
    await setTaskSecret(ctx, admin, { scope: "repo", target: "payments-skills", name: "NPM_TOKEN", value: VALUE });

    // when
    await deleteTaskSecret(ctx, admin, { scope: "repo", target: "payments-skills", name: "NPM_TOKEN" });

    // then
    expect(await secretsForTask(ctx, "payments-skills", "Payments")).toEqual([]);
    await expect(deleteTaskSecret(ctx, admin, { scope: "repo", target: "payments-skills", name: "NPM_TOKEN" })).rejects.toMatchObject({ status: 404 });
  });
});

describe("the task secret routes", () => {
  it("given an owner's session, when a secret is set, listed and deleted over the API, then no answer and no event carries the value, and a member is refused the list", async () => {
    // given
    const { ctx, owner, member } = await organization();
    const app = createApp(ctx);
    const as = async (id: string) => {
      const s = await startSession(ctx.store, TENANT, id);
      return { cookie: `${sessionCookie(TENANT)}=${s.token}`, [CSRF_HEADER]: s.csrf, "content-type": "application/json" };
    };
    const headers = await as(owner.id);

    // when
    const set = await app.request("/api/task-secrets", { method: "PUT", headers, body: JSON.stringify({ scope: "team", target: "Payments", name: "NPM_TOKEN", value: VALUE }) });
    const listed = await app.request("/api/task-secrets", { headers });
    const removed = await app.request("/api/task-secrets", { method: "DELETE", headers, body: JSON.stringify({ scope: "team", target: "Payments", name: "NPM_TOKEN" }) });
    const byMember = await app.request("/api/task-secrets", { headers: await as(member.id) });
    const { events } = await ctx.store.eventPage(TENANT, {}, null, 10);

    // then
    const answers = [await set.text(), await listed.text(), await removed.text()];
    expect([set.status, listed.status, removed.status, byMember.status]).toEqual([200, 200, 200, 403]);
    expect(JSON.parse(answers[1]!).secrets).toEqual([expect.objectContaining({ name: "NPM_TOKEN", scope: "team", target: "Payments" })]);
    for (const text of answers) expect(text).not.toContain(VALUE);
    expect(events.map((e) => e.kind).sort()).toEqual(["task-secret.deleted", "task-secret.set"]);
    expect(JSON.stringify(events)).not.toContain(VALUE);
  });
});

describe("audit wave 5: values too short to mask and team names with dots", () => {
  it("given a value of seven characters and one of eight, when each is saved, then the first is refused because the log could not mask it and the second is kept", async () => {
    // given
    const { ctx, owner } = await organization();

    // when
    const short = setTaskSecret(ctx, owner, { scope: "team", target: "Payments", name: "SHORT", value: "1234567" });
    const enough = await setTaskSecret(ctx, owner, { scope: "team", target: "Payments", name: "ENOUGH", value: "12345678" });

    // then
    await expect(short).rejects.toThrow(/at least 8 characters/);
    expect(enough.name).toBe("ENOUGH");
    expect((await listTaskSecrets(ctx)).map((s) => s.name)).toEqual(["ENOUGH"]);
  });

  it("given a team whose name has dots, when a secret is saved for it, then it is listed under that team and a task on its repository gets it", async () => {
    // given
    const { ctx, owner } = await organization();
    await ctx.store.upsertRepo({ tenant: TENANT, id: "web-skills", team: "eng.web.v2", name: "web-skills", url: "/nowhere/web-skills.git" });

    // when
    await setTaskSecret(ctx, owner, { scope: "team", target: "eng.web.v2", name: "NPM_TOKEN", value: VALUE });

    // then
    expect(await listTaskSecrets(ctx)).toEqual([expect.objectContaining({ scope: "team", target: "eng.web.v2", name: "NPM_TOKEN" })]);
    expect(await secretsForTask(ctx, "web-skills", "eng.web.v2")).toEqual([{ name: "NPM_TOKEN", value: VALUE }]);
  });
});

describe("a task secret read from 1Password", () => {
  it("given an orchestrator that reads the Payments vault, when an admin names an item there, one in another vault, and both a value and an item at once, then the first is kept and listed as its reference and the other two are refused", async () => {
    // given
    opHolding({ [ITEM]: ITEM_VALUE });
    const { ctx, admin } = await organization();

    // when
    const kept = await setTaskSecret(ctx, admin, { scope: "team", target: "Payments", name: "NPM_TOKEN", secret: { provider: "op", reference: ITEM } });
    const attempts = await Promise.allSettled([
      setTaskSecret(ctx, admin, { scope: "team", target: "Payments", name: "OTHER", secret: { provider: "op", reference: "op://Platform/npm/credential" } }),
      setTaskSecret(ctx, admin, { scope: "team", target: "Payments", name: "BOTH", value: VALUE, secret: { provider: "op", reference: ITEM } }),
      setTaskSecret(ctx, admin, { scope: "team", target: "Payments", name: "ALIAS", secret: { provider: "vault", reference: secretKey("team", "Payments", "NPM_TOKEN") } }),
    ]);

    // then
    expect(kept.reference).toEqual({ provider: "op", reference: ITEM });
    expect(await listTaskSecrets(ctx)).toEqual([{ scope: "team", target: "Payments", name: "NPM_TOKEN", updatedAt: expect.any(String), updatedBy: "grace@example.invalid", reference: { provider: "op", reference: ITEM } }]);
    expect(await ctx.store.getSecret(TENANT, secretKey("team", "Payments", "NPM_TOKEN"))).not.toContain(ITEM);
    expect(attempts.map((a) => (a.status === "rejected" ? (a.reason as Error).message : "kept"))).toEqual([
      "that vault is not one this orchestrator reads",
      "a secret is either a value or a secret naming where it is read, not both",
      "this orchestrator reads secrets through op, not vault",
    ]);
  });

  it("given a team secret named by a 1Password item, when a task asks, then the orchestrator's op reads it and the task gets its value", async () => {
    // given
    opHolding({ [ITEM]: ITEM_VALUE });
    const { ctx, owner } = await organization();
    await setTaskSecret(ctx, owner, { scope: "team", target: "Payments", name: "NPM_TOKEN", secret: { provider: "op", reference: ITEM } });
    await setTaskSecret(ctx, owner, { scope: "team", target: "Payments", name: "SENTRY_DSN", value: VALUE });

    // when
    const secrets = await secretsForTask(ctx, "payments-skills", "Payments");

    // then
    expect(secrets).toEqual([
      { name: "NPM_TOKEN", value: ITEM_VALUE },
      { name: "SENTRY_DSN", value: VALUE },
    ]);
  });

  it("given a team secret named by an item op does not hold, and one repository's own value of that name, when each repository's task asks, then the one with its own value gets it unread and the other throws naming the secret and the item", async () => {
    // given
    opHolding({});
    const { ctx, owner } = await organization();
    await setTaskSecret(ctx, owner, { scope: "team", target: "Payments", name: "NPM_TOKEN", secret: { provider: "op", reference: ITEM } });
    await setTaskSecret(ctx, owner, { scope: "repo", target: "payments-skills", name: "NPM_TOKEN", value: VALUE });

    // when
    const own = await secretsForTask(ctx, "payments-skills", "Payments");
    const unread = secretsForTask(ctx, "payments-api", "Payments");

    // then
    expect(own).toEqual([{ name: "NPM_TOKEN", value: VALUE }]);
    await expect(unread).rejects.toBeInstanceOf(UnreadTaskSecret);
    await expect(unread).rejects.toThrow(`the task secret NPM_TOKEN is read from ${ITEM}, and that read returned no value a task secret can be`);
  });

  it("given an owner's session, when a secret is named by an item over the API, then the list carries its reference and the vaults this orchestrator reads, and the event names the item", async () => {
    // given
    opHolding({ [ITEM]: ITEM_VALUE });
    const { ctx, owner } = await organization();
    const app = createApp(ctx);
    const s = await startSession(ctx.store, TENANT, owner.id);
    const headers = { cookie: `${sessionCookie(TENANT)}=${s.token}`, [CSRF_HEADER]: s.csrf, "content-type": "application/json" };

    // when
    const set = await app.request("/api/task-secrets", { method: "PUT", headers, body: JSON.stringify({ scope: "repo", target: "payments-skills", name: "NPM_TOKEN", secret: { provider: "op", reference: ITEM } }) });
    const listed = await (await app.request("/api/task-secrets", { headers })).json();
    const { events } = await ctx.store.eventPage(TENANT, {}, null, 10);

    // then
    expect(set.status).toBe(200);
    expect(listed).toMatchObject({ vault: true, op: ["Payments"], secrets: [{ name: "NPM_TOKEN", reference: { provider: "op", reference: ITEM } }] });
    expect(events.find((e) => e.kind === "task-secret.set")?.detail).toBe(`NPM_TOKEN for repository payments-skills; read from ${ITEM}`);
    expect(JSON.stringify([listed, events])).not.toContain(ITEM_VALUE);
  });
});

/** A task on payments-skills started by `by`, in `status`. */
async function taskOf(ctx: OrchestratorContext, by: Principal, status: TaskStatus = "running"): Promise<TaskRecord> {
  const at = new Date().toISOString();
  const task: TaskRecord = { tenant: TENANT, id: newId("tsk"), repoId: "payments-skills", team: "Payments", title: "Charge in test mode", description: "", issueUrl: null, issueKey: null, agent: "fake", status, createdBy: by.email, createdAt: at, startedAt: at, finishedAt: null, baseSha: null, tests: null, cost: { usd: null, inputTokens: null, outputTokens: null }, requestNumber: null, error: null };
  await ctx.store.createTask(task);
  return task;
}

/** The agent of `task` asking for a secret by `name`. */
async function asks(ctx: OrchestratorContext, task: TaskRecord, name: string): Promise<string> {
  const id = newId("req");
  await ctx.store.recordTaskRequest({ tenant: TENANT, id, taskId: task.id, targetPosition: null, sourceKey: id, kind: "secret", payload: { name, why: "to run the payment tests" }, createdAt: new Date().toISOString(), expiresAt: null });
  return id;
}

const given = (ctx: OrchestratorContext) => ctx.store.listSecrets(TENANT, "task.secret.task.");

describe("a secret the agent asks for", () => {
  it("given a task whose agent asked for a secret, when its starter gives the value, then it is sealed for that task alone, the request reads as given, and no answer, event or list holds the value", async () => {
    // given
    const { ctx, owner } = await organization();
    const task = await taskOf(ctx, owner);
    const other = await taskOf(ctx, owner);
    const request = await asks(ctx, task, "STRIPE_TEST_KEY");

    // when
    const answer = await giveTaskSecret(ctx, owner, task.id, request, VALUE);
    const events = JSON.stringify((await ctx.store.eventPage(TENANT, {}, null, 50)).events);

    // then
    expect([answer.name, answer.request.status, answer.request.answer]).toEqual(["STRIPE_TEST_KEY", "answered", { provided: true }]);
    expect(await secretsForTask(ctx, "payments-skills", "Payments", {}, task.id)).toEqual([{ name: "STRIPE_TEST_KEY", value: VALUE }]);
    expect(await secretsForTask(ctx, "payments-skills", "Payments", {}, other.id)).toEqual([]);
    expect(await secretsForTask(ctx, "payments-skills", "Payments", {})).toEqual([]);
    expect(await listTaskSecrets(ctx)).toEqual([]);
    expect(JSON.stringify(await ctx.store.taskRequests(TENANT, task.id))).not.toContain(VALUE);
    expect(events).not.toContain(VALUE);
    expect((await given(ctx))[0]!.name).not.toContain(VALUE);
  });

  it("given a secret request, when a teammate, an API key, a short value, a reserved name or a name the team already sets answers it, then each is refused and nothing is sealed", async () => {
    // given
    const { ctx, owner, admin, member } = await organization();
    const task = await taskOf(ctx, owner);
    await setTaskSecret(ctx, admin, { scope: "team", target: "Payments", name: "NPM_TOKEN", value: VALUE });
    const plain = await asks(ctx, task, "STRIPE_TEST_KEY");
    const reserved = await asks(ctx, task, "PATH");
    const shadowing = await asks(ctx, task, "NPM_TOKEN");
    const refusal = (run: Promise<unknown>) => run.then(() => null, (err: { status?: number; message: string }) => [err.status, err.message]);

    // when
    const byTeammate = await refusal(giveTaskSecret(ctx, member, task.id, plain, VALUE));
    const byKey = await refusal(giveTaskSecret(ctx, { ...owner, key: { id: "k", owner: { kind: "user", id: owner.id }, scopes: { repositories: "read", requests: "write", tasks: "write", usage: "none", members: "none", settings: "none", keys: "none" }, expiresAt: null } }, task.id, plain, VALUE));
    const short = await refusal(giveTaskSecret(ctx, owner, task.id, plain, "short"));
    const system = await refusal(giveTaskSecret(ctx, owner, task.id, reserved, VALUE));
    const shadowed = await refusal(giveTaskSecret(ctx, owner, task.id, shadowing, VALUE));

    // then
    expect(byTeammate).toEqual([404, "unknown task"]);
    expect(byKey![0]).toBe(403);
    expect(short).toEqual([400, expect.stringContaining("at least 8 characters")]);
    expect(system).toEqual([400, expect.stringContaining("set by the orchestrator or the system")]);
    expect(shadowed).toEqual([409, expect.stringContaining("already has NPM_TOKEN")]);
    expect(await given(ctx)).toEqual([]);
    expect((await ctx.store.taskRequests(TENANT, task.id)).every((r) => r.status === "pending")).toBe(true);
  });

  it("given values given to tasks, when one task ends, the start-up sweep runs and a starter's account is deleted, then each value goes and a running task's stays", async () => {
    // given
    const { ctx, owner, member } = await organization();
    const ended = await taskOf(ctx, owner);
    const stopped = await taskOf(ctx, owner);
    const running = await taskOf(ctx, owner);
    const theirs = await taskOf(ctx, member);
    for (const task of [ended, stopped, running]) await giveTaskSecret(ctx, owner, task.id, await asks(ctx, task, "STRIPE_TEST_KEY"), VALUE);
    await giveTaskSecret(ctx, member, theirs.id, await asks(ctx, theirs, "STRIPE_TEST_KEY"), VALUE);
    await ctx.store.updateTask(TENANT, stopped.id, { status: "interrupted" });

    // when
    await dropTaskSecrets(ctx, ended.id);
    await sweepTaskSecrets(ctx);
    const beforeDeletion = (await given(ctx)).map((s) => s.name);
    await ctx.store.deleteUser(TENANT, member.id);

    // then
    expect(beforeDeletion.sort()).toEqual([`task.secret.task.${running.id}.STRIPE_TEST_KEY`, `task.secret.task.${theirs.id}.STRIPE_TEST_KEY`].sort());
    expect((await given(ctx)).map((s) => s.name)).toEqual([`task.secret.task.${running.id}.STRIPE_TEST_KEY`]);
  });

  it("given a secret request, when its starter answers it on the request's own route, then a decline is taken and a 'given' without a value is sent to the card", async () => {
    // given
    const { ctx, owner } = await organization();
    ctx.tasks = { followUp: () => null, queued: () => [] } as unknown as TaskRunner;
    const task = await taskOf(ctx, owner);
    const declined = await asks(ctx, task, "STRIPE_TEST_KEY");
    const claimed = await asks(ctx, task, "OTHER_KEY");
    const s = await startSession(ctx.store, TENANT, owner.id);
    const headers = { cookie: `${sessionCookie(TENANT)}=${s.token}`, [CSRF_HEADER]: s.csrf, "content-type": "application/json" };
    const app = createApp(ctx);

    // when
    const decline = await app.request(`/api/tasks/${task.id}/requests/${declined}`, { method: "POST", headers, body: JSON.stringify({ answer: { provided: false } }) });
    const claim = await app.request(`/api/tasks/${task.id}/requests/${claimed}`, { method: "POST", headers, body: JSON.stringify({ answer: { provided: true } }) });
    const onCard = await app.request(`/api/tasks/${task.id}/secrets/${claimed}`, { method: "POST", headers, body: JSON.stringify({ value: VALUE }) });

    // then
    expect(decline.status).toBe(200);
    expect([claim.status, (await claim.json()).code]).toEqual([400, "secret-on-card"]);
    expect([onCard.status, await onCard.json()]).toEqual([200, { request: { id: claimed, status: "answered" } }]);
    expect((await given(ctx)).map((x) => x.name)).toEqual([`task.secret.task.${task.id}.OTHER_KEY`]);
  });
});
