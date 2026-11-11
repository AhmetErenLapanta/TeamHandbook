import { describe, expect, it } from "vitest";
import { createUser, principalOf, setupFirstOwner, signInWithOidc, signInWithPassword, startSession } from "./accounts.js";
import { createApp } from "./app.js";
import { CSRF_HEADER, hashToken, sessionCookie } from "./auth.js";
import type { Principal } from "./auth.js";
import { addDomain, RECORD_VALUE, recordName, removeDomain, verifyDomain } from "./domains.js";
import { createKey } from "./keys.js";
import type { TxtResolver } from "./domains.js";
import { acceptInvite, invite, readInvite } from "./invites.js";
import type { OidcClient } from "./oidc.js";
import { openSqliteStore } from "./store.js";
import type { Store } from "./store.js";

/** Holds a refusal until the test reads it: a rejection not yet awaited while the test awaits something else is reported as unhandled. */
function later<T>(promise: Promise<T>): Promise<T> {
  promise.catch(() => undefined);
  return promise;
}

const TENANT = "acme";
const CODE = "setup-code-for-tests";
const PASSWORD = "correct horse battery";
const TEAMS = new Set(["Payments"]);
const IDP = "https://idp.example.invalid";

/** DNS as a table: each name answers the records it holds, and any other name has none. */
function dns(records: Record<string, string[]>): TxtResolver {
  return async (name) => {
    if (!records[name]) throw Object.assign(new Error(`queryTxt ENOTFOUND ${name}`), { code: "ENOTFOUND" });
    return records[name]!.map((r) => [r]);
  };
}

async function organization(): Promise<{ store: Store; owner: Principal; admin: Principal }> {
  const store = openSqliteStore(":memory:");
  const owner = await principalOf(store, await setupFirstOwner(store, TENANT, CODE, { code: CODE, email: "ada@acme.example", name: "Ada", password: PASSWORD }));
  const admin = await principalOf(store, await createUser(store, TENANT, TEAMS, { email: "grace@acme.example", role: "admin", password: PASSWORD }, owner));
  await createUser(store, TENANT, TEAMS, { email: "max@acme.example", role: "member", password: PASSWORD }, owner);
  await createUser(store, TENANT, TEAMS, { email: "pat@partner.example", role: "member", password: PASSWORD }, owner);
  return { store, owner, admin };
}

async function verified(store: Store, owner: Principal, domain = "acme.example") {
  const added = await addDomain(store, TENANT, owner, domain, true);
  return verifyDomain(store, TENANT, owner, domain, dns({ [recordName(domain)]: ["v=spf1 -all", `${RECORD_VALUE}${added.token}`] }));
}

describe("verifying a domain", () => {
  it("given a domain with its TXT record published, when an owner verifies it, then it is verified, and a record with another value or none at all is not", async () => {
    // given
    const { store, owner } = await organization();
    const added = await addDomain(store, TENANT, owner, " ACME.example. ", true);
    await addDomain(store, TENANT, owner, "other.example", true);
    await addDomain(store, TENANT, owner, "nowhere.example", true);

    // when
    const ok = await verifyDomain(store, TENANT, owner, "acme.example", dns({ [recordName("acme.example")]: [`${RECORD_VALUE}${added.token}`] }));
    const wrong = later(verifyDomain(store, TENANT, owner, "other.example", dns({ [recordName("other.example")]: [`${RECORD_VALUE}${added.token}`] })));
    const none = later(verifyDomain(store, TENANT, owner, "nowhere.example", dns({})));

    // then
    expect(ok).toMatchObject({ domain: "acme.example", verifiedAt: expect.any(String) });
    await expect(wrong).rejects.toMatchObject({ status: 409 });
    await expect(none).rejects.toMatchObject({ status: 409 });
    expect((await store.listDomains(TENANT)).map((d) => [d.domain, Boolean(d.verifiedAt)])).toEqual([
      ["acme.example", true],
      ["nowhere.example", false],
      ["other.example", false],
    ]);
  });

  it("given an admin, a key, an orchestrator without single sign-on, and a name that is not a domain, when each adds a domain, then each is refused and nothing is kept", async () => {
    // given
    const { store, owner, admin } = await organization();

    // when
    const attempts = await Promise.allSettled([
      addDomain(store, TENANT, admin, "acme.example", true),
      addDomain(store, TENANT, { ...owner, key: { id: "k", owner: { kind: "user", id: owner.id }, scopes: {} as never, expiresAt: null } }, "acme.example", true),
      addDomain(store, TENANT, owner, "acme.example", false),
      addDomain(store, TENANT, owner, "*.acme.example", true),
    ]);

    // then
    expect(attempts.map((a) => (a.status === "rejected" ? (a.reason as { status: number }).status : 200))).toEqual([403, 403, 409, 400]);
    expect(await store.listDomains(TENANT)).toEqual([]);
  });
});

describe("single sign-on required at a verified domain", () => {
  it("given a verified domain, when a member and an admin there sign in with their passwords, then both are told to use SSO, while the owner there and a member elsewhere still sign in", async () => {
    // given
    const { store, owner } = await organization();
    await verified(store, owner);

    // when
    const tries = await Promise.allSettled(
      ["max@acme.example", "grace@acme.example", "ada@acme.example", "pat@partner.example"].map((e) => signInWithPassword(store, TENANT, e, PASSWORD, () => true, true)),
    );

    // then
    expect(tries.map((t) => (t.status === "rejected" ? (t.reason as Error).message : "in"))).toEqual(["addresses at acme.example sign in with SSO", "addresses at acme.example sign in with SSO", "in", "in"]);
  });

  it("given a verified domain, when a member there signs in with a wrong password and an address with no account tries, then both get the SSO answer, so neither says whether the password or the account exists", async () => {
    // given
    const { store, owner } = await organization();
    await verified(store, owner);

    // when
    const wrong = later(signInWithPassword(store, TENANT, "max@acme.example", "not the password", () => true, true));
    const nobody = later(signInWithPassword(store, TENANT, "nobody@acme.example", PASSWORD, () => true, true));

    // then
    await expect(wrong).rejects.toThrow("addresses at acme.example sign in with SSO");
    await expect(nobody).rejects.toThrow("addresses at acme.example sign in with SSO");
  });

  it("given a verified domain on an orchestrator whose single sign-on is not set up, when a member there signs in with a password, then it works, so a provider taken away locks nobody out", async () => {
    // given
    const { store, owner } = await organization();
    await verified(store, owner);

    // when
    const user = await signInWithPassword(store, TENANT, "max@acme.example", PASSWORD, () => true, false);

    // then
    expect(user.email).toBe("max@acme.example");
  });

  it("given members at a domain signed in, when it is verified, then their sessions end and the owner's stays, and removing the domain lets passwords in again", async () => {
    // given
    const { store, owner } = await organization();
    const max = (await store.getUserByEmail(TENANT, "max@acme.example"))!;
    const memberSession = await startSession(store, TENANT, max.id);
    const ownerSession = await startSession(store, TENANT, owner.id);

    // when
    await verified(store, owner);

    // then
    expect(await store.getSession(hashToken(memberSession.token))).toBeNull();
    expect(await store.getSession(hashToken(ownerSession.token))).not.toBeNull();

    // when removed
    await removeDomain(store, TENANT, owner, "acme.example");

    // then
    await expect(signInWithPassword(store, TENANT, "max@acme.example", PASSWORD, () => true, true)).resolves.toMatchObject({ id: max.id });
  });

  it("given an invitation to an address at a verified domain, when it is read and accepted with a password, then the page is told SSO is required and the password is refused, while the invitation still works through SSO", async () => {
    // given
    const { store, owner } = await organization();
    await verified(store, owner);
    const { invited } = await invite(store, TENANT, TEAMS, { emails: "kim@acme.example", role: "admin" }, owner);
    const token = invited[0]!.token;

    // when
    const shown = await readInvite(store, TENANT, token, new Date(), true);
    const byPassword = later(acceptInvite(store, TENANT, token, { password: PASSWORD }, new Date(), true));

    // then
    expect(shown.ssoRequired).toBe(true);
    await expect(byPassword).rejects.toThrow("addresses at acme.example sign in with SSO");
    await expect(signInWithOidc(store, TENANT, { issuer: IDP, subject: "u-kim", email: "kim@acme.example" })).resolves.toMatchObject({ role: "admin" });
  });
});

describe("joining through the identity provider", () => {
  it("given a verified domain, when the provider vouches for a new address there and one elsewhere, then the first joins as a member and the second is refused", async () => {
    // given
    const { store, owner } = await organization();
    await verified(store, owner);

    // when
    const inside = await signInWithOidc(store, TENANT, { issuer: IDP, subject: "u-1", email: "new@acme.example" });
    const outside = later(signInWithOidc(store, TENANT, { issuer: IDP, subject: "u-2", email: "stranger@elsewhere.example" }));

    // then
    expect(inside).toMatchObject({ role: "member", email: "new@acme.example" });
    await expect(outside).rejects.toMatchObject({ status: 403 });
  });

  it("given no verified domain, when the provider vouches for a new address anywhere, then it joins as a member as before", async () => {
    // given
    const { store } = await organization();

    // when
    const user = await signInWithOidc(store, TENANT, { issuer: IDP, subject: "u-1", email: "stranger@elsewhere.example" });

    // then
    expect(user.role).toBe("member");
  });
});

describe("the domain routes", () => {
  it("given an owner on an orchestrator with single sign-on, when a domain is added, verified and listed over the API, then the TXT record to publish is shown and the domain reads verified", async () => {
    // given
    const store = openSqliteStore(":memory:");
    const owner = await setupFirstOwner(store, TENANT, CODE, { code: CODE, email: "ada@acme.example", password: PASSWORD });
    const published: Record<string, string[]> = {};
    const oidc = { issuer: IDP, groupsClaim: "groups" } as unknown as OidcClient;
    const app = createApp({ store, dataDir: "unused", tenant: TENANT, allowedHosts: null, oidc, resolveTxt: dns(published) });
    const session = await startSession(store, TENANT, owner.id);
    const headers = { cookie: `${sessionCookie(TENANT)}=${session.token}`, [CSRF_HEADER]: session.csrf, "content-type": "application/json" };

    // when
    const added = await (await app.request("/api/sso/domains", { method: "POST", headers, body: JSON.stringify({ domain: "acme.example" }) })).json();
    published[added.domain.record.name] = [added.domain.record.value];
    const checked = await app.request("/api/sso/domains/acme.example/verify", { method: "POST", headers });
    const listed = await (await app.request("/api/sso/domains", { headers })).json();

    // then
    expect(added.domain.record.name).toBe("_teamhandbook-orchestrator.acme.example");
    expect(added.domain.record.value).toMatch(/^teamhandbook-orchestrator-verification=[0-9a-f]{32}$/);
    expect(checked.status).toBe(200);
    expect(listed).toMatchObject({ sso: true, domains: [{ domain: "acme.example", verified: true }] });
  });
});

describe("keys and subdomains at a verified domain", () => {
  it("given a member's and the owner's API keys made before the domain was verified, when the domain is verified, then the member's key is refused and the owner's still answers", async () => {
    // given
    const { store, owner } = await organization();
    const max = await principalOf(store, (await store.getUserByEmail(TENANT, "max@acme.example"))!);
    const memberKey = await createKey(store, TENANT, max, { name: "ci", scopes: { usage: "read" } });
    const ownerKey = await createKey(store, TENANT, owner, { name: "ci", scopes: { usage: "read" } });
    const app = createApp({ store, dataDir: "unused", tenant: TENANT, allowedHosts: null });
    const call = (secret: string) => app.request("/api/usage", { headers: { authorization: `Bearer ${secret}` } });
    const before = await call(memberKey.secret);

    // when
    await verified(store, owner);

    // then
    expect(before.status).toBe(200);
    expect((await call(memberKey.secret)).status).toBe(401);
    expect((await call(ownerKey.secret)).status).toBe(200);
  });

  it("given a verified domain, when a member there makes a personal key, then it is refused and points at service accounts", async () => {
    // given
    const { store, owner } = await organization();
    await verified(store, owner);
    const max = await principalOf(store, (await store.getUserByEmail(TENANT, "max@acme.example"))!);

    // when
    const attempt = createKey(store, TENANT, max, { name: "ci", scopes: { usage: "read" } });

    // then
    await expect(attempt).rejects.toThrow(/service account/);
  });

  it("given a verified domain, when a member at a subdomain signs in with a password and the provider vouches for a new address under it, then the first is sent to SSO and the second joins, while a look-alike domain is neither", async () => {
    // given
    const { store, owner } = await organization();
    await createUser(store, TENANT, TEAMS, { email: "sub@eu.acme.example", role: "member", password: PASSWORD }, owner);
    await createUser(store, TENANT, TEAMS, { email: "fake@notacme.example", role: "member", password: PASSWORD }, owner);
    await verified(store, owner);

    // when
    const sub = later(signInWithPassword(store, TENANT, "sub@eu.acme.example", PASSWORD, () => true, true));
    const lookAlike = await signInWithPassword(store, TENANT, "fake@notacme.example", PASSWORD, () => true, true);
    const joined = await signInWithOidc(store, TENANT, { issuer: IDP, subject: "u-eu", email: "new@eu.acme.example" });
    const outside = later(signInWithOidc(store, TENANT, { issuer: IDP, subject: "u-x", email: "new@notacme.example" }));

    // then
    await expect(sub).rejects.toThrow("addresses at eu.acme.example sign in with SSO");
    expect(lookAlike.email).toBe("fake@notacme.example");
    expect(joined.role).toBe("member");
    await expect(outside).rejects.toMatchObject({ status: 403 });
  });
});
