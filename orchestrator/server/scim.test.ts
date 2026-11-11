import { describe, expect, it } from "vitest";
import { createUser, principalOf, setupFirstOwner, signInWithOidc, signInWithPassword, startSession } from "./accounts.js";
import { createApp } from "./app.js";
import type { OrchestratorContext } from "./app.js";
import { CSRF_HEADER, hashToken, sessionCookie } from "./auth.js";
import type { Principal } from "./auth.js";
import { applyMapping, memberTags, previewMapping } from "./directory.js";
import { createKey } from "./keys.js";
import { createScimToken, USERS } from "./scim.js";
import { openSqliteStore } from "./store.js";
import type { Store } from "./store.js";

const TENANT = "acme";
const CODE = "setup-code-for-tests";
const PASSWORD = "correct horse battery";
const IDP = "https://idp.example.invalid";

async function organization() {
  const store = openSqliteStore(":memory:");
  const owner = await principalOf(store, await setupFirstOwner(store, TENANT, CODE, { code: CODE, email: "ada@example.invalid", name: "Ada", password: PASSWORD }));
  const ctx: OrchestratorContext = { store, dataDir: "unused", tenant: TENANT, allowedHosts: null, publicUrl: "https://orchestrator.example.invalid" };
  const app = createApp(ctx);
  const token = await createScimToken(store, TENANT, owner);
  /** The identity provider: every call carries the SCIM token and a SCIM body. */
  const idp = async (method: string, path: string, body?: unknown, bearer = token) => {
    const res = await app.request(`/api/scim/v2${path}`, {
      method,
      headers: { authorization: `Bearer ${bearer}`, "content-type": "application/scim+json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: res.status, body: res.status === 204 ? null : await res.json() };
  };
  return { store, owner, app, idp, token };
}

const OKTA_USER = (email: string, extra: object = {}) => ({
  schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
  userName: email,
  name: { givenName: "Kim", familyName: "Lee" },
  emails: [{ primary: true, value: email, type: "work" }],
  active: true,
  externalId: `okta-${email}`,
  ...extra,
});

describe("the SCIM token", () => {
  it("given no token, another org's token, a session cookie and a forged token, when the directory calls, then each is refused, and the right token is answered", async () => {
    // given
    const { store, owner, app, idp, token } = await organization();
    const other = await createScimToken(store, "globex", owner);
    const session = await startSession(store, TENANT, owner.id);

    // when
    const none = await app.request("/api/scim/v2/Users");
    const elsewhere = await idp("GET", "/Users", undefined, other);
    const cookie = await app.request("/api/scim/v2/Users", { headers: { cookie: `${sessionCookie(TENANT)}=${session.token}` } });
    const forged = await idp("GET", "/Users", undefined, `${token.slice(0, 21)}${"A".repeat(32)}`);
    const right = await idp("GET", "/Users");

    // then
    expect([none.status, elsewhere.status, cookie.status, forged.status, right.status]).toEqual([401, 401, 401, 401, 200]);
    expect(right.body.totalResults).toBe(1);
  });

  it("given an admin and an owner's API key, when each makes a SCIM token, then both are refused", async () => {
    // given
    const { store, owner } = await organization();
    const admin = await principalOf(store, await createUser(store, TENANT, new Set(), { email: "grace@example.invalid", role: "admin" }, owner));

    // when
    const attempts = await Promise.allSettled([
      createScimToken(store, TENANT, admin),
      createScimToken(store, TENANT, { ...owner, key: { id: "k", owner: { kind: "user", id: owner.id }, scopes: {} as never, expiresAt: null } }),
    ]);

    // then
    expect(attempts.map((a) => a.status)).toEqual(["rejected", "rejected"]);
  });
});

describe("provisioning users", () => {
  it("given Okta's create, when a user is added and then looked up by userName, then a member exists with that address and name and the filter finds it", async () => {
    // given
    const { store, idp } = await organization();

    // when
    const created = await idp("POST", "/Users", OKTA_USER("kim@example.invalid"));
    const found = await idp("GET", `/Users?filter=${encodeURIComponent('userName eq "KIM@example.invalid"')}`);

    // then
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ userName: "kim@example.invalid", active: true, externalId: "okta-kim@example.invalid", name: { givenName: "Kim", familyName: "Lee" } });
    expect(await store.getUserByEmail(TENANT, "kim@example.invalid")).toMatchObject({ role: "member", name: "Kim Lee", passwordHash: null });
    expect(found.body).toMatchObject({ totalResults: 1, Resources: [{ id: created.body.id }] });
    expect((await idp("POST", "/Users", OKTA_USER("kim@example.invalid"))).status).toBe(409);
  });

  it("given a provisioned member with a session, a key and an app token, when Entra turns them off with its PATCH, then every way in closes at once, and turning them on lets them sign in again", async () => {
    // given
    const { store, idp } = await organization();
    const created = await idp("POST", "/Users", OKTA_USER("kim@example.invalid"));
    const id = created.body.id as string;
    await signInWithOidc(store, TENANT, { issuer: IDP, subject: "u-kim", email: "kim@example.invalid" });
    const kim = await principalOf(store, (await store.getUser(TENANT, id))!);
    const session = await startSession(store, TENANT, id);
    const key = await createKey(store, TENANT, kim, { name: "ci", scopes: { usage: "read" } });
    await store.setSetting(TENANT, "oauth.grant.g1", JSON.stringify({ userId: id, clientName: "app", scopes: [], createdAt: "x", tokens: ["h1"] }));

    // when
    const off = await idp("PATCH", `${USERS}/${id}`, { schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"], Operations: [{ op: "Replace", path: "active", value: "False" }] });

    // then
    expect(off.body.active).toBe(false);
    expect(await store.getSession(hashToken(session.token))).toBeNull();
    expect((await store.getKey(TENANT, key.key.id))!.revokedAt).not.toBeNull();
    expect(await store.getSetting(TENANT, "oauth.grant.g1")).toBeNull();
    await expect(signInWithOidc(store, TENANT, { issuer: IDP, subject: "u-kim", email: "kim@example.invalid" })).rejects.toThrow(/turned off/);

    // when turned on
    await idp("PATCH", `${USERS}/${id}`, { Operations: [{ op: "replace", value: { active: true } }] });

    // then
    await expect(signInWithOidc(store, TENANT, { issuer: IDP, subject: "u-kim", email: "kim@example.invalid" })).resolves.toMatchObject({ id });
  });

  it("given an account with a password and a session, when the directory turns it off, then the session no longer answers and the right password is refused", async () => {
    // given
    const { store, owner, app, idp } = await organization();
    const max = await createUser(store, TENANT, new Set(), { email: "max@example.invalid", role: "member", password: PASSWORD }, owner);
    const session = await startSession(store, TENANT, max.id);
    const cookie = { cookie: `${sessionCookie(TENANT, true)}=${session.token}` };
    const before = await app.request("/api/me", { headers: cookie });

    // when
    await idp("PUT", `${USERS}/${max.id}`, { userName: "max@example.invalid", active: false });
    // A session written after the account was turned off, as one racing the change would be.
    await store.saveSession({ tokenHash: hashToken("came-back"), tenant: TENANT, userId: max.id, csrf: "c", expiresAt: "2099-01-01T00:00:00.000Z" });
    const after = await app.request("/api/me", { headers: { cookie: `${sessionCookie(TENANT, true)}=came-back` } });

    // then
    expect(before.status).toBe(200);
    expect(await store.getSession(hashToken(session.token))).toBeNull();
    expect(after.status).toBe(401);
    await expect(signInWithPassword(store, TENANT, "max@example.invalid", PASSWORD)).rejects.toThrow(/turned off/);
  });

  it("given the only owner, when the directory turns them off or deletes them, then both are refused and the owner still signs in", async () => {
    // given
    const { store, owner, idp } = await organization();

    // when
    const off = await idp("PATCH", `${USERS}/${owner.id}`, { Operations: [{ op: "replace", path: "active", value: false }] });
    const gone = await idp("DELETE", `${USERS}/${owner.id}`);

    // then
    expect([off.status, gone.status]).toEqual([409, 409]);
    await expect(signInWithPassword(store, TENANT, "ada@example.invalid", PASSWORD)).resolves.toMatchObject({ id: owner.id });
  });

  it("given a provisioned member, when the directory deletes them, then the account is gone and the event log says the directory did it", async () => {
    // given
    const { store, idp } = await organization();
    const created = await idp("POST", "/Users", OKTA_USER("kim@example.invalid"));

    // when
    const gone = await idp("DELETE", `${USERS}/${created.body.id}`);
    const { events } = await store.eventPage(TENANT, {}, null, 10);

    // then
    expect(gone.status).toBe(204);
    expect(await store.getUser(TENANT, created.body.id)).toBeNull();
    expect(events.map((e) => [e.kind, e.actor.name])).toEqual([
      ["scim.user.deleted", "Directory (SCIM)"],
      ["scim.user.created", "Directory (SCIM)"],
    ]);
  });

  it("given a SCIM token, when single sign-on brings an address nobody provisioned or invited, then it does not join", async () => {
    // given
    const { store } = await organization();

    // when
    const attempt = signInWithOidc(store, TENANT, { issuer: IDP, subject: "u-x", email: "stranger@example.invalid" });

    // then
    await expect(attempt).rejects.toThrow(/directory adds people/);
  });

  it("given a filter this orchestrator does not read, when the directory lists users with it, then it is refused rather than ignored", async () => {
    const { idp } = await organization();
    const listed = await idp("GET", `/Users?filter=${encodeURIComponent('name.familyName co "Lee"')}`);
    expect(listed.status).toBe(400);
    expect(listed.body.scimType).toBe("invalidFilter");
  });
});

describe("provisioning groups", () => {
  it("given a group the directory sync maps to a tag, when the directory adds and then removes a member, then the member gains and loses the tag", async () => {
    // given
    const { store, owner, idp } = await organization();
    const kim = (await idp("POST", "/Users", OKTA_USER("kim@example.invalid"))).body.id as string;
    const lee = (await idp("POST", "/Users", OKTA_USER("lee@example.invalid"))).body.id as string;
    const group = await idp("POST", "/Groups", { schemas: ["urn:ietf:params:scim:schemas:core:2.0:Group"], displayName: "eng-backend", members: [{ value: kim }] });
    const mapping = [{ group: "eng-backend", tag: "backend" }];
    await applyMapping(store, TENANT, owner, { mapping, fingerprint: (await previewMapping(store, TENANT, mapping)).preview.fingerprint });
    const tagsOf = async (id: string) => ((await memberTags(store, TENANT)).get(id) ?? []).map((t) => t.tag);

    // when
    await idp("PATCH", `/Groups/${group.body.id}`, { Operations: [{ op: "add", path: "members", value: [{ value: lee }] }] });
    const both = [await tagsOf(kim), await tagsOf(lee)];
    await idp("PATCH", `/Groups/${group.body.id}`, { Operations: [{ op: "remove", path: `members[value eq "${kim}"]` }] });

    // then
    expect(group.status).toBe(201);
    expect(both).toEqual([["backend"], ["backend"]]);
    expect([await tagsOf(kim), await tagsOf(lee)]).toEqual([[], ["backend"]]);
    expect((await idp("GET", `/Groups/${group.body.id}`)).body.members).toEqual([{ value: lee, display: "lee@example.invalid" }]);
  });

  it("given a SCIM group and a member's sign-in that lists other groups, when they sign in through SSO, then their groups stay what the directory says", async () => {
    // given
    const { store, idp } = await organization();
    const kim = (await idp("POST", "/Users", OKTA_USER("kim@example.invalid"))).body.id as string;
    await idp("POST", "/Groups", { displayName: "eng-backend", members: [{ value: kim }] });

    // when
    const { finishOidcSignIn } = await import("./accounts.js");
    await store.saveOidcLogin({ state: "s", tenant: TENANT, nonce: "n", verifier: "v", expiresAt: "2099-01-01T00:00:00.000Z" });
    const oidc = { issuer: IDP, groupsClaim: "groups", start: async () => ({ url: "", login: { state: "s", nonce: "n", verifier: "v", expiresAt: "" } }), finish: async () => ({ issuer: IDP, subject: "u-kim", email: "kim@example.invalid", groups: ["sales"] }) };
    await finishOidcSignIn(store, TENANT, oidc, { state: "s", code: "c", cookieState: "s" });

    // then
    expect(await store.memberGroups(TENANT)).toEqual([{ userId: kim, group: "eng-backend" }]);
  });

  it("given a group, when the directory deletes it, then its members lose its group", async () => {
    // given
    const { store, idp } = await organization();
    const kim = (await idp("POST", "/Users", OKTA_USER("kim@example.invalid"))).body.id as string;
    const group = await idp("POST", "/Groups", { displayName: "eng-backend", members: [{ value: kim }] });

    // when
    const gone = await idp("DELETE", `/Groups/${group.body.id}`);

    // then
    expect(gone.status).toBe(204);
    expect(await store.memberGroups(TENANT)).toEqual([]);
  });
});

describe("the SCIM settings routes", () => {
  it("given an owner's session, when they make a token and read the settings, then the token is shown once and the settings name only its prefix and the address to give the directory", async () => {
    // given
    const store: Store = openSqliteStore(":memory:");
    const owner = await setupFirstOwner(store, TENANT, CODE, { code: CODE, email: "ada@example.invalid", password: PASSWORD });
    const app = createApp({ store, dataDir: "unused", tenant: TENANT, allowedHosts: null, publicUrl: "https://orchestrator.example.invalid" });
    const session = await startSession(store, TENANT, owner.id);
    const headers = { cookie: `${sessionCookie(TENANT, true)}=${session.token}`, [CSRF_HEADER]: session.csrf, "content-type": "application/json" };

    // when
    const made = await (await app.request("/api/scim/token", { method: "POST", headers })).json();
    const read = await (await app.request("/api/scim", { headers })).text();

    // then
    expect(made.token).toMatch(/^th_scim_[0-9a-f]{12}_[A-Za-z0-9_-]{32}$/);
    expect(made.baseUrl).toBe("https://orchestrator.example.invalid/api/scim/v2");
    expect(read).toContain(made.token.slice(0, 20));
    expect(read).not.toContain(made.token.slice(21));
  });
});

describe("audit wave 5: owners the directory turned off do not count as owners", () => {
  async function twoOwners() {
    const org = await organization();
    const bo = await createUser(org.store, TENANT, new Set(), { email: "bo@example.invalid", role: "owner", password: PASSWORD }, org.owner);
    return { ...org, bo };
  }

  it("given two owners, when the directory turns off the first and then the second, then the second is refused and still signs in", async () => {
    // given
    const { store, owner, bo, idp } = await twoOwners();
    const off = { Operations: [{ op: "replace", path: "active", value: false }] };

    // when
    const first = await idp("PATCH", `${USERS}/${owner.id}`, off);
    const second = await idp("PATCH", `${USERS}/${bo.id}`, off);

    // then
    expect([first.status, second.status]).toEqual([200, 409]);
    await expect(signInWithPassword(store, TENANT, "bo@example.invalid", PASSWORD)).resolves.toMatchObject({ id: bo.id });
    expect(await store.countOwners(TENANT)).toBe(1);
  });

  it("given two owners and the first turned off, when the directory deletes the second, then it is refused, while deleting the one turned off goes through", async () => {
    // given
    const { store, owner, bo, idp } = await twoOwners();
    await idp("PATCH", `${USERS}/${owner.id}`, { Operations: [{ op: "replace", path: "active", value: false }] });

    // when
    const onOwner = await idp("DELETE", `${USERS}/${bo.id}`);
    const offOwner = await idp("DELETE", `${USERS}/${owner.id}`);

    // then
    expect([onOwner.status, offOwner.status]).toEqual([409, 204]);
    expect(await store.getUser(TENANT, bo.id)).not.toBeNull();
  });
});
