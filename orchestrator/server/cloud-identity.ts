import { Hono } from "hono";
import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { agentOf, clientFrom, principalOf, renewedExpiry, sessionLife } from "./accounts.js";
import type { UserRecord } from "./accounts.js";
import { csrfRefusal, hashToken, newToken, seen } from "./auth.js";
import { newId } from "./ids.js";
import { clearRemoved, directoryJoinOf, tenantsJoinableBy, wasRemoved } from "./directory-join.js";
import type { IdentityEventKind, IdentityEventStore } from "./identity-funnel.js";
import type { IdentityRecord, IdentitySessionRecord, IdentityStore, PendingSignIn, SocialProvider } from "./identities.js";
import { tooMany, windowLimiter } from "./limits.js";
import { suspended } from "./scim.js";
import { PROVIDER_LABEL, ProviderRefused, SOCIAL_PROVIDERS } from "./social.js";
import type { ProviderAccount, ProviderProblem, SocialClient } from "./social.js";
import type { LegalLinks } from "./legal.js";
import { orgName } from "./organization.js";
import { recordEvent } from "./events.js";
import type { OrgRegistry } from "./orgs.js";
import { orgQuota } from "./quotas.js";
import type { Store } from "./store.js";

/**
 * A cloud orchestrator's sign-in: one session per person, for every organization they belong to.
 * The session says who signed in, with which provider and when; whether it reaches an
 * organization is decided again on every request, from that organization's own account row,
 * so a membership removed, turned off by the directory or told to sign in again stops at the
 * next call. A self-hosted orchestrator issues none of this. It lasts as long as an organization's
 * own session, renewed the same way while it is used (sessionLife, renewedExpiry).
 */

/** Which providers an organization takes, as a JSON list; none set takes every provider the orchestrator offers. */
export const SIGN_IN_METHODS = "signin.methods";

export function identityCookie(secure: boolean): string {
  return `${secure ? "__Host-" : ""}th_identity`;
}

/** The state of a sign-in on its way, held by the browser that started it, so no other browser finishes it. */
function stateCookie(secure: boolean): { name: string; path: string } {
  return { name: `${secure ? "__Host-" : ""}th_sign_in_state`, path: secure ? "/" : "/api/auth" };
}

export async function startIdentitySession(store: IdentityStore, c: Context, secure: boolean, identityId: string, account: Pick<ProviderAccount, "provider" | "domain">): Promise<IdentitySessionRecord> {
  const token = newToken();
  const now = new Date();
  const session: IdentitySessionRecord = {
    tokenHash: hashToken(token),
    identityId,
    csrf: newToken(),
    method: account.provider,
    domain: account.domain,
    authenticatedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + sessionLife(false).idleMs).toISOString(),
    userAgent: agentOf(c.req.header("user-agent")),
  };
  await store.saveIdentitySession(session);
  // The cookie lasts to the session's most; the session itself is renewed while it is used, and ends earlier unused.
  setCookie(c, identityCookie(secure), token, { httpOnly: true, sameSite: "Lax", secure, path: "/", expires: new Date(now.getTime() + sessionLife(false).maxMs) });
  return session;
}

/** This browser's identity session, unexpired, or null. */
export async function identitySessionOf(c: Context, store: IdentityStore, secure: boolean): Promise<IdentitySessionRecord | null> {
  const token = getCookie(c, identityCookie(secure));
  const session = token ? await store.getIdentitySession(hashToken(token)) : null;
  if (!session || session.expiresAt <= new Date().toISOString()) return null;
  await seen(session.tokenHash, (at) => store.touchIdentitySession(session.tokenHash, at, renewedExpiry({ expiresAt: session.expiresAt, startedAt: session.authenticatedAt }, at, sessionLife(false))));
  return session;
}

/** Whether an organization takes sign-ins through this provider. A list that does not read takes none. */
export async function orgTakes(store: Pick<Store, "getSetting">, tenant: string, method: SocialProvider): Promise<boolean> {
  const raw = await store.getSetting(tenant, SIGN_IN_METHODS);
  if (raw === null) return true;
  try {
    const methods: unknown = JSON.parse(raw);
    return Array.isArray(methods) && methods.includes(method);
  } catch {
    return false;
  }
}

/**
 * The organization account an identity session reaches in a tenant, or null: the identity holds
 * one there, the directory has not turned it off, its sessions were not ended after this one
 * signed in, and the organization takes the provider this session signed in with.
 */
export async function cloudMemberOf(store: Pick<Store, "getUserByIdentity" | "getSetting" | "getOrg">, tenant: string, session: IdentitySessionRecord): Promise<UserRecord | null> {
  if ((await store.getOrg(tenant))?.deletedAt) return null;
  const user = await store.getUserByIdentity(tenant, session.identityId);
  if (!user || (await suspended(store, tenant, user.id))) return null;
  if (user.sessionsRevokedAt && user.sessionsRevokedAt >= session.authenticatedAt) return null;
  return (await orgTakes(store, tenant, session.method)) ? user : null;
}

/** One step of a person's signup, kept apart from every organization's log, with only the domain of their address. */
export async function recordStep(store: IdentityEventStore, identity: Pick<IdentityRecord, "id" | "email">, kind: IdentityEventKind, provider: SocialProvider, org: string | null = null): Promise<void> {
  await store.recordIdentityEvent({ id: newId("ide"), identityId: identity.id, at: new Date().toISOString(), kind, provider, emailDomain: identity.email.slice(identity.email.lastIndexOf("@") + 1), org });
}

/**
 * The identity a provider account signs in as: the one it is tied to, or a new one. An address
 * another identity already holds is refused rather than tied to it: an account is tied to an
 * identity only by that identity's own choice, signed in, from Your account.
 */
export async function identityFor(store: IdentityStore & IdentityEventStore, account: ProviderAccount): Promise<IdentityRecord> {
  const known = await store.getIdentityByLogin(account.provider, account.subject);
  if (known) return known;
  const holder = await store.getIdentityByEmail(account.email);
  if (holder) {
    // Only someone the provider just verified the address for learns this, so it names nothing they do not own.
    const ways = [...new Set((await store.listLogins(holder.id)).map((l) => l.provider))];
    throw new SignInRefused("address-taken", `${account.email} signs in with ${ways.map((w) => PROVIDER_LABEL[w]).join(" or ")}`, ways);
  }
  const now = new Date().toISOString();
  const identity: IdentityRecord = { id: newId("idn"), email: account.email, name: account.name, emailVerifiedAt: now, termsUrl: null, termsAcceptedAt: null, createdAt: now };
  if (!(await store.insertIdentity(identity, { provider: account.provider, subject: account.subject, identityId: identity.id, email: account.email, addedAt: now }))) {
    // Another sign-in made it between the lookups; whichever identity holds the login now is the one.
    const raced = await store.getIdentityByLogin(account.provider, account.subject);
    if (raced) return raced;
    throw new SignInRefused("address-taken", `${account.email} signs in another way`);
  }
  await recordStep(store, identity, "signup.started", account.provider);
  return identity;
}

/**
 * What the signup page is told when a sign-in does not finish: a code from this set, never text,
 * so a link to /signup?problem=... shows only a sentence the orchestrator wrote.
 */
export type SignInProblem = ProviderProblem | "browser" | "expired" | "address-taken" | "invite-unknown" | "invite-expired" | "invite-email" | "invite-elsewhere" | "already-member" | "plan-limit" | "already-account" | "join-closed" | "reauth" | "login-taken";

export class SignInRefused extends Error {
  /** The providers an address already signs in with, named on the page so the person knows which one to use. */
  readonly signsInWith: SocialProvider[];

  constructor(readonly problem: SignInProblem, detail: string, signsInWith: SocialProvider[] = []) {
    super(detail);
    this.signsInWith = signsInWith;
  }
}

export interface IdentityRoutesOptions {
  store: Store;
  secure: boolean;
  clients: ReadonlyMap<SocialProvider, SocialClient>;
  trustedProxies?: string[];
  /** Where a signed-in person goes next, from the organizations they belong to. */
  landing: (memberships: UserRecord[]) => string;
  /** The address people open the orchestrator at, which a page posting an invitation has to come from. */
  publicUrl?: string;
  /** The organizations served, for the event an accepted invitation writes in its organization. */
  registry?: Pick<OrgRegistry, "get">;
  legal?: LegalLinks;
  /** Where someone stuck signing up gets help, shown under signup and its refusals. */
  helpUrl?: string | null;
  readmeUrl?: string | null;
}

const back = (c: Context, problem: SignInProblem, signsInWith: readonly SocialProvider[] = []) => c.redirect(`/signup?problem=${problem}${signsInWith.length ? `&with=${signsInWith.join(",")}` : ""}`, 302);

export function identityRoutes(options: IdentityRoutesOptions): Hono {
  const { store, secure, clients } = options;
  const app = new Hono();
  const from = clientFrom(options.trustedProxies ?? []);
  // Each start writes a row a callback takes or nobody does; these keep anonymous callers from filling the table.
  const startsPerClient = windowLimiter(10);
  const startsInAll = windowLimiter(600);
  const sameOrigin = (c: Context) => {
    const site = c.req.header("sec-fetch-site");
    if (site) return site === "same-origin";
    const origin = c.req.header("origin");
    return Boolean(origin) && origin === new URL(options.publicUrl ?? c.req.url).origin;
  };
  const provider = (c: Context): SocialProvider | null => {
    const name = c.req.param("provider") as SocialProvider;
    return SOCIAL_PROVIDERS.includes(name) && clients.has(name) ? name : null;
  };

  app.get("/api/identity/config", (c) =>
    c.json({ providers: SOCIAL_PROVIDERS.filter((p) => clients.has(p)), privacyUrl: options.legal?.privacyUrl ?? null, termsUrl: options.legal?.termsUrl ?? null, signupOpen: Boolean(options.legal?.privacyUrl && options.legal?.termsUrl), helpUrl: options.helpUrl ?? null, mode: "cloud", readmeUrl: options.readmeUrl ?? null }),
  );

  // GET from a sign-in button; POST from an invitation's page, with the invitation's token in the
  // body, since a link's token in a query string would land in every proxy's access log.
  app.on(["GET", "POST"], "/api/auth/:provider/start", async (c) => {
    const name = provider(c);
    if (!name) return c.json({ error: "this orchestrator does not sign in with that provider" }, 404);
    for (const verdict of [startsPerClient(`start:${from(c)}`), startsInAll("all")]) if (!verdict.ok) return tooMany(c, verdict, "too many sign-ins started; wait a minute");
    let inviteId: string | null = null;
    if (c.req.method === "POST") {
      // An invitation is taken only from the orchestrator's own page, where the person saw whose it is
      // and chose to follow it: another site posting one would join them to an organization unasked.
      if (!sameOrigin(c)) return back(c, "invite-elsewhere");
      const token = (await c.req.parseBody().catch(() => ({}) as Record<string, unknown>)).invite;
      const invite = typeof token === "string" && token ? await store.getInviteByToken(hashToken(token)) : null;
      if (!invite || invite.expiresAt <= new Date().toISOString()) return back(c, "invite-unknown");
      inviteId = `${invite.tenant}:${invite.id}`;
    }
    const { url, login } = await clients.get(name)!.start();
    await store.savePendingSignIn({ state: login.state, provider: name, purpose: "sign-in", nonce: login.nonce, verifier: login.verifier, identityId: null, inviteId, expiresAt: login.expiresAt });
    const cookie = stateCookie(secure);
    setCookie(c, cookie.name, login.state, { httpOnly: true, sameSite: "Lax", secure, path: cookie.path, expires: new Date(login.expiresAt) });
    return c.redirect(url, 302);
  });

  app.get("/api/auth/:provider/callback", async (c) => {
    const name = provider(c);
    if (!name) return c.json({ error: "this orchestrator does not sign in with that provider" }, 404);
    const cookie = stateCookie(secure);
    const state = c.req.query("state") ?? "";
    const held = getCookie(c, cookie.name);
    deleteCookie(c, cookie.name, { path: cookie.path, secure });
    // A callback this browser did not start is someone else's sign-in, sent to sign this browser in as them.
    if (!state || held !== state) return back(c, "browser");
    const pending = await store.takePendingSignIn(state, new Date().toISOString());
    if (!pending || pending.provider !== name) return back(c, "expired");
    const code = c.req.query("code");
    // A link waiting for the person's confirmation is no provider round trip to finish.
    if (pending.account) return back(c, "expired");
    if (pending.purpose === "link") return c.redirect(await finishLink(c, name, pending, code), 302);
    if (!code) return back(c, "provider-error");
    try {
      const account = await clients.get(name)!.finish(code, pending);
      const identity = await identityFor(store, account);
      await startIdentitySession(store, c, secure, identity.id, account);
      if (pending.inviteId) {
        const [tenant, id] = pending.inviteId.split(":") as [string, string];
        return c.redirect(`/${(await acceptAs(identity, tenant, id, account.provider, "land")).tenant}/`, 302);
      }
      return c.redirect(options.landing(await store.listMemberships(identity.id)), 302);
    } catch (err) {
      if (err instanceof SignInRefused) return back(c, err.problem, err.signsInWith);
      if (err instanceof ProviderRefused) return back(c, err.problem);
      if ((err as { status?: number }).status === 403) return back(c, "provider-error");
      throw err;
    }
  });

  /**
   * An invitation taken by the identity that just signed in: only when its address is the one the
   * provider verified for that identity, never an account matched by address, and only while the
   * organization has a seat left, counted and taken in one step.
   */
  const acceptAs = async (identity: IdentityRecord, tenant: string, id: string, provider: SocialProvider, again: "land" | "refuse"): Promise<{ tenant: string; orgName: string }> => {
    const invite = await store.getInvite(tenant, id);
    const org = await store.getOrg(tenant);
    // One revoked, never sent or in a deleted organization reads alike, so nobody learns which.
    if (!invite || org?.deletedAt) throw new SignInRefused("invite-unknown", "This invitation is not one this orchestrator holds. Ask whoever invited you for a new link.");
    const shownName = org?.name ?? (await orgName(store, tenant));
    if (invite.expiresAt <= new Date().toISOString()) {
      const inviter = (await store.getUserByEmail(tenant, invite.invitedBy))?.name || invite.invitedBy;
      throw new SignInRefused("invite-expired", `This invitation expired on ${invite.expiresAt.slice(0, 10)}. Ask ${inviter} for a new one.`);
    }
    if (invite.email !== identity.email) throw new SignInRefused("invite-email", `This invitation is for ${invite.email}. Sign in with that address to accept it.`);
    if (await store.getUserByIdentity(tenant, identity.id)) {
      await store.deleteInvite(tenant, id);
      if (again === "refuse") throw new SignInRefused("already-member", `You are already a member of ${shownName}.`);
      return { tenant, orgName: shownName };
    }
    if (await store.getUserByEmail(tenant, invite.email)) throw new SignInRefused("already-account", `${invite.email} already has an account in ${shownName}. Ask an owner to remove it and invite you again.`);
    const user: UserRecord = { tenant, id: newId("usr"), email: invite.email, name: identity.name, role: invite.role, passwordHash: null, oidcIssuer: null, oidcSubject: null, forgeLogin: null, createdAt: new Date().toISOString(), identityId: identity.id };
    const { members } = await orgQuota({ store, tenant });
    if (!(await store.insertMember(user, members))) throw new SignInRefused("plan-limit", `${shownName} has as many members as its plan allows. Ask an owner to make room.`);
    if (invite.teams.length) await store.setOwnedTeams(tenant, user.id, invite.teams);
    await store.deleteInvite(tenant, id);
    await clearRemoved(store, tenant, identity.id);
    await recordStep(store, identity, "invite.accepted", provider, tenant);
    const served = await options.registry?.get(tenant);
    if (served) await recordEvent(served.ctx, await principalOf(store, user), "account.joined", { subject: `account:${user.id}`, detail: `accepted an invitation as ${user.role}, signed in with ${PROVIDER_LABEL[provider]}` });
    return { tenant, orgName: shownName };
  };

  const joinClosed = () => new SignInRefused("join-closed", "This organization does not take people from your account's directory. Ask an owner for an invitation.");

  /**
   * Whether this session joins an organization by its directory, checked as reaching it would be:
   * the owner let this provider's directory in, the organization takes this provider, and neither
   * the organization nor its directory removed this identity.
   */
  const openToDirectory = async (session: IdentitySessionRecord, tenant: string) => {
    const org = await store.getOrg(tenant);
    const join = org && !org.deletedAt ? await directoryJoinOf(store, tenant) : null;
    if (!org || !join || join.provider !== session.method || join.directory !== session.domain) return null;
    if ((await wasRemoved(store, tenant, session.identityId)) || !(await orgTakes(store, tenant, session.method))) return null;
    return { org, join };
  };

  const joinByDirectory = async (session: IdentitySessionRecord, identity: IdentityRecord, tenant: string): Promise<{ tenant: string; orgName: string }> => {
    const open = await openToDirectory(session, tenant);
    if (!open) throw joinClosed();
    if (await store.getUserByIdentity(tenant, identity.id)) throw new SignInRefused("already-member", `You are already a member of ${open.org.name}.`);
    if (await store.getUserByEmail(tenant, identity.email)) throw new SignInRefused("already-account", `${identity.email} already has an account in ${open.org.name}. Ask an owner to remove it and invite you again.`);
    const user: UserRecord = { tenant, id: newId("usr"), email: identity.email, name: identity.name, role: open.join.role, passwordHash: null, oidcIssuer: null, oidcSubject: null, forgeLogin: null, createdAt: new Date().toISOString(), identityId: identity.id };
    const { members } = await orgQuota({ store, tenant });
    if (!(await store.insertMember(user, members))) throw new SignInRefused("plan-limit", `${open.org.name} has as many members as its plan allows. Ask an owner to make room.`);
    await recordStep(store, identity, "directory.joined", session.method, tenant);
    const served = await options.registry?.get(tenant);
    if (served) await recordEvent(served.ctx, await principalOf(store, user), "account.joined", { subject: `account:${user.id}`, detail: `joined as ${user.role} through their ${PROVIDER_LABEL[session.method]} directory` });
    return { tenant, orgName: open.org.name };
  };

  /**
   * Where a person adding or removing a way to sign in lands: their account page in their first
   * organization, with what happened in the query, which the page turns into a sentence it wrote.
   */
  const accountPage = async (identityId: string, outcome: string) => {
    const first = (await store.listMemberships(identityId))[0];
    return first ? `/${first.tenant}/settings/account?${outcome}` : `/signup/organization?${outcome}`;
  };

  /** Writes a change to an identity's ways in into the log of each organization it belongs to. */
  const logLogins = async (identityId: string, kind: string, detail: string) => {
    for (const user of await store.listMemberships(identityId)) {
      const served = await options.registry?.get(user.tenant);
      if (served) await recordEvent(served.ctx, await principalOf(store, user), kind, { subject: `account:${user.id}`, detail });
    }
  };

  /**
   * A provider's answer to a link this identity started: taken only in the browser whose session
   * started it and for that identity, and only for a provider account no other identity holds.
   * An account under another verified address waits for the person to confirm it is theirs, on a
   * page that names it: someone else's account would become a way into this person's organizations.
   */
  const finishLink = async (c: Context, name: SocialProvider, pending: PendingSignIn, code: string | undefined): Promise<string> => {
    const session = await identitySessionOf(c, store, secure);
    if (!session || session.identityId !== pending.identityId) return "/signup?problem=browser";
    const outcome = (problem: SignInProblem) => accountPage(session.identityId, `link-problem=${problem}`);
    if (!code) return outcome("provider-error");
    const identity = await store.getIdentity(session.identityId);
    if (!identity) return "/signup?problem=expired";
    try {
      const account = await clients.get(name)!.finish(code, pending);
      const holder = await store.getIdentityByLogin(account.provider, account.subject);
      if (holder) return holder.id === identity.id ? accountPage(identity.id, `linked=${name}`) : outcome("login-taken");
      if (account.email !== identity.email) {
        const token = newToken();
        await store.savePendingSignIn({ state: token, provider: name, purpose: "link", nonce: "", verifier: "", identityId: identity.id, inviteId: null, account: { subject: account.subject, email: account.email, name: account.name }, expiresAt: new Date(Date.now() + CONFIRM_MS).toISOString() });
        return accountPage(identity.id, `link-confirm=${token}`);
      }
      if (!(await store.addLogin({ provider: account.provider, subject: account.subject, identityId: identity.id, email: account.email, addedAt: new Date().toISOString() }))) return outcome("login-taken");
      await logLogins(identity.id, "account.sign-in-added", `added ${PROVIDER_LABEL[name]} as a way to sign in`);
      return accountPage(identity.id, `linked=${name}`);
    } catch (err) {
      if (err instanceof ProviderRefused) return outcome(err.problem);
      if ((err as { status?: number }).status === 403) return outcome("provider-error");
      throw err;
    }
  };

  /** Adding or removing a way in takes a sign-in this recent: a browser someone left signed in does not. */
  const FRESH_MS = 10 * 60_000;
  /** How long an account under another address waits for the person to confirm it. */
  const CONFIRM_MS = 10 * 60_000;

  /**
   * The account waiting for this identity's confirmation, taken and put back so reading it spends
   * nothing; null when the token is unknown, expired, not this identity's, or no confirmation.
   */
  const awaitingConfirmation = async (identityId: string, token: string, spend: boolean) => {
    const pending = token ? await store.takePendingSignIn(token, new Date().toISOString()) : null;
    if (!pending) return null;
    if (pending.identityId !== identityId || !pending.account) {
      await store.savePendingSignIn(pending);
      return null;
    }
    if (!spend) await store.savePendingSignIn(pending);
    return { provider: pending.provider, account: pending.account };
  };
  const reauth = (c: Context) => c.json({ error: "Sign in again first: changing how you sign in takes a sign-in from the last ten minutes.", code: "reauth" }, 409);

  /** The signed-in identity of a call that changes something, CSRF token checked, or the answer that refuses it. */
  const signedIn = async (c: Context): Promise<{ session: IdentitySessionRecord; identity: IdentityRecord } | Response> => {
    const session = await identitySessionOf(c, store, secure);
    const identity = session ? await store.getIdentity(session.identityId) : null;
    if (!session || !identity) return c.json({ error: "sign in first" }, 401);
    return csrfRefusal(c, session.csrf) ?? { session, identity };
  };
  const joinAnswer = async (c: Context, accepted: Promise<{ tenant: string; orgName: string }>) => {
    try {
      const { tenant, orgName: name } = await accepted;
      return c.json({ tenant, orgName: name, next: `/${tenant}/tasks` });
    } catch (err) {
      if (!(err instanceof SignInRefused)) throw err;
      const status = err.problem === "invite-unknown" ? 404 : err.problem === "invite-expired" ? 410 : err.problem === "join-closed" ? 403 : 409;
      return c.json({ error: err.message, code: err.problem }, status);
    }
  };
  const unknownInvite = () => Promise.reject(new SignInRefused("invite-unknown", "This invitation is not one this orchestrator holds. Ask whoever invited you for a new link."));

  app.post("/api/identity/join", async (c) => {
    const who = await signedIn(c);
    if (who instanceof Response) return who;
    const { token } = (await c.req.json().catch(() => ({}))) as { token?: unknown };
    const invite = typeof token === "string" && token ? await store.getInviteByToken(hashToken(token)) : null;
    return joinAnswer(c, invite ? acceptAs(who.identity, invite.tenant, invite.id, who.session.method, "refuse") : unknownInvite());
  });

  app.get("/api/me/orgs", async (c) => {
    const session = await identitySessionOf(c, store, secure);
    const identity = session ? await store.getIdentity(session.identityId) : null;
    if (!session || !identity) return c.json({ error: "sign in first" }, 401);
    const orgs = [];
    for (const user of await store.listMemberships(identity.id)) {
      const org = await store.getOrg(user.tenant);
      if (!org || org.deletedAt || !(await cloudMemberOf(store, user.tenant, session))) continue;
      orgs.push({ tenant: user.tenant, orgName: org.name, role: user.role });
    }
    const joinable = [];
    for (const tenant of await tenantsJoinableBy(store, session)) {
      if (orgs.some((o) => o.tenant === tenant) || (await store.getUserByIdentity(tenant, identity.id))) continue;
      const open = await openToDirectory(session, tenant);
      if (open) joinable.push({ tenant, orgName: open.org.name, role: open.join.role });
    }
    const invitations = [];
    for (const invite of await store.listInvitesByEmail(identity.email, new Date().toISOString())) {
      if (orgs.some((o) => o.tenant === invite.tenant)) continue;
      invitations.push({
        id: `${invite.tenant}:${invite.id}`,
        orgName: (await store.getOrg(invite.tenant))?.name ?? invite.tenant,
        invitedBy: (await store.getUserByEmail(invite.tenant, invite.invitedBy))?.name || invite.invitedBy,
        role: invite.role,
        teams: invite.teams,
        expiresAt: invite.expiresAt,
      });
    }
    return c.json({ orgs, invitations, joinable });
  });

  app.post("/api/me/joinable/:tenant", async (c) => {
    const who = await signedIn(c);
    if (who instanceof Response) return who;
    return joinAnswer(c, joinByDirectory(who.session, who.identity, c.req.param("tenant")));
  });

  /** An invitation of this identity's own address, by the id /api/me/orgs gives; anyone else's reads as none. */
  const ownInvite = async (identity: IdentityRecord, ref: string) => {
    const [tenant, id] = ref.split(":");
    const invite = tenant && id ? await store.getInvite(tenant, id) : null;
    return invite && invite.email === identity.email ? invite : null;
  };

  app.post("/api/me/invitations/:id/accept", async (c) => {
    const who = await signedIn(c);
    if (who instanceof Response) return who;
    const invite = await ownInvite(who.identity, c.req.param("id"));
    return joinAnswer(c, invite ? acceptAs(who.identity, invite.tenant, invite.id, who.session.method, "refuse") : unknownInvite());
  });

  app.delete("/api/me/invitations/:id", async (c) => {
    const who = await signedIn(c);
    if (who instanceof Response) return who;
    const invite = await ownInvite(who.identity, c.req.param("id"));
    if (!invite) return c.json({ error: "This invitation is not one this orchestrator holds. Ask whoever invited you for a new link.", code: "invite-unknown" }, 404);
    await store.deleteInvite(invite.tenant, invite.id);
    return c.body(null, 204);
  });

  app.get("/api/identity", async (c) => {
    const session = await identitySessionOf(c, store, secure);
    const identity = session ? await store.getIdentity(session.identityId) : null;
    if (!session || !identity) return c.json({ error: "sign in first" }, 401);
    const memberships = [];
    for (const user of await store.listMemberships(identity.id)) {
      const org = await store.getOrg(user.tenant);
      if (org?.deletedAt) continue;
      memberships.push({ tenant: user.tenant, name: org?.name ?? user.tenant, role: user.role, reachable: Boolean(await cloudMemberOf(store, user.tenant, session)) });
    }
    return c.json({
      identity: { email: identity.email, name: identity.name, signedInWith: session.method },
      logins: (await store.listLogins(identity.id)).map((l) => ({ provider: l.provider, email: l.email, addedAt: l.addedAt })),
      memberships,
      csrf: session.csrf,
    });
  });

  app.post("/api/identity/logins/:provider", async (c) => {
    const who = await signedIn(c);
    if (who instanceof Response) return who;
    const name = provider(c);
    if (!name) return c.json({ error: "this orchestrator does not sign in with that provider" }, 404);
    if (Date.now() - Date.parse(who.session.authenticatedAt) > FRESH_MS) return reauth(c);
    if ((await store.listLogins(who.identity.id)).some((l) => l.provider === name)) return c.json({ error: `You already sign in with ${PROVIDER_LABEL[name]}.`, code: "login-taken" }, 409);
    for (const verdict of [startsPerClient(`start:${from(c)}`), startsInAll("all")]) if (!verdict.ok) return tooMany(c, verdict, "too many sign-ins started; wait a minute");
    const { url, login } = await clients.get(name)!.start();
    await store.savePendingSignIn({ state: login.state, provider: name, purpose: "link", nonce: login.nonce, verifier: login.verifier, identityId: who.identity.id, inviteId: null, expiresAt: login.expiresAt });
    const cookie = stateCookie(secure);
    setCookie(c, cookie.name, login.state, { httpOnly: true, sameSite: "Lax", secure, path: cookie.path, expires: new Date(login.expiresAt) });
    return c.json({ url });
  });

  app.get("/api/identity/logins/confirm/:token", async (c) => {
    const session = await identitySessionOf(c, store, secure);
    if (!session) return c.json({ error: "sign in first" }, 401);
    const waiting = await awaitingConfirmation(session.identityId, c.req.param("token"), false);
    if (!waiting) return c.json({ error: "This link is not waiting for you any more. Add the provider again." }, 404);
    return c.json({ provider: waiting.provider, email: waiting.account.email });
  });

  app.post("/api/identity/logins/confirm/:token", async (c) => {
    const who = await signedIn(c);
    if (who instanceof Response) return who;
    if (Date.now() - Date.parse(who.session.authenticatedAt) > FRESH_MS) return reauth(c);
    const waiting = await awaitingConfirmation(who.identity.id, c.req.param("token"), true);
    if (!waiting) return c.json({ error: "This link is not waiting for you any more. Add the provider again." }, 404);
    const linked = await store.addLogin({ provider: waiting.provider, subject: waiting.account.subject, identityId: who.identity.id, email: waiting.account.email, addedAt: new Date().toISOString() });
    if (!linked) return c.json({ error: "That account already signs in to this orchestrator as someone else, so it is not added to yours.", code: "login-taken" }, 409);
    await logLogins(who.identity.id, "account.sign-in-added", `added ${PROVIDER_LABEL[waiting.provider]} as a way to sign in, under the address ${waiting.account.email}, which they confirmed is theirs`);
    return c.json({ provider: waiting.provider });
  });

  app.delete("/api/identity/logins/:provider", async (c) => {
    const who = await signedIn(c);
    if (who instanceof Response) return who;
    if (Date.now() - Date.parse(who.session.authenticatedAt) > FRESH_MS) return reauth(c);
    const login = (await store.listLogins(who.identity.id)).find((l) => l.provider === c.req.param("provider"));
    if (!login) return c.json({ error: "You do not sign in that way." }, 404);
    if (!(await store.removeLogin(who.identity.id, login.provider, login.subject))) return c.json({ error: "This is your last way to sign in; add another before removing it.", code: "last-login" }, 409);
    await logLogins(who.identity.id, "account.sign-in-removed", `removed ${PROVIDER_LABEL[login.provider]} as a way to sign in`);
    return c.body(null, 204);
  });

  app.post("/api/identity/logout", async (c) => {
    const session = await identitySessionOf(c, store, secure);
    const refused = session ? csrfRefusal(c, session.csrf) : null;
    if (refused) return refused;
    if (session) await store.deleteIdentitySession(session.tokenHash);
    deleteCookie(c, identityCookie(secure), { path: "/", secure });
    return c.json({ ok: true });
  });

  return app;
}
