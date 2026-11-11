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
import { deleteTaskSecret, listTaskSecrets, secretKey, secretsForTask, setTaskSecret, UnreadTaskSecret } from "./task-secrets.js";
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
