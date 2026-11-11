import { describe, expect, it } from "vitest";
import { createUser, principalOf, setupFirstOwner, signInWithOidc, signInWithPassword, startSession } from "./accounts.js";
import { createApp } from "./app.js";
import { CSRF_HEADER, hashToken, sessionCookie } from "./auth.js";
import type { Principal } from "./auth.js";
import { acceptInvite, invite, INVITE_DAYS, readInvite, resendInvite, revokeInvite, splitAddresses } from "./invites.js";
import { openSqliteStore } from "./store.js";
import type { Store } from "./store.js";

const TENANT = "acme";
const CODE = "setup-code-for-tests";
const PASSWORD = "correct horse battery";
const TEAMS = new Set(["Payments", "Platform"]);
const IDP = "https://idp.example.invalid";
const NOW = new Date("2026-10-25T10:00:00.000Z");

async function organization(): Promise<{ store: Store; owner: Principal; admin: Principal }> {
  const store = openSqliteStore(":memory:");
  const first = await setupFirstOwner(store, TENANT, CODE, { code: CODE, email: "ada@example.invalid", name: "Ada", password: PASSWORD });
  const owner = await principalOf(store, first);
  const admin = await principalOf(store, await createUser(store, TENANT, TEAMS, { email: "grace@example.invalid", role: "admin", password: PASSWORD }, owner));
  return { store, owner, admin };
}

describe("inviting people", () => {
  it("given a pasted list with spaces, commas, a repeat and an address that is already a member, when an admin invites them, then each new address gets one week-long invitation and the member is skipped", async () => {
    // given
    const { store, admin } = await organization();

    // when
    const result = await invite(store, TENANT, TEAMS, { emails: " kim@example.invalid,lee@example.invalid\nKIM@example.invalid  ada@example.invalid", role: "member", teams: ["Payments"] }, admin, NOW);

    // then
    expect(result.invited.map((i) => i.invite.email)).toEqual(["kim@example.invalid", "lee@example.invalid"]);
    expect(result.skipped).toEqual([{ email: "ada@example.invalid", reason: "already a member" }]);
    const stored = await store.listInvites(TENANT);
    expect(stored.map((i) => [i.email, i.role, i.teams, i.invitedBy])).toEqual([
      ["kim@example.invalid", "member", ["Payments"], "grace@example.invalid"],
      ["lee@example.invalid", "member", ["Payments"], "grace@example.invalid"],
    ]);
    expect(stored.every((i) => i.expiresAt === new Date(NOW.getTime() + INVITE_DAYS * 86_400_000).toISOString())).toBe(true);
    expect(stored.map((i) => i.tokenHash)).toEqual(result.invited.map((i) => hashToken(i.token)));
    expect(JSON.stringify(stored)).not.toContain(result.invited[0]!.token);
  });

  it("given an admin, when they invite an owner, resend or revoke an owner's invitation, or invite the same address again, then each is refused and the owner's invitation stays", async () => {
    // given
    const { store, owner, admin } = await organization();
    const { invited } = await invite(store, TENANT, TEAMS, { emails: "boss@example.invalid", role: "owner" }, owner, NOW);
    const id = invited[0]!.invite.id;

    // when
    const attempts = await Promise.allSettled([
      invite(store, TENANT, TEAMS, { emails: "kim@example.invalid", role: "owner" }, admin, NOW),
      resendInvite(store, TENANT, id, admin, NOW),
      revokeInvite(store, TENANT, id, admin),
    ]);
    const reinvited = await invite(store, TENANT, TEAMS, { emails: "boss@example.invalid", role: "member" }, admin, NOW);

    // then
    expect(attempts.map((a) => a.status)).toEqual(["rejected", "rejected", "rejected"]);
    expect(reinvited).toEqual({ invited: [], skipped: [{ email: "boss@example.invalid", reason: "invited as owner; only an owner changes that invitation" }] });
    expect((await store.listInvites(TENANT)).map((i) => [i.email, i.role, i.id])).toEqual([["boss@example.invalid", "owner", id]]);
  });

  it("given an empty list, more addresses than one form takes, or an address that is not one, when invited, then each is refused and nothing is saved", async () => {
    // given
    const { store, owner } = await organization();
    const many = Array.from({ length: 51 }, (_, i) => `p${i}@example.invalid`).join(" ");

    // when
    const attempts = await Promise.allSettled(
      [" ", many, "kim@example.invalid not-an-address"].map((emails) => invite(store, TENANT, TEAMS, { emails, role: "member" }, owner, NOW)),
    );

    // then
    expect(attempts.map((a) => a.status)).toEqual(["rejected", "rejected", "rejected"]);
    expect(await store.listInvites(TENANT)).toEqual([]);
  });

  it("given addresses separated every way people paste them, when they are split, then each appears once in lower case", () => {
    expect(splitAddresses("A@x.invalid;b@x.invalid, a@X.invalid\n\tc@x.invalid")).toEqual(["a@x.invalid", "b@x.invalid", "c@x.invalid"]);
  });
});

describe("accepting an invitation by link", () => {
  it("given an invitation to an admin role with a team, when the link is opened and accepted, then the account has that role and team, signs in with the password chosen, and the link is used up", async () => {
    // given
    const { store, owner } = await organization();
    const { invited } = await invite(store, TENANT, TEAMS, { emails: "kim@example.invalid", role: "admin", teams: ["Platform"] }, owner, NOW);
    const token = invited[0]!.token;
    const later = new Date(NOW.getTime() + 86_400_000);

    // when
    const shown = await readInvite(store, TENANT, token, later);
    const user = await acceptInvite(store, TENANT, token, { name: "Kim", password: PASSWORD }, later);

    // then
    expect(shown).toMatchObject({ email: "kim@example.invalid", role: "admin", teams: ["Platform"], invitedBy: owner.name });
    expect(await principalOf(store, user)).toMatchObject({ name: "Kim", role: "admin", ownedTeams: ["Platform"] });
    await expect(signInWithPassword(store, TENANT, "kim@example.invalid", PASSWORD)).resolves.toMatchObject({ id: user.id });
    await expect(acceptInvite(store, TENANT, token, { password: PASSWORD }, later)).rejects.toMatchObject({ status: 404 });
    expect(await store.listInvites(TENANT)).toEqual([]);
  });

  it("given a link past its seven days, a revoked one, and the old link of a resent one, when each is accepted, then each is refused and no account appears", async () => {
    // given
    const { store, owner } = await organization();
    const { invited } = await invite(store, TENANT, TEAMS, { emails: "old@example.invalid rev@example.invalid re@example.invalid", role: "member" }, owner, NOW);
    const [old, revoked, resent] = invited;
    await revokeInvite(store, TENANT, revoked!.invite.id, owner);
    const renewed = await resendInvite(store, TENANT, resent!.invite.id, owner, NOW);
    const eightDays = new Date(NOW.getTime() + 8 * 86_400_000);

    // when
    const attempts = await Promise.allSettled([
      acceptInvite(store, TENANT, old!.token, { password: PASSWORD }, eightDays),
      acceptInvite(store, TENANT, revoked!.token, { password: PASSWORD }, NOW),
      acceptInvite(store, TENANT, resent!.token, { password: PASSWORD }, NOW),
    ]);

    // then
    expect(attempts.map((a) => a.status)).toEqual(["rejected", "rejected", "rejected"]);
    expect(await store.countUsers(TENANT)).toBe(2);
    await expect(acceptInvite(store, TENANT, renewed.token, { password: PASSWORD }, NOW)).resolves.toMatchObject({ email: "re@example.invalid" });
  });

  it("given one link accepted twice at the same moment, when both run, then exactly one account is made", async () => {
    // given
    const { store, owner } = await organization();
    const { invited } = await invite(store, TENANT, TEAMS, { emails: "kim@example.invalid", role: "member" }, owner, NOW);

    // when
    const results = await Promise.allSettled([1, 2].map(() => acceptInvite(store, TENANT, invited[0]!.token, { password: PASSWORD }, NOW)));

    // then
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await store.countUsers(TENANT)).toBe(3);
  });

  it("given another organization's link on a shared database, when it is read or accepted here, then it is refused and stays usable there", async () => {
    // given
    const { store, owner } = await organization();
    const { invited } = await invite(store, "globex", TEAMS, { emails: "kim@example.invalid", role: "member" }, owner, NOW);

    // when
    const read = readInvite(store, TENANT, invited[0]!.token, NOW);
    const accepted = acceptInvite(store, TENANT, invited[0]!.token, { password: PASSWORD }, NOW);

    // then
    await expect(read).rejects.toMatchObject({ status: 404 });
    await expect(accepted).rejects.toMatchObject({ status: 404 });
    expect(await store.listInvites("globex")).toHaveLength(1);
  });
});

describe("accepting an invitation through single sign-on", () => {
  it("given a pending invitation, when the provider signs in that verified address, then the person joins with the invited role and teams and the invitation is used up", async () => {
    // given
    const { store, owner } = await organization();
    await invite(store, TENANT, TEAMS, { emails: "kim@example.invalid", role: "admin", teams: ["Payments"] }, owner);

    // when
    const user = await signInWithOidc(store, TENANT, { issuer: IDP, subject: "u-1", email: "Kim@example.invalid", name: "Kim" });

    // then
    expect(await principalOf(store, user)).toMatchObject({ role: "admin", ownedTeams: ["Payments"], email: "kim@example.invalid" });
    expect(user).toMatchObject({ oidcIssuer: IDP, oidcSubject: "u-1" });
    expect(await store.listInvites(TENANT)).toEqual([]);
  });

  it("given an invitation that expired and one that was revoked, when the provider signs in each address, then each joins as a plain member", async () => {
    // given
    const { store, owner } = await organization();
    const longAgo = new Date(Date.now() - 8 * 86_400_000);
    await invite(store, TENANT, TEAMS, { emails: "old@example.invalid", role: "admin", teams: ["Payments"] }, owner, longAgo);
    const { invited } = await invite(store, TENANT, TEAMS, { emails: "rev@example.invalid", role: "admin", teams: ["Payments"] }, owner);
    await revokeInvite(store, TENANT, invited[0]!.invite.id, owner);

    // when
    const old = await signInWithOidc(store, TENANT, { issuer: IDP, subject: "u-1", email: "old@example.invalid" });
    const rev = await signInWithOidc(store, TENANT, { issuer: IDP, subject: "u-2", email: "rev@example.invalid" });

    // then
    expect(await principalOf(store, old)).toMatchObject({ role: "member", ownedTeams: [] });
    expect(await principalOf(store, rev)).toMatchObject({ role: "member", ownedTeams: [] });
  });
});

describe("the join and invitation routes", () => {
  async function routed() {
    const { store, owner, admin } = await organization();
    const app = createApp({ store, dataDir: "unused", tenant: TENANT, allowedHosts: null, publicUrl: "https://orchestrator.example.invalid" });
    const session = await startSession(store, TENANT, admin.id);
    const headers = { cookie: `${sessionCookie(TENANT, true)}=${session.token}`, [CSRF_HEADER]: session.csrf, "content-type": "application/json" };
    return { store, owner, app, headers };
  }

  it("given an admin, when they invite through the API, then the answer carries each link once, the list carries none, and the link opens the join page for the address", async () => {
    // given
    const { app, headers } = await routed();

    // when
    const created = await app.request("/api/invites", { method: "POST", headers, body: JSON.stringify({ emails: "kim@example.invalid", role: "member" }) });
    const listed = await app.request("/api/invites", { headers });

    // then
    const { invited } = await created.json();
    expect(invited[0].link).toMatch(/^https:\/\/orchestrator\.example\.invalid\/#\/join\/[\w-]{43}$/);
    const list = await listed.json();
    expect(JSON.stringify(list)).not.toContain(invited[0].link.split("/join/")[1]);
    expect(list.invites[0]).toMatchObject({ email: "kim@example.invalid", role: "member", expired: false });
    const token = invited[0].link.split("/join/")[1];
    const page = await app.request("/api/join/read", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) });
    expect(await page.json()).toMatchObject({ invite: { email: "kim@example.invalid", role: "member" }, sso: false });
    const inPath = await app.request(`/api/join/${token}`);
    expect(inPath.status).not.toBe(200);
  });

  it("given a join link, when it is accepted from another site's form and then from the orchestrator's page, then the first is refused and the second signs the new member in", async () => {
    // given
    const { store, owner, app } = await routed();
    const { invited } = await invite(store, TENANT, TEAMS, { emails: "kim@example.invalid", role: "member" }, owner);
    const path = "/api/join";
    const body = JSON.stringify({ token: invited[0]!.token, name: "Kim", password: PASSWORD });

    // when
    const forged = await app.request(path, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", origin: "https://evil.example.invalid" }, body });
    const accepted = await app.request(path, { method: "POST", headers: { "content-type": "application/json", origin: "https://orchestrator.example.invalid" }, body });

    // then
    expect(forged.status).toBe(403);
    expect(accepted.status).toBe(200);
    const cookie = accepted.headers.get("set-cookie")!.split(";")[0]!;
    const me = await app.request("/api/me", { headers: { cookie } });
    expect((await me.json()).user).toMatchObject({ email: "kim@example.invalid", role: "member" });
  });

  it("given a member, when they list or send invitations, then both are refused", async () => {
    // given
    const { store, owner, app } = await routed();
    const member = await createUser(store, TENANT, TEAMS, { email: "max@example.invalid", role: "member", password: PASSWORD }, owner);
    const session = await startSession(store, TENANT, member.id);
    const headers = { cookie: `${sessionCookie(TENANT, true)}=${session.token}`, [CSRF_HEADER]: session.csrf, "content-type": "application/json" };

    // when
    const listed = await app.request("/api/invites", { headers });
    const sent = await app.request("/api/invites", { method: "POST", headers, body: JSON.stringify({ emails: "kim@example.invalid", role: "member" }) });

    // then
    expect([listed.status, sent.status]).toEqual([403, 403]);
    expect(await store.listInvites(TENANT)).toEqual([]);
  });
});

describe("a member's page", () => {
  it("given a member who opened a request, when they open their own page and another member's, then their own shows the request and the other is refused, while an admin opens either", async () => {
    // given
    const { store, owner } = await organization();
    const max = await createUser(store, TENANT, TEAMS, { email: "max@example.invalid", role: "member", teams: ["Payments"], password: PASSWORD }, owner);
    await store.saveRequest({ tenant: TENANT, repoId: "payments-skills", number: 1, provider: "local", url: "local://requests/payments-skills/1", branch: "handbook/a", headSha: "a".repeat(40), title: "Add a skill", status: "open", createdAt: NOW.toISOString(), createdBy: "max@example.invalid" });
    const app = createApp({ store, dataDir: "unused", tenant: TENANT, allowedHosts: null });
    const as = async (id: string) => ({ cookie: `${sessionCookie(TENANT)}=${(await startSession(store, TENANT, id)).token}` });

    // when
    const own = await app.request(`/api/members/${max.id}`, { headers: await as(max.id) });
    const other = await app.request(`/api/members/${owner.id}`, { headers: await as(max.id) });
    const byOwner = await app.request(`/api/members/${max.id}`, { headers: await as(owner.id) });

    // then
    expect(own.status).toBe(200);
    expect(await own.json()).toMatchObject({ member: { email: "max@example.invalid", ownedTeams: ["Payments"] }, requests: [{ title: "Add a skill" }], totals: { requests: 1, tasks: 0 } });
    expect(other.status).toBe(403);
    expect(byOwner.status).toBe(200);
  });
});
