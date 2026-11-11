import { Hono } from "hono";
import type { Context } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AccountError,
  agentOf,
  CLOUD_SIGN_IN,
  clientAddress,
  clientKey,
  changeOwnPassword,
  createUser,
  exchangeLocalLink,
  LOCAL_SESSION_DAYS,
  LOCAL_SESSION_MAX_DAYS,
  renewedExpiry,
  SESSION_MAX_DAYS,
  sessionLife,
  leave,
  LOCAL_LINK_MINUTES,
  localOwner,
  dropLocalLink,
  mintLocalLink,
  ONE_PERSON,
  LOCAL_ONE_PERSON,
  localOnePerson,
  oneAccountOnly,
  principalOf,
  removeUser,
  setupFirstOwner,
  signInWithOidc,
  signInWithPassword,
  startSession,
  updateUser,
} from "./accounts.js";
import { createApp } from "./app.js";
import { acceptInvite, invite } from "./invites.js";
import { createKey, createServiceAccount, revokeKey } from "./keys.js";
import { allowedHosts, authMode, canEditTeam, orchestratorAuth, CSRF_HEADER, hashToken, hostGuard, LOOPBACK_HOSTS, sessionAuth, sessionCookie, stillAuthorized } from "./auth.js";
import type { OrchestratorEnv, Principal } from "./auth.js";
import { openSqliteStore } from "./store.js";
import type { Store } from "./store.js";
import { rateLimiter } from "./usage.js";

const TENANT = "acme";
const SESSION_COOKIE = sessionCookie(TENANT);
const CODE = "setup-code-for-tests";
const PASSWORD = "correct horse battery";
const TEAMS = new Set(["Payments", "Platform"]);

// Who changes accounts in these cases, unless a case is about who may: an owner other than the accounts it changes.
const BY_OWNER: Principal = { id: "another-owner", name: "Oona Owner", email: "oona@example.invalid", role: "owner", ownedTeams: [] };

async function withOwner(): Promise<{ store: Store; ownerId: string }> {
  const store = openSqliteStore(":memory:");
  const owner = await setupFirstOwner(store, TENANT, CODE, { code: CODE, email: "Ada@Example.invalid", name: "Ada", password: PASSWORD });
  return { store, ownerId: owner.id };
}

function guarded(store: Store) {
  const app = new Hono<OrchestratorEnv>();
  app.use("/api/*", sessionAuth(store, TENANT));
  app.get("/api/whoami", (c) => c.json(c.get("user")));
  app.post("/api/change", (c) => c.json({ changed: true, by: c.get("user").email }));
  return app;
}

describe("setting up the first owner", () => {
  it("given an empty tenant and the printed code, when setup runs, then one owner exists with a hashed password and a normalised address", async () => {
    // given
    const store = openSqliteStore(":memory:");

    // when
    const admin = await setupFirstOwner(store, TENANT, CODE, { code: CODE, email: " Ada@Example.invalid ", name: "Ada", password: PASSWORD });

    // then
    expect(admin).toMatchObject({ role: "owner", email: "ada@example.invalid" });
    expect(admin.passwordHash).toMatch(/^scrypt\$/);
    expect(admin.passwordHash).not.toContain(PASSWORD);
    expect(await store.countUsers(TENANT)).toBe(1);
  });

  it("given a wrong setup code, when setup runs, then it is refused and no account appears", async () => {
    // given
    const store = openSqliteStore(":memory:");

    // when
    const attempt = setupFirstOwner(store, TENANT, CODE, { code: "guess", email: "eve@example.invalid", password: PASSWORD });

    // then
    await expect(attempt).rejects.toMatchObject({ status: 403 });
    expect(await store.countUsers(TENANT)).toBe(0);
  });

  it("given two setup requests racing on an empty tenant, when both run, then exactly one owner is created", async () => {
    // given
    const store = openSqliteStore(":memory:");

    // when
    const results = await Promise.allSettled([
      setupFirstOwner(store, TENANT, CODE, { code: CODE, email: "ada@example.invalid", password: PASSWORD }),
      setupFirstOwner(store, TENANT, CODE, { code: CODE, email: "eve@example.invalid", password: PASSWORD }),
    ]);

    // then
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await store.countUsers(TENANT)).toBe(1);
  });

  it("given a tenant that already has an owner, when setup runs again with the code, then it is refused", async () => {
    // given
    const { store } = await withOwner();

    // when
    const again = setupFirstOwner(store, TENANT, CODE, { code: CODE, email: "eve@example.invalid", password: PASSWORD });

    // then
    await expect(again).rejects.toMatchObject({ status: 409 });
    expect(await store.countUsers(TENANT)).toBe(1);
  });
});

describe("signing in with a password", () => {
  it("given the right and a wrong password, when each signs in, then only the right one passes and the refusal does not say which part was wrong", async () => {
    // given
    const { store } = await withOwner();

    // when
    const ok = await signInWithPassword(store, TENANT, "ADA@example.invalid", PASSWORD);
    const wrong = signInWithPassword(store, TENANT, "ada@example.invalid", "not the password");
    const unknown = signInWithPassword(store, TENANT, "nobody@example.invalid", PASSWORD);

    // then
    expect(ok.email).toBe("ada@example.invalid");
    await expect(wrong).rejects.toThrow("wrong email or password");
    await expect(unknown).rejects.toThrow("wrong email or password");
  });

  it("given an account made for single sign-on, when someone signs in to it with any password, then it is refused", async () => {
    // given
    const { store } = await withOwner();
    await createUser(store, TENANT, TEAMS, { email: "sso@example.invalid", role: "member" }, BY_OWNER);

    // when
    const attempt = signInWithPassword(store, TENANT, "sso@example.invalid", "");

    // then
    await expect(attempt).rejects.toThrow("wrong email or password");
  });
});

describe("a session", () => {
  it("given a signed-in person, when they read and then change something with the session's CSRF token, then both pass as that person", async () => {
    // given
    const { store, ownerId } = await withOwner();
    const session = await startSession(store, TENANT, ownerId);
    const cookie = `${SESSION_COOKIE}=${session.token}`;
    const app = guarded(store);

    // when
    const read = await app.request("/api/whoami", { headers: { cookie } });
    const change = await app.request("/api/change", { method: "POST", headers: { cookie, [CSRF_HEADER]: session.csrf } });

    // then
    expect(read.status).toBe(200);
    expect((await read.json()).email).toBe("ada@example.invalid");
    expect(change.status).toBe(200);
  });

  it("given a valid session cookie, when a change arrives without or with a wrong CSRF token, then it is refused", async () => {
    // given
    const { store, ownerId } = await withOwner();
    const session = await startSession(store, TENANT, ownerId);
    const cookie = `${SESSION_COOKIE}=${session.token}`;
    const app = guarded(store);

    // when
    const missing = await app.request("/api/change", { method: "POST", headers: { cookie } });
    const wrong = await app.request("/api/change", { method: "POST", headers: { cookie, [CSRF_HEADER]: "x".repeat(session.csrf.length) } });

    // then
    expect(missing.status).toBe(403);
    expect(wrong.status).toBe(403);
  });

  it("given an expired session, a forged token and a removed account, when each calls, then each is asked to sign in", async () => {
    // given
    const { store, ownerId } = await withOwner();
    const owner = await createUser(store, TENANT, TEAMS, { email: "olu@example.invalid", role: "member", teams: ["Payments"], password: PASSWORD }, BY_OWNER);
    const expired = await startSession(store, TENANT, ownerId, new Date(Date.now() - 13 * 3_600_000));
    const removed = await startSession(store, TENANT, owner.id);
    await removeUser(store, TENANT, owner.id, BY_OWNER);
    const app = guarded(store);

    // when
    const calls = await Promise.all(
      [expired.token, "forged-token", removed.token].map((token) => app.request("/api/whoami", { headers: { cookie: `${SESSION_COOKIE}=${token}` } })),
    );

    // then
    expect(calls.map((r) => r.status)).toEqual([401, 401, 401]);
  });

  it("given an admin whose role and team an owner takes away, when their open session calls next, then it already reads as a member who edits nothing", async () => {
    // given
    const { store } = await withOwner();
    const owner = await createUser(store, TENANT, TEAMS, { email: "olu@example.invalid", role: "admin", teams: ["Payments"], password: PASSWORD }, BY_OWNER);
    const session = await startSession(store, TENANT, owner.id);
    await updateUser(store, TENANT, TEAMS, owner.id, { role: "member", teams: [] }, BY_OWNER);

    // when
    const res = await guarded(store).request("/api/whoami", { headers: { cookie: `${SESSION_COOKIE}=${session.token}` } });

    // then
    const user = await res.json();
    expect(user).toMatchObject({ role: "member", ownedTeams: [] });
    expect(canEditTeam(user, "Payments")).toBe(false);
  });
});

describe("managing accounts", () => {
  it("given a member who owns one team, when edit rights are asked, then only that team is theirs, a member edits none and an owner edits all", async () => {
    // given
    const { store, ownerId } = await withOwner();
    const owner = await createUser(store, TENANT, TEAMS, { email: "olu@example.invalid", role: "member", teams: ["Payments"] }, BY_OWNER);
    const member = await createUser(store, TENANT, TEAMS, { email: "max@example.invalid", role: "member" }, BY_OWNER);
    const { principalOf } = await import("./accounts.js");

    // when
    const [admin, o, m] = await Promise.all([store.getUser(TENANT, ownerId), owner, member].map(async (u) => principalOf(store, (await u)!)));

    // then
    expect([canEditTeam(admin!, "Payments"), canEditTeam(admin!, "Platform")]).toEqual([true, true]);
    expect([canEditTeam(o!, "Payments"), canEditTeam(o!, "Platform")]).toEqual([true, false]);
    expect([canEditTeam(m!, "Payments"), m!.ownedTeams]).toEqual([false, []]);
  });

  it("given a team no repository belongs to, when someone is given it, then it is refused", async () => {
    // given
    const { store } = await withOwner();

    // when
    const attempt = createUser(store, TENANT, TEAMS, { email: "olu@example.invalid", role: "member", teams: ["Ghosts"] }, BY_OWNER);

    // then
    await expect(attempt).rejects.toThrow(/Ghosts/);
  });

  it("given the only owner, when another owner demotes or removes them, then both are refused", async () => {
    // given
    const { store, ownerId } = await withOwner();

    // when
    const demote = updateUser(store, TENANT, TEAMS, ownerId, { role: "member" }, BY_OWNER);
    const remove = removeUser(store, TENANT, ownerId, BY_OWNER);

    // then
    await expect(demote).rejects.toMatchObject({ status: 409 });
    await expect(remove).rejects.toMatchObject({ status: 409 });
    expect((await store.getUser(TENANT, ownerId))!.role).toBe("owner");
  });

  it("given a second owner, when the first is demoted, then it is allowed", async () => {
    // given
    const { store, ownerId } = await withOwner();
    await createUser(store, TENANT, TEAMS, { email: "grace@example.invalid", role: "owner" }, BY_OWNER);

    // when
    await updateUser(store, TENANT, TEAMS, ownerId, { role: "member" }, BY_OWNER);

    // then
    expect((await store.getUser(TENANT, ownerId))!.role).toBe("member");
  });

  it("given a password change, when it succeeds, then the person's other sessions end and the current one stays", async () => {
    // given
    const { store, ownerId } = await withOwner();
    const here = await startSession(store, TENANT, ownerId);
    const elsewhere = await startSession(store, TENANT, ownerId);

    // when
    await changeOwnPassword(store, (await store.getUser(TENANT, ownerId))!, PASSWORD, "a different long password", hashToken(here.token));

    // then
    expect(await store.getSession(hashToken(here.token))).not.toBeNull();
    expect(await store.getSession(hashToken(elsewhere.token))).toBeNull();
    await expect(signInWithPassword(store, TENANT, "ada@example.invalid", PASSWORD)).rejects.toBeInstanceOf(AccountError);
  });
});

describe("who changes whose role", () => {
  async function organization() {
    const { store, ownerId } = await withOwner();
    const owner = await principalOf(store, (await store.getUser(TENANT, ownerId))!);
    const adminRecord = await createUser(store, TENANT, TEAMS, { email: "grace@example.invalid", role: "admin" }, owner);
    const admin = await principalOf(store, adminRecord);
    const member = await createUser(store, TENANT, TEAMS, { email: "max@example.invalid", role: "member" }, owner);
    return { store, owner, admin, member: await principalOf(store, member) };
  }

  it("given an admin, when they make someone an owner, promote a member to owner, or change, reset or remove an owner, then each is refused and nothing changes", async () => {
    // given
    const { store, owner, admin, member } = await organization();

    // when
    const attempts = await Promise.allSettled([
      createUser(store, TENANT, TEAMS, { email: "new@example.invalid", role: "owner" }, admin),
      updateUser(store, TENANT, TEAMS, member.id, { role: "owner" }, admin),
      updateUser(store, TENANT, TEAMS, owner.id, { role: "member" }, admin),
      updateUser(store, TENANT, TEAMS, owner.id, { password: "an admin's choice of password" }, admin),
      removeUser(store, TENANT, owner.id, admin),
    ]);

    // then
    expect(attempts.map((a) => (a.status === "rejected" ? (a.reason as AccountError).status : 200))).toEqual([403, 403, 403, 403, 403]);
    expect((await store.listUsers(TENANT)).map((u) => [u.email, u.role])).toEqual([
      ["ada@example.invalid", "owner"],
      ["grace@example.invalid", "admin"],
      ["max@example.invalid", "member"],
    ]);
    await expect(signInWithPassword(store, TENANT, "ada@example.invalid", PASSWORD)).resolves.toMatchObject({ id: owner.id });
  });

  it("given an admin, when they add a member, make one an admin and remove a member, then each goes through", async () => {
    // given
    const { store, admin, member } = await organization();

    // when
    const added = await createUser(store, TENANT, TEAMS, { email: "new@example.invalid", role: "member", teams: ["Platform"] }, admin);
    await updateUser(store, TENANT, TEAMS, added.id, { role: "admin" }, admin);
    await removeUser(store, TENANT, member.id, admin);

    // then
    expect(await principalOf(store, (await store.getUser(TENANT, added.id))!)).toMatchObject({ role: "admin", ownedTeams: ["Platform"] });
    expect(await store.getUser(TENANT, member.id)).toBeNull();
  });

  it("given an owner with a second owner beside them and an admin, when each changes their own role, then both are refused", async () => {
    // given
    const { store, owner, admin } = await organization();
    await createUser(store, TENANT, TEAMS, { email: "second@example.invalid", role: "owner" }, owner);

    // when
    const ownerDown = updateUser(store, TENANT, TEAMS, owner.id, { role: "admin" }, owner);
    const adminUp = updateUser(store, TENANT, TEAMS, admin.id, { role: "owner" }, admin);
    const adminDown = updateUser(store, TENANT, TEAMS, admin.id, { role: "member" }, admin);

    // then
    await expect(ownerDown).rejects.toMatchObject({ status: 403 });
    await expect(adminUp).rejects.toMatchObject({ status: 403 });
    await expect(adminDown).rejects.toMatchObject({ status: 403 });
    expect([(await store.getUser(TENANT, owner.id))!.role, (await store.getUser(TENANT, admin.id))!.role]).toEqual(["owner", "admin"]);
  });

  it("given a member, when they add, change or remove anyone, then each is refused", async () => {
    // given
    const { store, admin, member } = await organization();

    // when
    const attempts = await Promise.allSettled([
      createUser(store, TENANT, TEAMS, { email: "new@example.invalid", role: "member" }, member),
      updateUser(store, TENANT, TEAMS, admin.id, { teams: ["Payments"] }, member),
      removeUser(store, TENANT, admin.id, member),
    ]);

    // then
    expect(attempts.map((a) => (a.status === "rejected" ? (a.reason as AccountError).status : 200))).toEqual([403, 403, 403]);
  });

  it("given an owner, an admin and a member, when each leaves, then the owner is refused and stays while the others are gone with their sessions", async () => {
    // given
    const { store, owner, admin, member } = await organization();
    await createUser(store, TENANT, TEAMS, { email: "second@example.invalid", role: "owner" }, owner);
    const session = await startSession(store, TENANT, member.id);

    // when
    const ownerLeaves = leave(store, owner, TENANT);
    await leave(store, admin, TENANT);
    await leave(store, member, TENANT);

    // then
    await expect(ownerLeaves).rejects.toThrow(/can't leave as owner/);
    expect(await store.getUser(TENANT, owner.id)).not.toBeNull();
    expect(await store.getUser(TENANT, admin.id)).toBeNull();
    expect(await store.getUser(TENANT, member.id)).toBeNull();
    expect(await store.getSession(hashToken(session.token))).toBeNull();
  });

  it("given an owner, when they remove themselves as if they were someone else, then it is refused and points at leaving", async () => {
    // given
    const { store, owner } = await organization();

    // when
    const attempt = removeUser(store, TENANT, owner.id, owner);

    // then
    await expect(attempt).rejects.toThrow(/leave the organization/);
  });
});

describe("signing in through the identity provider", () => {
  it("given a subject the orchestrator has not seen, when it signs in, then a member is created and the same subject later finds that account even with a new address", async () => {
    // given
    const { store } = await withOwner();

    // when
    const first = await signInWithOidc(store, TENANT, { issuer: "https://idp.example.invalid", subject: "u-1", email: "kim@example.invalid", name: "Kim" });
    const again = await signInWithOidc(store, TENANT, { issuer: "https://idp.example.invalid", subject: "u-1", email: "kim.new@example.invalid" });

    // then
    expect(first).toMatchObject({ role: "member", email: "kim@example.invalid", passwordHash: null });
    expect(again.id).toBe(first.id);
  });

  it("given an address that already has a local account, when a new subject reports it, then sign-in is refused rather than merged", async () => {
    // given
    const { store } = await withOwner();

    // when
    const attempt = signInWithOidc(store, TENANT, { issuer: "https://idp.example.invalid", subject: "u-2", email: "ada@example.invalid" });

    // then
    await expect(attempt).rejects.toMatchObject({ status: 403 });
    expect(await store.countUsers(TENANT)).toBe(1);
  });
});

describe("choosing how people sign in", () => {
  it("given ORCHESTRATOR_AUTH values, when the mode is read, then local and dev-admin are known and anything else stops the orchestrator", () => {
    expect(authMode(undefined)).toBe("local");
    expect(authMode("local")).toBe("local");
    expect(authMode("dev-admin")).toBe("dev-admin");
    expect(() => authMode("admin")).toThrow(/not a mode/);
  });
});

describe("audit round 2: sign-in", () => {
  it("given an address locked after ten wrong passwords, when the same address comes back with spaces or capitals and the right password, then it is still locked", async () => {
    // given
    const { store } = await withOwner();
    const allow = rateLimiter(10);
    for (let i = 0; i < 10; i++) await signInWithPassword(store, TENANT, "ada@example.invalid", "wrong password", allow).catch(() => undefined);

    // when
    const variants = await Promise.allSettled(["\tada@example.invalid", " ada@example.invalid ", "ADA@example.invalid  "].map((e) => signInWithPassword(store, TENANT, e, PASSWORD, allow)));

    // then
    expect(variants.map((v) => (v.status === "rejected" ? (v.reason as AccountError).status : 200))).toEqual([429, 429, 429]);
  });

  it("given an address with spaces around it, when it signs in under the limit, then it finds the account", async () => {
    const { store } = await withOwner();
    await expect(signInWithPassword(store, TENANT, "  Ada@Example.invalid\t", PASSWORD, rateLimiter(10))).resolves.toMatchObject({ role: "owner" });
  });
});

describe("audit round 2: an orchestrator with no owner yet", () => {
  it("given an empty orchestrator with single sign-on, when someone the provider lets through signs in first, then no account is made and setup still works", async () => {
    // given
    const store = openSqliteStore(":memory:");

    // when
    const first = signInWithOidc(store, TENANT, { issuer: "https://idp.example.invalid", subject: "u-1", email: "eve@example.invalid" });

    // then
    await expect(first).rejects.toMatchObject({ status: 403 });
    expect(await store.countUsers(TENANT)).toBe(0);
    await expect(setupFirstOwner(store, TENANT, CODE, { code: CODE, email: "ada@example.invalid", password: PASSWORD })).resolves.toMatchObject({ role: "owner" });
  });

  it("given an orchestrator that has accounts but no owner, when setup runs with the code, then an owner is created and setup is closed after it", async () => {
    // given
    const store = openSqliteStore(":memory:");
    await store.insertUser({ tenant: TENANT, id: "m1", email: "max@example.invalid", name: "Max", role: "member", passwordHash: null, oidcIssuer: "https://idp.example.invalid", oidcSubject: "u-9", forgeLogin: null, createdAt: new Date().toISOString() });

    // when
    const admin = await setupFirstOwner(store, TENANT, CODE, { code: CODE, email: "ada@example.invalid", password: PASSWORD });

    // then
    expect(admin.role).toBe("owner");
    expect(await store.countOwners(TENANT)).toBe(1);
    await expect(setupFirstOwner(store, TENANT, CODE, { code: CODE, email: "eve@example.invalid", password: PASSWORD })).rejects.toMatchObject({ status: 409 });
  });
});

describe("audit round 2: passwords on single sign-on accounts", () => {
  it("given an account made through single sign-on, when its holder sets a password of their own, then it is refused and no password sign-in appears", async () => {
    // given
    const { store } = await withOwner();
    const sso = await signInWithOidc(store, TENANT, { issuer: "https://idp.example.invalid", subject: "u-1", email: "kim@example.invalid" });

    // when
    const attempt = changeOwnPassword(store, sso, "anything at all", "a password of my own", "");

    // then
    await expect(attempt).rejects.toThrow("this account signs in through single sign-on; an admin sets a password if it needs one");
    expect((await store.getUser(TENANT, sso.id))!.passwordHash).toBeNull();
  });

  it("given an owner, when they set a password on a single sign-on account, then it is set and what changed says a second way in was added", async () => {
    // given
    const { store } = await withOwner();
    const sso = await signInWithOidc(store, TENANT, { issuer: "https://idp.example.invalid", subject: "u-1", email: "kim@example.invalid" });

    // when
    const changed = await updateUser(store, TENANT, TEAMS, sso.id, { password: "an admin chose this one" }, BY_OWNER);

    // then
    await expect(signInWithPassword(store, TENANT, "kim@example.invalid", "an admin chose this one")).resolves.toMatchObject({ id: sso.id });
    expect(changed).toEqual(["a password set where there was none, its sessions signed out"]);
    expect(JSON.stringify(changed)).not.toContain("an admin chose this one");
  });
});

describe("audit round 2: an address an admin invited for single sign-on", () => {
  const IDP = "https://idp.example.invalid";

  it("given an invited account without a password, when the provider signs in that verified address, then the account is bound to the subject once and later found by it", async () => {
    // given
    const { store } = await withOwner();
    const invited = await createUser(store, TENANT, TEAMS, { email: "olu@example.invalid", role: "owner", teams: ["Payments"] }, BY_OWNER);

    // when
    const first = await signInWithOidc(store, TENANT, { issuer: IDP, subject: "u-5", email: "OLU@example.invalid" });
    const again = await signInWithOidc(store, TENANT, { issuer: IDP, subject: "u-5" });

    // then
    expect([first.id, again.id]).toEqual([invited.id, invited.id]);
    expect(await store.getUser(TENANT, invited.id)).toMatchObject({ role: "owner", oidcIssuer: IDP, oidcSubject: "u-5" });
  });

  it.each([
    ["an account with a password", async (store: Store) => createUser(store, TENANT, TEAMS, { email: "olu@example.invalid", role: "member", password: PASSWORD }, BY_OWNER)],
    [
      "an invitation already bound to another subject",
      async (store: Store) => {
        await createUser(store, TENANT, TEAMS, { email: "olu@example.invalid", role: "member" }, BY_OWNER);
        return signInWithOidc(store, TENANT, { issuer: IDP, subject: "u-5", email: "olu@example.invalid" });
      },
    ],
  ])("given %s, when a new subject reports its address, then it is refused without saying the account exists", async (_label, arrange) => {
    // given
    const { store } = await withOwner();
    const existing = await arrange(store);

    // when
    const attempt = signInWithOidc(store, TENANT, { issuer: IDP, subject: "u-6", email: "olu@example.invalid" });

    // then
    await expect(attempt).rejects.toThrow("this address cannot sign in with SSO here; ask an admin");
    expect((await store.getUser(TENANT, existing.id))!.oidcSubject).not.toBe("u-6");
  });
});

describe("audit round 2: expired rows", () => {
  it("given an expired session and an unanswered sign-in past its ten minutes, when a new session starts, then both are gone", async () => {
    // given
    const { store, ownerId } = await withOwner();
    const old = await startSession(store, TENANT, ownerId, new Date(Date.now() - 13 * 3_600_000));
    await store.saveOidcLogin({ state: "s-old", tenant: TENANT, nonce: "n", verifier: "v", expiresAt: new Date(Date.now() - 60_000).toISOString() });

    // when
    await startSession(store, TENANT, ownerId);

    // then
    expect(await store.getSession(hashToken(old.token))).toBeNull();
    expect(await store.takeOidcLogin("s-old")).toBeNull();
  });
});

describe("audit round 2: host names", () => {
  function app(hosts: string[]) {
    const h = new Hono();
    h.use("*", hostGuard(hosts));
    h.get("/api/me", (c) => c.json({ ok: true }));
    return h;
  }

  it("given dev-admin, when a request names a host that is not this machine, then it is refused, while the loopback names pass", async () => {
    // given
    const hosts = allowedHosts("dev-admin", "rebind.example");

    // when
    const answers = await Promise.all(
      ["http://rebind.example/api/me", "http://127.0.0.1:8080/api/me", "http://localhost:8080/api/me", "http://[::1]:8080/api/me"].map(async (url) => (await app(hosts!).request(url)).status),
    );

    // then
    expect(hosts).toEqual(LOOPBACK_HOSTS);
    expect(answers).toEqual([421, 200, 200, 200]);
  });

  it("given one person's orchestrator on their own machine, when a page re-resolves its domain to it, then only the loopback names are answered, whatever is listed", async () => {
    // given
    const hosts = allowedHosts("local", "orchestrator.example.com", true);

    // when
    const answers = await Promise.all(["http://rebind.example/api/me", "http://orchestrator.example.com/api/me", "http://127.0.0.1:8080/api/me", "http://localhost:5173/api/me"].map(async (url) => (await app(hosts!).request(url)).status));

    // then
    expect(hosts).toEqual(LOOPBACK_HOSTS);
    expect(answers).toEqual([421, 421, 200, 200]);
  });

  it("given a self-hosted orchestrator signing in with accounts, when ORCHESTRATOR_ALLOWED_HOSTS is set or not, then only the listed names pass or every name does", () => {
    expect(allowedHosts("local", " Orchestrator.Example.com ,127.0.0.1", false)).toEqual(["orchestrator.example.com", "127.0.0.1"]);
    expect(allowedHosts("local", undefined, false)).toBeNull();
  });
});

describe("audit round 2: every route that changes something asks for the CSRF token", () => {
  it.each([
    ["POST", "/api/me/password"],
    ["POST", "/api/me/leave"],
    ["PATCH", "/api/me"],
    ["POST", "/api/me/deletion"],
    ["POST", "/api/invites"],
    ["POST", "/api/invites/x/resend"],
    ["DELETE", "/api/invites/x"],
    ["POST", "/api/auth/logout"],
    ["POST", "/api/users"],
    ["PATCH", "/api/users/x"],
    ["DELETE", "/api/users/x"],
    ["POST", "/api/repos"],
    ["POST", "/api/repos/payments-skills/sync"],
    ["POST", "/api/repos/payments-skills/usage/propose"],
    ["POST", "/api/repos/payments-skills/changes/proposal"],
    ["POST", "/api/repos/payments-skills/changes"],
    ["POST", "/api/repos/payments-skills/requests/1/merge"],
    ["POST", "/api/repos/payments-skills/requests/1/close"],
    ["POST", "/api/repos/payments-skills/requests/1/refresh"],
    ["PUT", "/api/repos/payments-skills/forge"],
    ["DELETE", "/api/repos/payments-skills/forge"],
  ])("given an admin's session without the token, when %s %s is called, then it is refused as a cross-site change", async (method, path) => {
    // given
    const { store, ownerId } = await withOwner();
    const session = await startSession(store, TENANT, ownerId);
    const api = createApp({ store, dataDir: "unused", tenant: TENANT, allowedHosts: null });

    // when
    const res = await api.request(path, { method, headers: { cookie: `${SESSION_COOKIE}=${session.token}`, "content-type": "application/json" }, body: "{}" });

    // then
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/did not come from the orchestrator's own page/);
  });
});

describe("audit round 3: limits that count per client", () => {
  const oidc = {
    issuer: "https://idp.example.invalid",
    groupsClaim: "groups",
    start: async () => ({ url: "https://idp.example.invalid/authorize", login: { state: `s-${Math.random()}`, nonce: "n", verifier: "v", expiresAt: new Date(Date.now() + 600_000).toISOString() } }),
    finish: async () => ({ issuer: "https://idp.example.invalid", subject: "u" }),
  };
  const from = (remoteAddress: string, headers: Record<string, string> = {}) => [{ headers }, { incoming: { socket: { remoteAddress } } }] as const;

  it("given the connection and a forwarded-for header, when the client is read, then the header counts only from a named proxy", () => {
    expect(clientAddress("203.0.113.9", "198.51.100.1", [])).toBe("203.0.113.9");
    expect(clientAddress("::ffff:10.0.0.2", "198.51.100.1, 10.0.0.3", ["10.0.0.2", "10.0.0.3"])).toBe("198.51.100.1");
    expect(clientAddress("10.0.0.2", "6.6.6.6, 198.51.100.1", ["10.0.0.2"])).toBe("198.51.100.1");
    expect(clientAddress(undefined, undefined, [])).toBe("unknown");
  });

  it("given one client starting SSO sign-ins in a loop, when it passes its limit, then it is held back while another client still starts", async () => {
    // given
    const { store } = await withOwner();
    const app = createApp({ store, dataDir: "unused", tenant: TENANT, allowedHosts: null, oidc });
    for (let i = 0; i < 10; i++) await app.request("/api/auth/oidc/start", ...from("203.0.113.9"));

    // when
    const flooder = await app.request("/api/auth/oidc/start", ...from("203.0.113.9"));
    const someoneElse = await app.request("/api/auth/oidc/start", ...from("198.51.100.7"));

    // then
    expect(flooder.status).toBe(429);
    expect(someoneElse.status).toBe(302);
  });

  it("given a trusted proxy, when clients behind it start SSO, then each is counted by the address the proxy forwarded", async () => {
    const { store } = await withOwner();
    const app = createApp({ store, dataDir: "unused", tenant: TENANT, allowedHosts: null, oidc, trustedProxies: ["10.0.0.2"] });
    for (let i = 0; i < 10; i++) await app.request("/api/auth/oidc/start", ...from("10.0.0.2", { "x-forwarded-for": "203.0.113.9" }));
    expect((await app.request("/api/auth/oidc/start", ...from("10.0.0.2", { "x-forwarded-for": "203.0.113.9" }))).status).toBe(429);
    expect((await app.request("/api/auth/oidc/start", ...from("10.0.0.2", { "x-forwarded-for": "198.51.100.7" }))).status).toBe(302);
  });

  it("given one client trying a password against many addresses, when it passes thirty, then it is held back while another client still signs in", async () => {
    // given
    const { store } = await withOwner();
    const app = createApp({ store, dataDir: "unused", tenant: TENANT, allowedHosts: null });
    const login = (email: string, password: string, remoteAddress: string) =>
      app.request("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password }) }, { incoming: { socket: { remoteAddress } } });
    for (let i = 0; i < 30; i++) await login(`user${i}@example.invalid`, "guess", "203.0.113.9");

    // when
    const sprayer = await login("ada@example.invalid", PASSWORD, "203.0.113.9");
    const someoneElse = await login("ada@example.invalid", PASSWORD, "198.51.100.7");

    // then
    expect(sprayer.status).toBe(429);
    expect(someoneElse.status).toBe(200);
  });
});

describe("audit round 3: the orchestrator binds its host check", () => {
  it("given an orchestrator built under dev-admin, when a request names a foreign host, then the orchestrator itself answers 421", async () => {
    // given
    const { store } = await withOwner();
    const saved = process.env.ORCHESTRATOR_AUTH;
    process.env.ORCHESTRATOR_AUTH = "dev-admin";
    try {
      const app = createApp({ store, dataDir: "unused", tenant: TENANT });

      // when
      const foreign = await app.request("http://rebind.example/api/health");
      const loopback = await app.request("http://127.0.0.1:8080/api/health");

      // then
      expect(foreign.status).toBe(421);
      expect(loopback.status).toBe(200);
    } finally {
      if (saved === undefined) delete process.env.ORCHESTRATOR_AUTH;
      else process.env.ORCHESTRATOR_AUTH = saved;
    }
  });

  it("given an orchestrator given a host list, when a request names a host outside it, then it answers 421", async () => {
    const { store } = await withOwner();
    const app = createApp({ store, dataDir: "unused", tenant: TENANT, allowedHosts: ["orchestrator.example.com"] });
    expect((await app.request("http://other.example.com/api/health")).status).toBe(421);
    expect((await app.request("http://orchestrator.example.com/api/health")).status).toBe(200);
  });
});

describe("two tenants' orchestrators on one host", () => {
  it("given a person signed in to both, when the first is called with every cookie the browser holds for the host, then it still knows them", async () => {
    // given
    const store = openSqliteStore(":memory:");
    for (const tenant of ["acme", "globex"]) await setupFirstOwner(store, tenant, CODE, { code: CODE, email: "ada@example.invalid", name: "Ada", password: PASSWORD });
    const orchestrators = ["acme", "globex"].map((tenant) => createApp({ store, dataDir: "unused", tenant, allowedHosts: null }));
    // A browser keeps one cookie per name and host, whatever the port: a second sign-in under
    // the same name would replace the first.
    const jar = new Map<string, string>();
    for (const app of orchestrators) {
      const res = await app.request("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "ada@example.invalid", password: PASSWORD }) });
      for (const set of res.headers.getSetCookie()) {
        const [pair] = set.split(";");
        jar.set(pair!.slice(0, pair!.indexOf("=")), pair!.slice(pair!.indexOf("=") + 1));
      }
    }
    const cookie = [...jar].map(([name, value]) => `${name}=${value}`).join("; ");

    // when
    const first = await orchestrators[0]!.request("/api/me", { headers: { cookie } });
    const second = await orchestrators[1]!.request("/api/me", { headers: { cookie } });

    // then
    expect(jar.size).toBe(2);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(sessionCookie("acme")).not.toBe(sessionCookie("globex"));
  });
});

describe("audit round 3: IPv6 clients", () => {
  it("given IPv6 addresses, when they are keyed, then one /64 is one client and an IPv4 address stays itself", () => {
    expect(clientKey("2001:db8:0:0:1:2:3:4")).toBe("2001:db8:0:0::/64");
    expect(clientKey("2001:db8::9")).toBe("2001:db8:0:0::/64");
    expect(clientKey("2001:DB8:0:1::1")).toBe("2001:db8:0:1::/64");
    expect(clientKey("::1")).toBe("0:0:0:0::/64");
    expect(clientKey("203.0.113.9")).toBe("203.0.113.9");
  });

  it("given one host rotating addresses inside its /64, when it starts SSO sign-ins, then they share one limit while the next /64 is separate", async () => {
    // given
    const { store } = await withOwner();
    const oidc = {
      issuer: "https://idp.example.invalid",
      groupsClaim: "groups",
      start: async () => ({ url: "https://idp.example.invalid/authorize", login: { state: `s-${Math.random()}`, nonce: "n", verifier: "v", expiresAt: new Date(Date.now() + 600_000).toISOString() } }),
      finish: async () => ({ issuer: "https://idp.example.invalid", subject: "u" }),
    };
    const app = createApp({ store, dataDir: "unused", tenant: TENANT, allowedHosts: null, oidc });
    const start = (remoteAddress: string) => app.request("/api/auth/oidc/start", {}, { incoming: { socket: { remoteAddress } } });
    for (let i = 1; i <= 10; i++) await start(`2001:db8::${i.toString(16)}`);

    // when
    const sameNetwork = await start("2001:db8::ffff");
    const nextNetwork = await start("2001:db8:0:1::1");

    // then
    expect(sameNetwork.status).toBe(429);
    expect(nextNetwork.status).toBe(302);
  });
});

describe("an orchestrator that seals with a key it made for one person", () => {
  it("given its one account, when a second is added by hand or by invitation, then both are refused and it stays one person's, while an orchestrator with its key set adds them", async () => {
    // given
    const single = await withOwner();
    oneAccountOnly(single.store, [TENANT]);
    const shared = await withOwner();
    const owner = await principalOf(single.store, (await single.store.getUser(TENANT, single.ownerId))!);
    const { invited } = await invite(single.store, TENANT, new Set(), { emails: "kim@example.invalid", role: "member" }, owner);

    // when
    const attempts = await Promise.allSettled([
      createUser(single.store, TENANT, new Set(), { email: "lee@example.invalid", role: "member", password: PASSWORD }, owner),
      acceptInvite(single.store, TENANT, invited[0]!.token, { name: "Kim", password: PASSWORD }),
    ]);
    const added = await createUser(shared.store, TENANT, new Set(), { email: "lee@example.invalid", role: "member", password: PASSWORD }, await principalOf(shared.store, (await shared.store.getUser(TENANT, shared.ownerId))!));

    // then
    expect(attempts.map((a) => (a as PromiseRejectedResult).reason?.message)).toEqual([ONE_PERSON, ONE_PERSON]);
    expect(await single.store.countUsers(TENANT)).toBe(1);
    expect(added.email).toBe("lee@example.invalid");
  });
});

describe("a local orchestrator, whatever key it seals with", () => {
  it("given its one owner, when a second account is added by hand or by invitation and a service account is made, then each is refused and it stays that one person's", async () => {
    // given
    const local = await withOwner();
    localOnePerson(local.store, [TENANT]);
    const owner = await principalOf(local.store, (await local.store.getUser(TENANT, local.ownerId))!);
    const { invited } = await invite(local.store, TENANT, new Set(), { emails: "kim@example.invalid", role: "member" }, owner);

    // when
    const attempts = await Promise.allSettled([
      createUser(local.store, TENANT, new Set(), { email: "lee@example.invalid", role: "member", password: PASSWORD }, owner),
      acceptInvite(local.store, TENANT, invited[0]!.token, { name: "Kim", password: PASSWORD }),
      createServiceAccount(local.store, TENANT, new Set(), { name: "nightly" }, owner),
    ]);

    // then
    expect(attempts.map((a) => (a as PromiseRejectedResult).reason?.message)).toEqual([LOCAL_ONE_PERSON, LOCAL_ONE_PERSON, LOCAL_ONE_PERSON]);
    expect([await local.store.countUsers(TENANT), (await local.store.listServiceAccounts(TENANT)).length]).toEqual([1, 0]);
  });
});

describe("how the orchestrator runs, as /api/me says it", () => {
  it("given an orchestrator run in each mode and one that names none, when a signed-in person reads themselves, then each says how it runs", async () => {
    // given
    const store = openSqliteStore(":memory:");
    await setupFirstOwner(store, TENANT, CODE, { code: CODE, email: "ada@example.invalid", name: "Ada", password: PASSWORD });
    const read = async (mode: "cloud" | "self-hosted" | undefined) => {
      const app = createApp({ store, dataDir: "unused", tenant: TENANT, allowedHosts: null, ...(mode ? { mode } : {}) });
      const login = await app.request("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "ada@example.invalid", password: PASSWORD }) });
      const cookie = login.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");

      // when
      return (await (await app.request("/api/me", { headers: { cookie } })).json()).user.mode;
    };

    // then
    expect([await read("cloud"), await read("self-hosted"), await read(undefined)]).toEqual(["cloud", "self-hosted", "self-hosted"]);
  });
});

describe("a cloud orchestrator's sign-in", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("given ORCHESTRATOR_MODE=cloud, when the setup code, a password or a password-set invitation is tried, then each is refused and no owner is set up, while the same calls on an orchestrator with no mode go through", async () => {
    // given
    vi.stubEnv("ORCHESTRATOR_MODE", "cloud");
    const cloudStore = openSqliteStore(":memory:");
    const cloud = createApp({ store: cloudStore, dataDir: "unused", tenant: TENANT, allowedHosts: null, setupCode: CODE });
    vi.unstubAllEnvs();
    const selfHosted = createApp({ store: openSqliteStore(":memory:"), dataDir: "unused", tenant: TENANT, allowedHosts: null, setupCode: CODE });
    const post = (app: { request: (path: string, init: RequestInit) => Response | Promise<Response> }, path: string, body: unknown) => app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const owner = { code: CODE, email: "ada@example.invalid", name: "Ada", password: PASSWORD };

    // when
    const answers = [await post(cloud, "/api/auth/setup", owner), await post(cloud, "/api/auth/login", { email: owner.email, password: PASSWORD }), await post(cloud, "/api/join", { token: "x", password: PASSWORD })];
    const config = await (await cloud.request("/api/auth/config")).json();
    const set = await post(selfHosted, "/api/auth/setup", owner);

    // then
    expect(answers.map((a) => a.status)).toEqual([403, 403, 403]);
    for (const a of answers) expect((await a.json()).error).toBe(CLOUD_SIGN_IN);
    expect(config.setupNeeded).toBe(false);
    expect(await cloudStore.countOwners(TENANT)).toBe(0);
    expect(set.status).toBe(200);
  });
});

describe("the links every signed-in page shows at its foot", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("given the operator's privacy and terms addresses, when a signed-in page reads who it is, then the answer carries both, and an orchestrator without them carries none", async () => {
    // given
    vi.stubEnv("ORCHESTRATOR_PRIVACY_URL", "https://pages.example.invalid/privacy");
    vi.stubEnv("ORCHESTRATOR_TERMS_URL", "https://pages.example.invalid/terms");
    const { store, ownerId } = await withOwner();
    const withLinks = createApp({ store, dataDir: "unused", tenant: TENANT, allowedHosts: null });
    vi.unstubAllEnvs();
    const without = createApp({ store, dataDir: "unused", tenant: TENANT, allowedHosts: null });
    const session = await startSession(store, TENANT, ownerId);
    const headers = { cookie: `${SESSION_COOKIE}=${session.token}` };

    // when
    const linked = await (await withLinks.request("/api/me", { headers })).json();
    const bare = await (await without.request("/api/me", { headers })).json();

    // then
    expect(linked.legal).toEqual({ privacyUrl: "https://pages.example.invalid/privacy", termsUrl: "https://pages.example.invalid/terms" });
    expect(bare.legal).toEqual({ privacyUrl: null, termsUrl: null });
  });
});

describe("keeping a team's tasks to its owners", () => {
  it("given a team's repository, when a member, then an admin, marks it restricted and opens it again, then only the admin's changes hold and every account read afterwards carries the list", async () => {
    // given
    const { store, ownerId } = await withOwner();
    await store.upsertRepo({ tenant: TENANT, id: "ledger-skills", team: "Ledger", name: "ledger-skills", url: "/nowhere/ledger.git" });
    const owner = (await store.getUser(TENANT, ownerId))!;
    const member = await createUser(store, TENANT, new Set(["Ledger"]), { email: "max@example.invalid", role: "member", password: PASSWORD }, await principalOf(store, owner));
    const app = createApp({ store, dataDir: "unused", tenant: TENANT, allowedHosts: null });
    const as = async (id: string) => {
      const s = await startSession(store, TENANT, id);
      return { cookie: `${SESSION_COOKIE}=${s.token}`, [CSRF_HEADER]: s.csrf, "content-type": "application/json" };
    };
    const put = async (id: string, restricted: unknown) => app.request("/api/teams/Ledger/restricted", { method: "PUT", headers: await as(id), body: JSON.stringify({ restricted }) });

    // when
    const byMember = await put(member.id, true);
    const byOwner = await put(ownerId, true);
    const marked = (await principalOf(store, member)).restrictedTeams;
    const listed = (await (await app.request("/api/teams", { headers: await as(member.id) })).json()).teams;
    const opened = await put(ownerId, false);

    // then
    expect([byMember.status, byOwner.status, opened.status]).toEqual([403, 200, 200]);
    expect(marked).toEqual(["Ledger"]);
    expect(listed).toEqual([expect.objectContaining({ team: "Ledger", restricted: true })]);
    expect((await principalOf(store, member)).restrictedTeams).toEqual([]);
  });
});

describe("a long-lived request whose access is taken away", () => {
  /**
   * A stream stood in for: it checks before and after something happens to its caller, as a task's
   * live stream does each few seconds. It answers at a route a key reaches, so the key gets past the table.
   */
  function streaming(store: Store, during: (c: Context<OrchestratorEnv>) => Promise<unknown>) {
    const app = new Hono<OrchestratorEnv>();
    app.use("/api/*", orchestratorAuth(store, TENANT, "local"));
    app.get("/api/repos", async (c) => {
      const before = await stillAuthorized(c, store, TENANT);
      await during(c);
      return c.json({ before, after: await stillAuthorized(c, store, TENANT) });
    });
    return app;
  }

  it("given a stream opened with a session, with a key, and by a member, when the session ends, the key is revoked and the member is removed, then each is told it holds access no more", async () => {
    // given
    const { store, ownerId } = await withOwner();
    const owner = await principalOf(store, (await store.getUser(TENANT, ownerId))!);
    const member = await createUser(store, TENANT, new Set(), { email: "max@example.invalid", role: "member", password: PASSWORD }, owner);
    const session = await startSession(store, TENANT, ownerId);
    const memberSession = await startSession(store, TENANT, member.id);
    const { key, secret } = await createKey(store, TENANT, owner, { name: "ci", scopes: { repositories: "read" } });
    const cookie = (token: string) => ({ cookie: `${SESSION_COOKIE}=${token}` });

    // when
    const ended = await (await streaming(store, () => store.deleteSessions(TENANT, ownerId)).request("/api/repos", { headers: cookie(session.token) })).json();
    const revoked = await (await streaming(store, () => revokeKey(store, TENANT, owner, key.id)).request("/api/repos", { headers: { authorization: `Bearer ${secret}` } })).json();
    const removed = await (await streaming(store, () => removeUser(store, TENANT, member.id, owner)).request("/api/repos", { headers: cookie(memberSession.token) })).json();

    // then
    expect([ended, revoked, removed]).toEqual([
      { before: true, after: false },
      { before: true, after: false },
      { before: true, after: false },
    ]);
  });
});

describe("a viewer", () => {
  it("given a viewer's session and key, when they read, change their own name, mint a key, propose a change, or are given a team, then reading and their own account pass and every change to the organization is refused", async () => {
    // given
    const { store, ownerId } = await withOwner();
    await store.upsertRepo({ tenant: TENANT, id: "ledger-skills", team: "Ledger", name: "ledger-skills", url: "/nowhere/ledger.git" });
    const owner = await principalOf(store, (await store.getUser(TENANT, ownerId))!);
    const viewer = await createUser(store, TENANT, new Set(["Ledger"]), { email: "vee@example.invalid", role: "viewer", password: PASSWORD }, owner);
    const app = createApp({ store, dataDir: "unused", tenant: TENANT, allowedHosts: null });
    const s = await startSession(store, TENANT, viewer.id);
    const headers = { cookie: `${SESSION_COOKIE}=${s.token}`, [CSRF_HEADER]: s.csrf, "content-type": "application/json" };
    const call = (method: string, path: string, body: unknown = {}) => app.request(path, { method, headers, ...(method === "GET" ? {} : { body: JSON.stringify(body) }) });

    // when
    const reads = await call("GET", "/api/repos");
    const renamed = await call("PATCH", "/api/me", { name: "Vee" });
    const proposed = await call("POST", "/api/repos/ledger-skills/changes", {});
    const restricted = await call("PUT", "/api/teams/Ledger/restricted", { restricted: true });
    const writeKey = await call("POST", "/api/keys", { name: "w", scopes: { requests: "write" } });
    const readKey = await call("POST", "/api/keys", { name: "r", scopes: { repositories: "read" } });
    const owning = updateUser(store, TENANT, new Set(["Ledger"]), viewer.id, { teams: ["Ledger"] }, owner);
    const invited = invite(store, TENANT, new Set(["Ledger"]), { emails: "wee@example.invalid", role: "viewer", teams: ["Ledger"] }, owner);

    // then
    expect([reads.status, renamed.status, readKey.status]).toEqual([200, 200, 200]);
    expect([proposed.status, restricted.status, writeKey.status]).toEqual([403, 403, 403]);
    expect((await proposed.json()).error).toBe("a viewer reads the organization and changes nothing in it");
    await expect(owning).rejects.toThrow("a viewer owns no team");
    await expect(invited).rejects.toThrow("a viewer owns no team");
  });
});

describe("where a person is signed in", () => {
  it("given Ada signed in from Firefox and Chrome and Max from Safari, when Ada lists her sessions and ends the Chrome one, then she sees both by browser with this one marked, Chrome's ends, and Max's session is not hers to end", async () => {
    // given
    const { store, ownerId } = await withOwner();
    const owner = await principalOf(store, (await store.getUser(TENANT, ownerId))!);
    await createUser(store, TENANT, new Set(), { email: "max@example.invalid", role: "member", password: PASSWORD }, owner);
    const app = createApp({ store, dataDir: "unused", tenant: TENANT, allowedHosts: null });
    const signIn = async (email: string, agent: string) => {
      const res = await app.request("/api/auth/login", { method: "POST", headers: { "content-type": "application/json", "user-agent": agent }, body: JSON.stringify({ email, password: PASSWORD }) });
      const cookie = res.headers.getSetCookie()[0]!.split(";")[0]!;
      const { csrf } = await (await app.request("/api/me", { headers: { cookie } })).json();
      return { cookie, [CSRF_HEADER]: csrf };
    };
    const firefox = await signIn("ada@example.invalid", "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0");
    await signIn("ada@example.invalid", "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36");
    const max = await signIn("max@example.invalid", "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1");

    // when
    const before = (await (await app.request("/api/me/sessions", { headers: firefox })).json()).sessions as { id: string; userAgent: string; current: boolean }[];
    const chrome = before.find((s) => s.userAgent === "Chrome on macOS")!;
    const maxs = (await (await app.request("/api/me/sessions", { headers: max })).json()).sessions as { id: string }[];
    const ended = await app.request(`/api/me/sessions/${chrome.id}`, { method: "DELETE", headers: firefox });
    const notHers = await app.request(`/api/me/sessions/${maxs[0]!.id}`, { method: "DELETE", headers: firefox });
    const after = (await (await app.request("/api/me/sessions", { headers: firefox })).json()).sessions as { userAgent: string }[];

    // then
    expect(before.map((s) => [s.userAgent, s.current]).sort()).toEqual([["Chrome on macOS", false], ["Firefox on Windows", true]]);
    expect(JSON.stringify(before)).not.toMatch(/tokenHash|csrf/);
    expect([ended.status, notHers.status]).toEqual([200, 404]);
    expect(after.map((s) => s.userAgent)).toEqual(["Firefox on Windows"]);
    expect((await app.request("/api/me", { headers: max })).status).toBe(200);
  });

  it("given browser headers, when they are cut to a family and a system, then a person tells sessions apart and the full header is not kept", () => {
    expect(agentOf("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36 Edg/131.0")).toBe("Edge on Linux");
    expect(agentOf("Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Mobile Safari/537.36")).toBe("Chrome on Android");
    expect(agentOf("curl/8.7.1")).toBeNull();
    expect(agentOf(undefined)).toBeNull();
  });
});

// The button on the page the printed address answers: the one step that spends the address.
const signInLocally = (app: { request: (path: string, init?: RequestInit) => Response | Promise<Response> }, token: string) =>
  app.request("/api/auth/local", { method: "POST", body: new URLSearchParams({ token }) });

describe("a local orchestrator's one person", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("given a local orchestrator started twice, when its owner is made and the printed address is opened, previewed and its button pressed, then one owner exists, opening spends nothing, the button signs them in once and leaves the address bar, and no setup or password form is offered", async () => {
    // given
    vi.stubEnv("ORCHESTRATOR_MODE", "local");
    const store = openSqliteStore(":memory:");
    const first = await localOwner(store, TENANT, { email: "owner@this-machine.invalid", name: "ada" });
    const again = await localOwner(store, TENANT, { email: "owner@this-machine.invalid", name: "ada" });
    const app = createApp({ store, dataDir: "unused", tenant: TENANT, allowedHosts: null });
    const token = await mintLocalLink(store, TENANT);

    // when
    const previewed = await app.request(`/api/auth/local?token=${token}`);
    const opened = await app.request(`/api/auth/local?token=${token}`);
    const signedIn = await signInLocally(app, token);
    const cookie = signedIn.headers.getSetCookie()[0]!.split(";")[0]!;
    const reused = await signInLocally(app, token);
    const reopened = await app.request(`/api/auth/local?token=${token}`);
    const config = await (await app.request("/api/auth/config")).json();
    const setup = await app.request("/api/auth/setup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: CODE, email: "eve@example.invalid", password: PASSWORD }) });
    const login = await app.request("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "owner@this-machine.invalid", password: PASSWORD }) });

    // then
    expect(again.id).toBe(first.id);
    expect(await store.countOwners(TENANT)).toBe(1);
    expect([previewed.status, previewed.headers.getSetCookie().length, opened.status]).toEqual([200, 0, 200]);
    expect(await opened.text()).toContain(`name="token" value="${token}"`);
    expect([signedIn.status, signedIn.headers.get("location"), signedIn.headers.get("cache-control"), signedIn.headers.get("referrer-policy")]).toEqual([303, "/", "no-store", "no-referrer"]);
    expect(reopened.status).toBe(410);
    expect((await (await app.request("/api/me", { headers: { cookie } })).json()).user).toMatchObject({ id: first.id, role: "owner" });
    expect(reused.status).toBe(410);
    expect(await reused.text()).toContain("run <code>handbook-orchestrator</code> again");
    expect(config.setupNeeded).toBe(false);
    expect([setup.status, login.status]).toEqual([403, 403]);
  });

  it("given one address opened twice at once, an expired one and one never minted, when each is exchanged, then only one of the first pair gets a session", async () => {
    // given
    const store = openSqliteStore(":memory:");
    await localOwner(store, TENANT, { email: "owner@this-machine.invalid" });
    const token = await mintLocalLink(store, TENANT);
    const old = await mintLocalLink(store, TENANT, new Date(Date.now() - (LOCAL_LINK_MINUTES + 1) * 60_000));

    // when
    const both = await Promise.all([exchangeLocalLink(store, TENANT, token), exchangeLocalLink(store, TENANT, token)]);
    const expired = await exchangeLocalLink(store, TENANT, old);
    const unknown = await exchangeLocalLink(store, TENANT, "made-up");

    // then
    expect(both.filter(Boolean)).toHaveLength(1);
    expect([expired, unknown]).toEqual([null, null]);
  });

  it("given the browser a local start opened signing in from the page, when another browser opens the same page, then it signs in too, and an address once used or taken back opens nothing", async () => {
    // given
    vi.stubEnv("ORCHESTRATOR_MODE", "local");
    const store = openSqliteStore(":memory:");
    await localOwner(store, TENANT, { email: "owner@this-machine.invalid" });
    let page = await mintLocalLink(store, TENANT);
    const app = createApp({ store, dataDir: "unused", tenant: TENANT, allowedHosts: null, localSignedIn: async () => void (page = await mintLocalLink(store, TENANT)) });
    const first = page;

    // when
    const byDefault = await signInLocally(app, first);
    const second = page;
    const byAnother = await signInLocally(app, second);
    const spent = await signInLocally(app, first);
    const taken = page;
    await dropLocalLink(store, TENANT, taken);
    const takenBack = await signInLocally(app, taken);

    // then
    expect(second).not.toBe(first);
    expect([byDefault.status, byAnother.status, spent.status, takenBack.status]).toEqual([303, 303, 410, 410]);
    expect(await spent.text()).toContain("in this browser");
  });

  it("given a self-hosted orchestrator, when the local address is opened, then it is no way in there", async () => {
    // given
    vi.stubEnv("ORCHESTRATOR_MODE", "self-hosted");
    const { store } = await withOwner();
    const token = await mintLocalLink(store, TENANT);

    // when
    const app = createApp({ store, dataDir: "unused", tenant: TENANT, allowedHosts: null });
    const res = await app.request(`/api/auth/local?token=${token}`);
    const pressed = await signInLocally(app, token);

    // then
    expect([res.status, pressed.status]).toEqual([404, 404]);
    expect(res.headers.getSetCookie()).toEqual([]);
  });
});

describe("a session renewed while it is used", () => {
  const HOUR = 3_600_000;
  const at = (ms: number) => new Date(ms).toISOString();

  it("given sessions at different points of their life, when each is used, then only one past half its idle time renews, by a full idle time and never past its most", () => {
    // given
    const life = sessionLife(false);
    const now = Date.parse("2026-11-03T12:00:00.000Z");

    // when
    const plenty = renewedExpiry({ expiresAt: at(now + 7 * HOUR), startedAt: at(now - 5 * HOUR) }, at(now), life);
    const half = renewedExpiry({ expiresAt: at(now + 5 * HOUR), startedAt: at(now - 7 * HOUR) }, at(now), life);
    const nearMost = renewedExpiry({ expiresAt: at(now + 2 * HOUR), startedAt: at(now - (SESSION_MAX_DAYS * 24 - 4) * HOUR) }, at(now), life);
    const atMost = renewedExpiry({ expiresAt: at(now + 2 * HOUR), startedAt: at(now - (SESSION_MAX_DAYS * 24 - 2) * HOUR) }, at(now), life);
    const older = renewedExpiry({ expiresAt: at(now + 2 * HOUR), startedAt: null }, at(now), life);

    // then
    expect(plenty).toBeUndefined();
    expect(half).toBe(at(now + 12 * HOUR));
    expect(nearMost).toBe(at(now + 4 * HOUR));
    expect([atMost, older]).toEqual([undefined, undefined]);
  });

  it("given a signed-in person whose session has three hours left, when they use the orchestrator, then it lasts twelve hours from now, and once ended it is not brought back", async () => {
    // given
    const { store, ownerId } = await withOwner();
    const app = createApp({ store, dataDir: "unused", tenant: TENANT, allowedHosts: null });
    const now = Date.now();
    const token = "renewal-token-for-tests";
    await store.saveSession({ tokenHash: hashToken(token), tenant: TENANT, userId: ownerId, csrf: "c", expiresAt: new Date(now + 3 * HOUR).toISOString(), createdAt: new Date(now - 9 * HOUR).toISOString() });
    const cookie = `${SESSION_COOKIE}=${token}`;

    // when
    const used = await app.request("/api/me", { headers: { cookie } });
    const renewed = await store.getSession(hashToken(token));
    await store.deleteSession(hashToken(token));
    const ended = await app.request("/api/me", { headers: { cookie } });

    // then
    expect(used.status).toBe(200);
    expect(Date.parse(renewed!.expiresAt) - now).toBeGreaterThan(11.9 * HOUR);
    expect(ended.status).toBe(401);
    expect(await store.getSession(hashToken(token))).toBeNull();
  });

  it("given a local orchestrator, when its one person signs in from the printed address, then their session lasts a month unused and the cookie a quarter", async () => {
    // given
    vi.stubEnv("ORCHESTRATOR_MODE", "local");
    const store = openSqliteStore(":memory:");
    await localOwner(store, TENANT, { email: "owner@this-machine.invalid" });
    const app = createApp({ store, dataDir: "unused", tenant: TENANT, allowedHosts: null });
    const now = Date.now();

    // when
    const opened = await signInLocally(app, await mintLocalLink(store, TENANT));
    const cookie = opened.headers.getSetCookie()[0]!;
    const session = await store.getSession(hashToken(cookie.split(";")[0]!.split("=")[1]!));
    vi.unstubAllEnvs();

    // then
    expect(Math.round((Date.parse(session!.expiresAt) - now) / 86_400_000)).toBe(LOCAL_SESSION_DAYS);
    expect(Math.round((Date.parse(/Expires=([^;]+)/.exec(cookie)![1]!) - now) / 86_400_000)).toBe(LOCAL_SESSION_MAX_DAYS);
  });
});
