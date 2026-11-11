import { describe, expect, it } from "vitest";
import { createUser, principalOf, removeUser, setupFirstOwner, startSession, updateUser } from "./accounts.js";
import { createApp } from "./app.js";
import { CSRF_HEADER, sessionCookie } from "./auth.js";
import type { Principal } from "./auth.js";
import { storeKeys } from "./integrations/keys.js";
import { createKey, createServiceAccount, MOST, removeServiceAccount, revokeKey } from "./keys.js";
import { routeNeed } from "./route-scopes.js";
import { MCP_PATH } from "./integrations/orchestrator-mcp.js";
import type { Scopes } from "./keys.js";
import { openSqliteStore } from "./store.js";
import type { Store } from "./store.js";

const TENANT = "acme";
const CODE = "setup-code-for-tests";
const PASSWORD = "correct horse battery";
const TEAMS = new Set(["Payments", "Platform"]);
const NONE: Scopes = { repositories: "none", requests: "none", tasks: "none", usage: "none", members: "none", settings: "none", keys: "none" };

async function organization(): Promise<{ store: Store; owner: Principal; admin: Principal; app: ReturnType<typeof createApp> }> {
  const store = openSqliteStore(":memory:");
  const owner = await principalOf(store, await setupFirstOwner(store, TENANT, CODE, { code: CODE, email: "ada@example.invalid", name: "Ada", password: PASSWORD }));
  const admin = await principalOf(store, await createUser(store, TENANT, TEAMS, { email: "grace@example.invalid", role: "admin", password: PASSWORD }, owner));
  await store.upsertRepo({ tenant: TENANT, id: "payments-skills", team: "Payments", name: "payments-skills", url: "/nowhere/payments-skills.git" });
  return { store, owner, admin, app: createApp({ store, dataDir: "unused", tenant: TENANT, allowedHosts: null }) };
}

const bearer = (secret: string) => ({ authorization: `Bearer ${secret}`, "content-type": "application/json" });

describe("an API key's form and storage", () => {
  it("given a new key, when it is made, then it reads th_sk_, a twelve-digit prefix and a secret, and the store keeps the prefix and a hash but never the secret", async () => {
    // given
    const { store, admin } = await organization();

    // when
    const { key, secret } = await createKey(store, TENANT, admin, { name: "ci", scopes: { repositories: "read" } });

    // then
    expect(secret).toMatch(/^th_sk_[0-9a-f]{12}_[A-Za-z0-9_-]{32}$/);
    expect(key.prefix).toBe(secret.slice(0, 18));
    const stored = await store.listKeys(TENANT, { kind: "user", id: admin.id });
    expect(stored[0]).toMatchObject({ prefix: key.prefix, scopes: { ...NONE, repositories: "read" } });
    expect(JSON.stringify(stored)).not.toContain(secret.slice(19));
  });

  it("given scopes past what a key ever gets, an unknown resource, no access at all or an expiry past a year, when a key is made, then each is refused", async () => {
    // given
    const { store, admin } = await organization();

    // when
    const attempts = await Promise.allSettled([
      createKey(store, TENANT, admin, { name: "x", scopes: { members: "write" } }),
      createKey(store, TENANT, admin, { name: "x", scopes: { billing: "read" } }),
      createKey(store, TENANT, admin, { name: "x", scopes: {} }),
      createKey(store, TENANT, admin, { name: "x", scopes: { usage: "read" }, expiresInDays: 366 }),
    ]);

    // then
    expect(attempts.map((a) => a.status)).toEqual(["rejected", "rejected", "rejected", "rejected"]);
    expect(await store.listKeys(TENANT, { kind: "user", id: admin.id })).toEqual([]);
  });
});

describe("a request made with an API key", () => {
  it("given a key that reads repositories, when it reads them, syncs one, and calls routes no key reaches, then only the read passes and no CSRF token is asked for", async () => {
    // given
    const { store, admin, app } = await organization();
    const { secret } = await createKey(store, TENANT, admin, { name: "ci", scopes: { repositories: "read" } });

    // when
    const read = await app.request("/api/repos", { headers: bearer(secret) });
    const sync = await app.request("/api/repos/payments-skills/sync", { method: "POST", headers: bearer(secret) });
    const closed = await Promise.all(
      [
        ["POST", "/api/users"],
        ["POST", "/api/invites"],
        ["POST", "/api/repos"],
        ["DELETE", "/api/repos/payments-skills"],
        ["PUT", "/api/repos/payments-skills/forge"],
        ["POST", "/api/service-accounts"],
        ["POST", "/api/me/leave"],
      ].map(([method, path]) => app.request(path!, { method, headers: bearer(secret), body: "{}" })),
    );

    // then
    expect(read.status).toBe(200);
    expect(sync.status).toBe(403);
    expect((await sync.json()).error).toBe("this API key has no write access to repositories");
    expect(closed.map((r) => r.status)).toEqual([403, 403, 403, 403, 403, 403, 403]);
    expect(await store.listUsers(TENANT)).toHaveLength(2);
  });

  it("given a key with every scope a key can hold, when it asks to merge a request, then it is refused before anything is read, because merging takes a person", async () => {
    // given
    const { store, owner, app } = await organization();
    const { secret } = await createKey(store, TENANT, owner, { name: "all", scopes: MOST });

    // when
    const merge = await app.request("/api/repos/payments-skills/requests/1/merge", { method: "POST", headers: bearer(secret) });

    // then
    expect(merge.status).toBe(403);
    expect((await merge.json()).error).toMatch(/takes a person signed in to the orchestrator/);
    expect(routeNeed("POST", "/api/repos/:id/requests/:number/merge")).toBe("session");
  });

  it("given a revoked key, an expired one, one from another tenant and a right prefix with a wrong secret, when each calls, then each is turned away as not valid", async () => {
    // given
    const { store, admin, app } = await organization();
    const revoked = await createKey(store, TENANT, admin, { name: "r", scopes: { usage: "read" } });
    await revokeKey(store, TENANT, admin, revoked.key.id);
    const expired = await createKey(store, TENANT, admin, { name: "e", scopes: { usage: "read" }, expiresInDays: 1 }, new Date(Date.now() - 2 * 86_400_000));
    const globexOwner = await principalOf(store, await setupFirstOwner(store, "globex", CODE, { code: CODE, email: "gil@example.invalid", password: PASSWORD }));
    const elsewhere = await createKey(store, "globex", globexOwner, { name: "g", scopes: { usage: "read" } });
    const good = await createKey(store, TENANT, admin, { name: "g", scopes: { usage: "read" } });
    const forged = `${good.secret.slice(0, 19)}${"A".repeat(32)}`;

    // when
    const calls = await Promise.all([revoked.secret, expired.secret, elsewhere.secret, forged].map((s) => app.request("/api/usage", { headers: bearer(s) })));

    // then
    expect(calls.map((r) => r.status)).toEqual([401, 401, 401, 401]);
    expect((await app.request("/api/usage", { headers: bearer(good.secret) })).status).toBe(200);
  });

  it("given an admin's key that syncs repositories, when the admin is made a member, then the same key is refused the sync it was let through before", async () => {
    // given
    const { store, owner, admin, app } = await organization();
    const { secret } = await createKey(store, TENANT, admin, { name: "ci", scopes: { repositories: "write" } });
    const before = await app.request("/api/repos/payments-skills/sync", { method: "POST", headers: bearer(secret) });

    // when
    await updateUser(store, TENANT, TEAMS, admin.id, { role: "member" }, owner);
    const after = await app.request("/api/repos/payments-skills/sync", { method: "POST", headers: bearer(secret) });

    // then
    expect(before.status).not.toBe(403);
    expect(after.status).toBe(403);
  });

  it("given a member's key, when the member is removed, then the key is gone with them", async () => {
    // given
    const { store, owner, admin, app } = await organization();
    const { secret } = await createKey(store, TENANT, admin, { name: "ci", scopes: { usage: "read" } });

    // when
    await removeUser(store, TENANT, admin.id, owner);

    // then
    expect((await app.request("/api/usage", { headers: bearer(secret) })).status).toBe(401);
  });

  it("given a key and another person's session cookie on one request, when it calls, then it acts as the key's owner only", async () => {
    // given
    const { store, owner, admin, app } = await organization();
    const { secret } = await createKey(store, TENANT, admin, { name: "ci", scopes: { usage: "read" } });
    const session = await startSession(store, TENANT, owner.id);

    // when
    const me = await app.request("/api/me", { headers: { ...bearer(secret), cookie: `${sessionCookie(TENANT)}=${session.token}` } });

    // then
    expect((await me.json()).user).toMatchObject({ email: "grace@example.invalid", key: { scopes: { usage: "read" } } });
  });

  it("given a key used twice within a minute, when its record is read, then its last use is written once", async () => {
    // given
    const { store, admin, app } = await organization();
    const { key, secret } = await createKey(store, TENANT, admin, { name: "ci", scopes: { usage: "read" } });

    // when
    await app.request("/api/usage", { headers: bearer(secret) });
    const first = (await store.getKey(TENANT, key.id))!.lastUsedAt;
    await app.request("/api/usage", { headers: bearer(secret) });

    // then
    expect(first).not.toBeNull();
    expect((await store.getKey(TENANT, key.id))!.lastUsedAt).toBe(first);
  });
});

describe("a key minting keys", () => {
  it("given a key that mints keys and reads requests for thirty days, when it mints a narrower key, a wider one, one that outlives it, and one for someone else, then only the narrower one is made", async () => {
    // given
    const { store, owner, admin, app } = await organization();
    const parent = await createKey(store, TENANT, admin, { name: "parent", scopes: { keys: "write", requests: "read" }, expiresInDays: 30 });
    const mint = (body: object) => app.request("/api/keys", { method: "POST", headers: bearer(parent.secret), body: JSON.stringify(body) });

    // when
    const narrower = await mint({ name: "child", scopes: { requests: "read" }, expiresInDays: 7 });
    const wider = await mint({ name: "child", scopes: { requests: "write" }, expiresInDays: 7 });
    const longer = await mint({ name: "child", scopes: { requests: "read" } });
    const sa = await createServiceAccount(store, TENANT, TEAMS, { name: "deploy-bot" }, owner);
    const other = await mint({ name: "child", scopes: { requests: "read" }, expiresInDays: 7, serviceAccountId: sa.id });

    // then
    expect(narrower.status).toBe(200);
    expect([wider.status, longer.status, other.status]).toEqual([403, 403, 403]);
    expect((await store.listKeys(TENANT, { kind: "user", id: admin.id })).map((k) => k.name).sort()).toEqual(["child", "parent"]);
  });

  it("given a key that minted a key that minted another, when the first is revoked, then neither of the keys it minted works any more", async () => {
    // given
    const { store, admin, app } = await organization();
    const parent = await createKey(store, TENANT, admin, { name: "parent", scopes: { keys: "write", usage: "read" } });
    const mint = async (secret: string, name: string) => (await (await app.request("/api/keys", { method: "POST", headers: bearer(secret), body: JSON.stringify({ name, scopes: { keys: "write", usage: "read" } }) })).json()).secret as string;
    const child = await mint(parent.secret, "child");
    const grandchild = await mint(child, "grandchild");

    // when
    await revokeKey(store, TENANT, admin, parent.key.id);

    // then
    const calls = await Promise.all([parent.secret, child, grandchild].map((s) => app.request("/api/usage", { headers: bearer(s) })));
    expect(calls.map((r) => r.status)).toEqual([401, 401, 401]);
  });

  it("given an admin, when they revoke an owner's personal key, then it is refused", async () => {
    // given
    const { store, owner, admin } = await organization();
    const { key } = await createKey(store, TENANT, owner, { name: "mine", scopes: { usage: "read" } });

    // when
    const attempt = revokeKey(store, TENANT, admin, key.id);

    // then
    await expect(attempt).rejects.toMatchObject({ status: 403 });
  });
});

describe("how far a key reaches by its maker's role", () => {
  it("given a member and a viewer, when each mints keys and reads what the key form offers them, then neither gets a scope their role is refused, and a key asked of /api/me offers no more than itself", async () => {
    // given
    const { store, owner, app } = await organization();
    const member = await principalOf(store, await createUser(store, TENANT, TEAMS, { email: "max@example.invalid", role: "member", password: PASSWORD }, owner));
    const viewer = await principalOf(store, await createUser(store, TENANT, new Set(), { email: "vic@example.invalid", role: "viewer", password: PASSWORD }, owner));

    // when
    const attempts = await Promise.allSettled([
      createKey(store, TENANT, member, { name: "x", scopes: { repositories: "write", members: "read", keys: "write" } }),
      createKey(store, TENANT, member, { name: "x", scopes: { settings: "read" } }),
      createKey(store, TENANT, viewer, { name: "x", scopes: { tasks: "read", usage: "read" } }),
      createKey(store, TENANT, viewer, { name: "x", scopes: { keys: "write" } }),
      createKey(store, TENANT, viewer, { name: "x", scopes: { requests: "write" } }),
    ]);
    const ceilingOf = async (headers: Record<string, string>) => (await (await app.request("/api/me", { headers })).json()).user.keyCeiling as Scopes;
    const cookie = async (userId: string) => ({ cookie: `${sessionCookie(TENANT)}=${(await startSession(store, TENANT, userId)).token}` });
    const { secret } = await createKey(store, TENANT, member, { name: "reads", scopes: { tasks: "read", keys: "write" } });

    // then
    expect(attempts.map((a) => a.status)).toEqual(["fulfilled", "rejected", "fulfilled", "rejected", "rejected"]);
    expect(await ceilingOf(await cookie(member.id))).toEqual({ ...MOST, settings: "none" });
    expect(await ceilingOf(await cookie(viewer.id))).toEqual({ repositories: "read", requests: "read", tasks: "read", usage: "read", members: "read", settings: "none", keys: "read" });
    expect(await ceilingOf(bearer(secret))).toEqual({ ...NONE, tasks: "read", keys: "write" });
  });
});

describe("service accounts", () => {
  it("given an admin, when they make a service account owning Payments and give it a key, then the key acts as that account and owns that team", async () => {
    // given
    const { store, admin, app } = await organization();
    const sa = await createServiceAccount(store, TENANT, TEAMS, { name: "deploy-bot", teams: ["Payments"] }, admin);
    const { secret } = await createKey(store, TENANT, admin, { name: "ci", scopes: { tasks: "read" }, serviceAccountId: sa.id });

    // when
    const me = await app.request("/api/me", { headers: bearer(secret) });

    // then
    expect((await me.json()).user).toMatchObject({ id: `service:${sa.id}`, name: "deploy-bot", role: "member", ownedTeams: ["Payments"] });
  });

  it("given a member, and a key with every scope, when each makes a service account, then both are refused", async () => {
    // given
    const { store, owner, app } = await organization();
    const member = await principalOf(store, await createUser(store, TENANT, TEAMS, { email: "max@example.invalid", role: "member" }, owner));
    const { secret } = await createKey(store, TENANT, owner, { name: "all", scopes: MOST });

    // when
    const byMember = createServiceAccount(store, TENANT, TEAMS, { name: "bot" }, member);
    const byKey = await app.request("/api/service-accounts", { method: "POST", headers: bearer(secret), body: JSON.stringify({ name: "bot" }) });

    // then
    await expect(byMember).rejects.toMatchObject({ status: 403 });
    expect(byKey.status).toBe(403);
    expect(await store.listServiceAccounts(TENANT)).toEqual([]);
  });

  it("given a service account with a key and a team, when it is removed, then its key stops and its team ownership is gone", async () => {
    // given
    const { store, admin, app } = await organization();
    const sa = await createServiceAccount(store, TENANT, TEAMS, { name: "deploy-bot", teams: ["Payments"] }, admin);
    const { secret } = await createKey(store, TENANT, admin, { name: "ci", scopes: { tasks: "read" }, serviceAccountId: sa.id });

    // when
    await removeServiceAccount(store, TENANT, sa.id, admin);

    // then
    expect((await app.request("/api/me", { headers: bearer(secret) })).status).toBe(401);
    expect(await store.ownedTeams(TENANT, `service:${sa.id}`)).toEqual([]);
  });
});

describe("the session cookie over https", () => {
  it("given an orchestrator people reach over https, when someone signs in, then the cookie is a __Host- cookie, and the plain name is not read", async () => {
    // given
    const store = openSqliteStore(":memory:");
    await setupFirstOwner(store, TENANT, CODE, { code: CODE, email: "ada@example.invalid", password: PASSWORD });
    const app = createApp({ store, dataDir: "unused", tenant: TENANT, allowedHosts: null, publicUrl: "https://orchestrator.example.invalid" });

    // when
    const login = await app.request("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "ada@example.invalid", password: PASSWORD }) });
    const cookie = login.headers.get("set-cookie")!;
    const token = cookie.split(";")[0]!.split("=")[1]!;

    // then
    expect(cookie).toMatch(new RegExp(`^${sessionCookie(TENANT, true)}=`));
    expect(cookie).toMatch(/__Host-/);
    expect(cookie).toMatch(/Secure/);
    expect(cookie).toMatch(/Path=\//);
    expect((await app.request("/api/me", { headers: { cookie: `${sessionCookie(TENANT, true)}=${token}` } })).status).toBe(200);
    expect((await app.request("/api/me", { headers: { cookie: `${sessionCookie(TENANT)}=${token}` } })).status).toBe(401);
  });

  it("given an orchestrator over https, when a change carries a session but no CSRF token, then it is still refused, so the bearer path is the only one without one", async () => {
    // given
    const store = openSqliteStore(":memory:");
    const owner = await setupFirstOwner(store, TENANT, CODE, { code: CODE, email: "ada@example.invalid", password: PASSWORD });
    const app = createApp({ store, dataDir: "unused", tenant: TENANT, allowedHosts: null, publicUrl: "https://orchestrator.example.invalid" });
    const session = await startSession(store, TENANT, owner.id);

    // when
    const res = await app.request("/api/keys", { method: "POST", headers: { cookie: `${sessionCookie(TENANT, true)}=${session.token}`, "content-type": "application/json" }, body: JSON.stringify({ name: "k", scopes: { usage: "read" } }) });
    const withToken = await app.request("/api/keys", { method: "POST", headers: { cookie: `${sessionCookie(TENANT, true)}=${session.token}`, [CSRF_HEADER]: session.csrf, "content-type": "application/json" }, body: JSON.stringify({ name: "k", scopes: { usage: "read" } }) });

    // then
    expect(res.status).toBe(403);
    expect(withToken.status).toBe(200);
  });
});

describe("what the event log says about keys and members", () => {
  it("given an admin who makes a key, revokes it and invites someone over the API, when the log is read, then each is there by prefix and address, and neither the key's secret nor the link is", async () => {
    // given
    const { store, admin, app } = await organization();
    const session = await startSession(store, TENANT, admin.id);
    const headers = { cookie: `${sessionCookie(TENANT)}=${session.token}`, [CSRF_HEADER]: session.csrf, "content-type": "application/json" };

    // when
    const made = await (await app.request("/api/keys", { method: "POST", headers, body: JSON.stringify({ name: "ci", scopes: { usage: "read" } }) })).json();
    await app.request(`/api/keys/${made.key.id}`, { method: "DELETE", headers });
    const invited = await (await app.request("/api/invites", { method: "POST", headers, body: JSON.stringify({ emails: "kim@example.invalid", role: "member" }) })).json();
    const { events } = await store.eventPage(TENANT, {}, null, 50);

    // then
    // Three calls can land in one millisecond, and the log orders those by a random suffix.
    expect(events.map((e) => e.kind).sort()).toEqual(["invite.sent", "key.created", "key.revoked"]);
    expect(events.find((e) => e.kind === "key.created")!.detail).toContain(made.key.prefix);
    expect(events.find((e) => e.kind === "invite.sent")!.detail).toContain("kim@example.invalid");
    const text = JSON.stringify(events);
    expect(text).not.toContain(made.secret.slice(19));
    expect(text).not.toContain(invited.invited[0].link.split("/join/")[1]);
  });
});

describe("a key on the orchestrator's MCP server", () => {
  it("given a key that only reads repositories, when the MCP server lists and calls tools with it, then it offers the reading tools only and refuses a tool that opens a request", async () => {
    // given
    const { store, owner } = await organization();
    const { secret } = await createKey(store, TENANT, owner, { name: "agent", scopes: { repositories: "read" } });
    const app = createApp({ store, dataDir: "unused", tenant: TENANT, allowedHosts: null, apiKeys: storeKeys(store, TENANT), audit: async () => undefined });
    const rpc = async (method: string, params: object = {}) =>
      (await app.request(MCP_PATH, { method: "POST", headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })).json();

    // when
    const listed = await rpc("tools/list");
    const called = await rpc("tools/call", { name: "propose_change", arguments: { repo: "payments-skills" } });

    // then
    expect(listed.result.tools.map((t: { name: string }) => t.name).sort()).toEqual(["get_repository", "list_policies", "list_repositories"]);
    expect(JSON.stringify(called)).toMatch(/error|isError/);
    expect(JSON.stringify(called)).not.toMatch(/"request"/);
  });
});
