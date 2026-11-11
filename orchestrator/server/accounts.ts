import { route } from "./route-scopes.js";
import type { IdentityStore, SocialProvider } from "./identities.js";
import { timingSafeEqual, createHash } from "node:crypto";
import { newId } from "./ids.js";
import { isIPv6 } from "node:net";
import { OrchestratorError, errorAnswer, STATUS_CODES } from "./errors.js";
import { shownPlan } from "./plans.js";
import { Hono } from "hono";
import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { OrchestratorContext } from "./app.js";
import { canEditTeam, hashToken, manages, newToken, reaches, ROLES, secureOrchestrator, sessionCookie, tenantMark } from "./auth.js";
import type { OrchestratorEnv, Principal, Role } from "./auth.js";
import type { DirectoryStore } from "./directory.js";
import type { DomainStore } from "./domains.js";
import { joinsWithoutInvitation, ssoRequired, ssoRequiredError } from "./domains.js";
import { scimOn, suspended } from "./scim.js";
import { memberTags } from "./directory.js";
import type { InviteRecord, InviteStore } from "./invites.js";
import { keyCeiling } from "./keys.js";
import type { KeyStore } from "./keys.js";
import type { Store } from "./store.js";
import type { OidcClient } from "./oidc.js";
import { decoyHash, hashPassword, passwordProblem, verifyPassword } from "./passwords.js";
import { recordEvent } from "./events.js";
import type { EventActor } from "./events.js";
import { tooMany, windowLimiter } from "./limits.js";
import type { Verdict } from "./limits.js";
import { everyTask } from "./tasks/guards.js";
import { cloudMode, localMode } from "./mode.js";
import { legalLinks } from "./legal.js";
import { identityCookie, identitySessionOf } from "./cloud-identity.js";
import { grantsOf, revokeGrant } from "./integrations/oauth-server.js";
import { directoryJoinOf, markRemoved, setDirectoryJoin } from "./directory-join.js";

export interface UserRecord {
  tenant: string;
  id: string;
  email: string;
  name: string;
  role: Role;
  passwordHash: string | null;
  oidcIssuer: string | null;
  oidcSubject: string | null;
  forgeLogin: string | null;
  createdAt: string;
  /** On a cloud orchestrator, the identity this account is the organization membership of. */
  identityId?: string | null;
  /** When this account's sessions were last ended; a cloud identity session from before it reaches the organization no more. */
  sessionsRevokedAt?: string | null;
}

export interface SessionRecord {
  tokenHash: string;
  tenant: string;
  userId: string;
  csrf: string;
  expiresAt: string;
  /** The browser and system family it signed in from, cut to 120 characters; never the full header. */
  userAgent?: string | null;
  /** When it started; null on a session from before this was kept, which is then never renewed. */
  createdAt?: string | null;
}

/** A session as its person sees it in a list: an id to end it by, never the token's hash or its CSRF value. */
export interface SessionListing {
  id: string;
  createdAt: string | null;
  lastSeenAt: string | null;
  userAgent: string | null;
  expiresAt: string;
  /** The session the list was asked for from. */
  current: boolean;
}

export interface OidcLogin {
  state: string;
  tenant: string;
  nonce: string;
  verifier: string;
  expiresAt: string;
}

export type UserPatch = Partial<Pick<UserRecord, "name" | "passwordHash" | "forgeLogin" | "oidcIssuer" | "oidcSubject">>;

export interface AccountStore extends InviteStore, KeyStore, DirectoryStore, DomainStore {
  countUsers(tenant: string): Promise<number>;
  /** Inserts the first user of an empty tenant; false when the tenant's setup was already claimed. */
  claimSetup(user: UserRecord): Promise<boolean>;
  insertUser(user: UserRecord): Promise<void>;
  getUser(tenant: string, id: string): Promise<UserRecord | null>;
  getUserByEmail(tenant: string, email: string): Promise<UserRecord | null>;
  getUserByOidc(tenant: string, issuer: string, subject: string): Promise<UserRecord | null>;
  listUsers(tenant: string): Promise<UserRecord[]>;
  updateUser(tenant: string, id: string, patch: UserPatch): Promise<void>;
  /** Gives a person a role, unless that leaves the organization without an owner; false when it would. */
  setRole(tenant: string, id: string, role: Role): Promise<boolean>;
  /** Removes a person with their sessions and teams, unless they are the last owner; false when they are. */
  deleteUser(tenant: string, id: string): Promise<boolean>;
  ownedTeams(tenant: string, userId: string): Promise<string[]>;
  setOwnedTeams(tenant: string, userId: string, teams: string[]): Promise<void>;
  teamOwners(tenant: string): Promise<{ userId: string; team: string }[]>;
  saveSession(session: SessionRecord): Promise<void>;
  getSession(tokenHash: string): Promise<SessionRecord | null>;
  deleteSession(tokenHash: string): Promise<void>;
  /** The person's sessions, the most recently seen first; `current` marks the one whose token hash is given. */
  listSessions(tenant: string, userId: string, current?: string): Promise<SessionListing[]>;
  /** False when no session of this person has that id. */
  deleteSessionById(tenant: string, userId: string, id: string): Promise<boolean>;
  /** Marks a session seen; with `expiresAt`, also moves its expiry there when that is later. */
  touchSession(tokenHash: string, at: string, expiresAt?: string): Promise<void>;
  /** Every session of one person but `except`: a password change signs out their other browsers. */
  deleteSessions(tenant: string, userId: string, except?: string): Promise<void>;
  saveOidcLogin(login: OidcLogin): Promise<void>;
  takeOidcLogin(state: string): Promise<OidcLogin | null>;
  /** Owners the directory has not turned off: the ones who can still sign in and change roles. */
  countOwners(tenant: string): Promise<number>;
  /**
   * Marks an account turned off by the directory, in the organization's owner turn, unless it is
   * the last owner still on; false when it is.
   */
  turnOffUser(tenant: string, id: string, at: string): Promise<boolean>;
  /** A changed address, from the directory; unique per tenant like every other. */
  setUserEmail(tenant: string, id: string, email: string): Promise<void>;
  /** Every app a person approved and the tokens it holds. */
  dropOauthGrants(tenant: string, userId: string): Promise<void>;
  listSettings(tenant: string, prefix: string): Promise<{ key: string; value: string }[]>;
  getSetting(tenant: string, key: string): Promise<string | null>;
  setSetting(tenant: string, key: string, value: string): Promise<void>;
  deleteSetting(tenant: string, key: string): Promise<void>;
  /** Sessions and unanswered sign-ins past their expiry, in every tenant. */
  purgeExpired(now: string): Promise<void>;
}

const TURNED_OFF = () => new AccountError("this account is turned off by the organization's directory", 403);

/** Rows of each list a member's page shows; the totals say how many there are in all. */
export const MEMBER_PAGE_ROWS = 20;

/** Twelve hours: one working day, after which the browser asks again. */
export const SESSION_HOURS = 12;
/** The most a session lasts however much it is used, so a cookie taken off a machine stops then too. */
export const SESSION_MAX_DAYS = 7;
/**
 * A local orchestrator's one person signs in from the address its command prints and has no other
 * way back in, so their session lasts a month without use and a quarter in use: whoever runs the
 * command on this machine mints a new one anyway.
 */
export const LOCAL_SESSION_DAYS = 30;
export const LOCAL_SESSION_MAX_DAYS = 90;

/** How long a session lasts unused, and the most it lasts in use. */
export function sessionLife(local = localMode()): { idleMs: number; maxMs: number } {
  return local ? { idleMs: LOCAL_SESSION_DAYS * 86_400_000, maxMs: LOCAL_SESSION_MAX_DAYS * 86_400_000 } : { idleMs: SESSION_HOURS * 3_600_000, maxMs: SESSION_MAX_DAYS * 86_400_000 };
}

/**
 * The later expiry a session in use renews to, as the person works: a full idle time from now, never
 * past its most from when it started. Undefined while more than half its idle time is left, at its
 * most, or for a session from before sessions recorded when they started.
 */
export function renewedExpiry(session: { expiresAt: string; startedAt?: string | null }, at: string, life = sessionLife()): string | undefined {
  const now = Date.parse(at);
  const expires = Date.parse(session.expiresAt);
  if (!session.startedAt || expires - now > life.idleMs / 2) return undefined;
  const next = Math.min(now + life.idleMs, Date.parse(session.startedAt) + life.maxMs);
  return next > expires ? new Date(next).toISOString() : undefined;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const FORGE_LOGIN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export class AccountError extends OrchestratorError {
  /** `code` names the refusal for a screen that answers it in its own words; left out, it says the status. */
  constructor(message: string, status: 400 | 403 | 404 | 409 | 429 = 400, code?: string) {
    super(code ?? `account-${STATUS_CODES[status]}`, message, status);
  }
}

/**
 * The one form an address takes everywhere it is compared or counted: the account lookup and
 * the sign-in limit read the same key, so " Ada@x" and "ada@x" are one address to both.
 */
export function emailKey(email: unknown): string {
  return typeof email === "string" ? email.trim().toLowerCase() : "";
}

export function normalizeEmail(email: unknown): string {
  const key = emailKey(email);
  if (!EMAIL.test(key) || key.length > 254) throw new AccountError("enter a valid email address");
  return key;
}

function cleanName(name: unknown, fallback: string): string {
  const text = typeof name === "string" ? name.trim() : "";
  if (text.length > 120) throw new AccountError("that name is too long");
  return text || fallback;
}

export const VIEWER_OWNS_NONE = "a viewer owns no team; make them a member first";

function cleanRole(role: unknown): Role {
  if (!ROLES.includes(role as Role)) throw new AccountError("role is owner, admin, member or viewer");
  return role as Role;
}

function cleanForgeLogin(login: unknown): string | null {
  if (login === null || login === undefined || login === "") return null;
  if (typeof login !== "string" || !FORGE_LOGIN.test(login)) throw new AccountError("a forge login is letters, digits, dot, dash or underscore");
  return login;
}

export function cleanTeams(teams: unknown, known: Set<string>): string[] {
  if (teams === undefined) return [];
  if (!Array.isArray(teams) || !teams.every((t) => typeof t === "string")) throw new AccountError("teams is a list of team names");
  const unknown = (teams as string[]).filter((t) => !known.has(t));
  if (unknown.length) throw new AccountError(`no connected repository belongs to ${unknown.join(", ")}`);
  return [...new Set(teams as string[])].sort();
}

/** Where a team kept to its owners is marked, one setting row per team; a team's name is encoded so any name makes a key. */
export const RESTRICTED_PREFIX = "team.restricted.";
export const restrictedKey = (team: string) => `${RESTRICTED_PREFIX}${encodeURIComponent(team)}`;

export async function restrictedTeamsOf(store: Pick<AccountStore, "listSettings">, tenant: string): Promise<string[]> {
  return (await store.listSettings(tenant, RESTRICTED_PREFIX)).map((row) => decodeURIComponent(row.key.slice(RESTRICTED_PREFIX.length)));
}

export async function principalOf(store: AccountStore, user: UserRecord): Promise<Principal> {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    ownedTeams: await store.ownedTeams(user.tenant, user.id),
    restrictedTeams: await restrictedTeamsOf(store, user.tenant),
    ...(user.forgeLogin ? { forgeLogin: user.forgeLogin } : {}),
  };
}

/** What the screen and the API show of an account: never the hash, never the identity provider's subject. */
export interface UserView {
  id: string;
  email: string;
  name: string;
  role: Role;
  ownedTeams: string[];
  forgeLogin: string | null;
  /** How the account signs in: its password and single sign-on, or on a cloud orchestrator the providers its identity signs in with. */
  signIn: ("password" | "sso" | SocialProvider)[];
  createdAt: string;
}

export async function listUserViews(store: AccountStore & Pick<IdentityStore, "listLogins">, tenant: string): Promise<UserView[]> {
  const owners = await store.teamOwners(tenant);
  const views: UserView[] = [];
  for (const u of await store.listUsers(tenant)) {
    const providers = u.identityId ? [...new Set((await store.listLogins(u.identityId)).map((l) => l.provider))] : [];
    views.push({
      id: u.id,
      email: u.email,
      name: u.name,
      role: u.role,
      ownedTeams: owners.filter((o) => o.userId === u.id).map((o) => o.team),
      forgeLogin: u.forgeLogin,
      signIn: [...(u.passwordHash ? (["password"] as const) : []), ...(u.oidcSubject ? (["sso"] as const) : []), ...providers],
      createdAt: u.createdAt,
    });
  }
  return views;
}

function sameCode(given: unknown, expected: string): boolean {
  if (typeof given !== "string") return false;
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

export interface NewSession {
  token: string;
  csrf: string;
  expiresAt: string;
  /** When the browser drops the cookie: the session's most, since the orchestrator renews the session itself while it is used. */
  cookieUntil: string;
}

/**
 * A browser's family and its system's, as its sessions are listed: "Firefox on Windows". The
 * full header says far more about the machine than anyone needs to tell their sessions apart.
 */
export function agentOf(header: string | undefined): string | null {
  if (!header) return null;
  const browser = /Edg\//.test(header) ? "Edge" : /Firefox\//.test(header) ? "Firefox" : /Chrome\//.test(header) ? "Chrome" : /Safari\//.test(header) ? "Safari" : null;
  const system = /iPhone|iPad/.test(header) ? "iOS" : /Android/.test(header) ? "Android" : /Windows/.test(header) ? "Windows" : /Mac OS X|Macintosh/.test(header) ? "macOS" : /Linux/.test(header) ? "Linux" : null;
  if (!browser && !system) return null;
  return [browser ?? "A browser", system].filter(Boolean).join(" on ");
}

export async function startSession(store: AccountStore, tenant: string, userId: string, now = new Date(), userAgent: string | null = null): Promise<NewSession> {
  await store.purgeExpired(now.toISOString());
  const token = newToken();
  const session: SessionRecord = {
    tokenHash: hashToken(token),
    tenant,
    userId,
    csrf: newToken(),
    expiresAt: new Date(now.getTime() + sessionLife().idleMs).toISOString(),
    userAgent,
    createdAt: now.toISOString(),
  };
  await store.saveSession(session);
  return { token, csrf: session.csrf, expiresAt: session.expiresAt, cookieUntil: new Date(now.getTime() + sessionLife().maxMs).toISOString() };
}

/**
 * The first owner, and the only account created without one. It needs the setup code the
 * orchestrator prints at every start while the organization has no owner (or the one the operator
 * set): an orchestrator listening on 0.0.0.0 before anyone signs in must not hand its owner to
 * whoever finds it first. Single sign-on creates no account until this has happened.
 */
export async function setupFirstOwner(
  store: AccountStore,
  tenant: string,
  expectedCode: string | undefined,
  input: { code?: unknown; email?: unknown; name?: unknown; password?: unknown },
): Promise<UserRecord> {
  if (!expectedCode || !sameCode(input.code, expectedCode)) throw new AccountError("that setup code is not the one this orchestrator printed", 403);
  const email = normalizeEmail(input.email);
  const problem = passwordProblem(input.password);
  if (problem) throw new AccountError(problem);
  if (await store.getUserByEmail(tenant, email)) throw new AccountError(`${email} already has an account; set up the owner with another address`, 409);
  const user: UserRecord = {
    tenant,
    id: newId("usr"),
    email,
    name: cleanName(input.name, email),
    role: "owner",
    passwordHash: await hashPassword(input.password as string),
    oidcIssuer: null,
    oidcSubject: null,
    forgeLogin: null,
    createdAt: new Date().toISOString(),
  };
  if (!(await store.claimSetup(user))) throw new AccountError("this orchestrator is already set up; sign in instead", 409);
  return user;
}

/**
 * A local orchestrator's one person: the owner the orchestrator makes at its first start, with no
 * setup code and no password, since whoever runs the command on this machine is the person it
 * is for. Made through the same one-step claim as the first owner, so two starts make one owner;
 * a later start returns the owner there is.
 */
export async function localOwner(store: AccountStore, tenant: string, person: { email: string; name?: string }): Promise<UserRecord> {
  const email = normalizeEmail(person.email);
  const user: UserRecord = { tenant, id: newId("usr"), email, name: cleanName(person.name, email), role: "owner", passwordHash: null, oidcIssuer: null, oidcSubject: null, forgeLogin: null, createdAt: new Date().toISOString() };
  if (await store.claimSetup(user)) return user;
  const owner = (await store.listUsers(tenant)).find((u) => u.role === "owner");
  if (!owner) throw new Error("a local orchestrator holds accounts but no owner");
  return owner;
}

const LOCAL_LINK = "local.link.";
/** How long the address a local start prints opens the orchestrator; the command prints a new one each time it runs. */
export const LOCAL_LINK_MINUTES = 5;
// A local orchestrator is one process, so a token is taken once by marking it here before the first
// await: a second request with it, at the same moment, finds it taken.
const taking = new Set<string>();

/** A one-time token for the address a local start opens; only its hash is kept. */
export async function mintLocalLink(store: AccountStore, tenant: string, now = new Date()): Promise<string> {
  const token = newToken();
  await store.setSetting(tenant, `${LOCAL_LINK}${hashToken(token)}`, new Date(now.getTime() + LOCAL_LINK_MINUTES * 60_000).toISOString());
  return token;
}

/** Takes back a token nobody used: the sign-in page holds one live address at a time. */
export async function dropLocalLink(store: AccountStore, tenant: string, token: string): Promise<void> {
  await store.deleteSetting(tenant, `${LOCAL_LINK}${hashToken(token)}`);
}

/** Whether a token this orchestrator minted is still unused and unexpired, read without spending it. */
export async function localLinkOpen(store: AccountStore, tenant: string, token: string, now = new Date()): Promise<boolean> {
  const expiresAt = token ? await store.getSetting(tenant, `${LOCAL_LINK}${hashToken(token)}`) : null;
  return expiresAt !== null && expiresAt > now.toISOString();
}

/** The owner's new session for a token this orchestrator minted and nobody used, before it expired; null for any other. */
export async function exchangeLocalLink(store: AccountStore, tenant: string, token: string, now = new Date(), userAgent: string | null = null): Promise<NewSession | null> {
  const key = `${LOCAL_LINK}${hashToken(token)}`;
  if (!token || taking.has(key)) return null;
  taking.add(key);
  try {
    const expiresAt = await store.getSetting(tenant, key);
    if (!expiresAt) return null;
    await store.deleteSetting(tenant, key);
    if (expiresAt <= now.toISOString()) return null;
    const owner = (await store.listUsers(tenant)).find((u) => u.role === "owner");
    return owner ? startSession(store, tenant, owner.id, now, userAgent) : null;
  } finally {
    taking.delete(key);
  }
}

export async function signInWithPassword(
  store: AccountStore,
  tenant: string,
  email: unknown,
  password: unknown,
  allow: (key: string) => boolean = () => true,
  ssoOn = false,
): Promise<UserRecord> {
  const key = emailKey(email);
  if (!allow(`login:${key}`)) throw new AccountError("too many attempts; wait a minute", 429);
  const refused = new AccountError("wrong email or password", 403);
  if (!key || typeof password !== "string") throw refused;
  const user = await store.getUserByEmail(tenant, key);
  // Before the password is checked, so the answer says nothing about whether it was right; an
  // address with no account is answered the same as a member's.
  if (await ssoRequired(store, tenant, ssoOn, key, user?.role ?? null)) throw ssoRequiredError(key);
  const ok = await verifyPassword(password, user?.passwordHash ?? (await decoyHash()));
  if (!user?.passwordHash || !ok) throw refused;
  // After the password, so only someone who knows it learns the directory turned the account off.
  if (await suspended(store, tenant, user.id)) throw TURNED_OFF();
  return user;
}

/**
 * What a person who manages others may not do: act on anyone above their own role, or give a
 * role above it. An admin neither makes an owner nor changes or removes one.
 */
export function overreach(actor: Principal, target: Role, given?: Role): AccountError | null {
  if (!manages(actor)) return new AccountError("only an owner or an admin manages members", 403);
  if (!reaches(actor.role, target)) return new AccountError("only an owner changes or removes an owner", 403);
  if (given && !reaches(actor.role, given)) return new AccountError("nobody grants a role above their own", 403);
  return null;
}

export const ONE_PERSON = "this orchestrator seals secrets with a key it made for one person, so it takes no second account; set ORCHESTRATOR_SECRET_KEY where it runs and restart it first";

/**
 * Holds an orchestrator that seals with a key it made for its one person to that one person: an
 * account past the first is refused, whether added by hand, by invitation, through single
 * sign-on or by SCIM. The key sits beside the database it seals, so with a second person it
 * would be a shared orchestrator's key, and the next start would leave it unused and what it sealed
 * unopened.
 */
export function oneAccountOnly(store: Pick<AccountStore, "insertUser" | "countUsers">, tenants: readonly string[], why = ONE_PERSON): void {
  const insert = store.insertUser.bind(store);
  store.insertUser = async (user) => {
    let accounts = 0;
    for (const tenant of tenants) accounts += await store.countUsers(tenant);
    if (accounts >= 1) throw new AccountError(why, 409);
    return insert(user);
  };
}

export const LOCAL_ONE_PERSON = "a local orchestrator is one person's, so it takes no second account and no service account; run it as a team's with ORCHESTRATOR_MODE=self-hosted to add people";

/**
 * Holds a local orchestrator to its one person, whatever key it seals with: no second account and
 * no service account, whose key would act beside them. What acts with that person's own sign-ins,
 * their Claude Code and their gh or glab, is then theirs alone by how it runs.
 */
export function localOnePerson(store: Pick<AccountStore, "insertUser" | "countUsers"> & Pick<KeyStore, "saveServiceAccount">, tenants: readonly string[]): void {
  oneAccountOnly(store, tenants, LOCAL_ONE_PERSON);
  store.saveServiceAccount = async () => {
    throw new AccountError(LOCAL_ONE_PERSON, 409);
  };
}

export async function createUser(
  store: AccountStore,
  tenant: string,
  knownTeams: Set<string>,
  input: { email?: unknown; name?: unknown; role?: unknown; password?: unknown; teams?: unknown; forgeLogin?: unknown },
  actor: Principal,
): Promise<UserRecord> {
  const email = normalizeEmail(input.email);
  const role = cleanRole(input.role);
  const refused = overreach(actor, "member", role);
  if (refused) throw refused;
  const teams = cleanTeams(input.teams, knownTeams);
  if (role === "viewer" && teams.length) throw new AccountError(VIEWER_OWNS_NONE);
  // Without a password the account signs in only through the identity provider.
  if (input.password !== undefined && input.password !== "") {
    const problem = passwordProblem(input.password);
    if (problem) throw new AccountError(problem);
  }
  if (await store.getUserByEmail(tenant, email)) throw new AccountError(`${email} already has an account`, 409);
  const user: UserRecord = {
    tenant,
    id: newId("usr"),
    email,
    name: cleanName(input.name, email),
    role,
    passwordHash: input.password ? await hashPassword(input.password as string) : null,
    oidcIssuer: null,
    oidcSubject: null,
    forgeLogin: cleanForgeLogin(input.forgeLogin),
    createdAt: new Date().toISOString(),
  };
  await store.insertUser(user);
  if (teams.length) await store.setOwnedTeams(tenant, user.id, teams);
  return user;
}

export async function updateUser(
  store: AccountStore,
  tenant: string,
  knownTeams: Set<string>,
  id: string,
  input: { name?: unknown; role?: unknown; password?: unknown; teams?: unknown; forgeLogin?: unknown },
  actor: Principal,
): Promise<string[]> {
  const user = await store.getUser(tenant, id);
  if (!user) throw new AccountError("no such account", 404);
  const role = input.role === undefined ? user.role : cleanRole(input.role);
  const refused = overreach(actor, user.role, role);
  if (refused) throw refused;
  if (role !== user.role && actor.id === id) throw new AccountError("nobody changes their own role; ask another owner", 403);
  const before = await store.ownedTeams(tenant, id);
  const patch: UserPatch = {};
  if (input.name !== undefined) patch.name = cleanName(input.name, user.email);
  if (input.forgeLogin !== undefined) patch.forgeLogin = cleanForgeLogin(input.forgeLogin);
  if (input.password !== undefined && input.password !== "") {
    const problem = passwordProblem(input.password);
    if (problem) throw new AccountError(problem);
    patch.passwordHash = await hashPassword(input.password as string);
  }
  const teams = input.teams === undefined ? null : cleanTeams(input.teams, knownTeams);
  if (role === "viewer" && (teams ?? (await store.ownedTeams(tenant, id))).length) throw new AccountError(VIEWER_OWNS_NONE);
  if (role !== user.role && !(await store.setRole(tenant, id, role))) {
    throw new AccountError("this is the only owner; make someone else an owner first", 409);
  }
  await store.updateUser(tenant, id, patch);
  if (teams) await store.setOwnedTeams(tenant, id, teams);
  if (patch.passwordHash) await store.deleteSessions(tenant, id);
  const after = await store.ownedTeams(tenant, id);
  // What changed, said for the event log. A password an owner or admin sets on an account that signed in
  // only through SSO gives it a second way in, so it is said there too.
  return [
    ...(role !== user.role ? [`role ${user.role} to ${role}`] : []),
    ...(before.join(",") !== after.join(",") ? [`owns ${after.join(", ") || "no team"}`] : []),
    ...(patch.name !== undefined && patch.name !== user.name ? [`name ${patch.name}`] : []),
    ...(patch.forgeLogin !== undefined && patch.forgeLogin !== user.forgeLogin ? [`forge login ${patch.forgeLogin ?? "removed"}`] : []),
    ...(patch.passwordHash ? [user.passwordHash ? "password replaced, its sessions signed out" : "a password set where there was none, its sessions signed out"] : []),
  ];
}

export async function removeUser(store: AccountStore, tenant: string, id: string, actor: Principal): Promise<UserRecord> {
  const user = await store.getUser(tenant, id);
  if (!user) throw new AccountError("no such account", 404);
  if (actor.id === id) throw new AccountError("leave the organization from your own settings instead", 409);
  const refused = overreach(actor, user.role);
  if (refused) throw refused;
  if (!(await store.deleteUser(tenant, id))) throw new AccountError("this is the only owner; it cannot be removed", 409);
  await markRemoved(store, tenant, user);
  return user;
}

/**
 * A person leaving the organization on their own. An owner cannot: another owner first changes
 * their role, which also keeps the last owner from leaving the organization with nobody in charge.
 */
export async function leave(store: AccountStore, user: Principal, tenant: string): Promise<void> {
  if (user.role === "owner") throw new AccountError("can't leave as owner; make another member an owner, and have them change your role", 409);
  if (!(await store.deleteUser(tenant, user.id))) throw new AccountError("this is the only owner; it cannot leave", 409);
}

/** Changing one's own name: the one field of an account its holder sets alone. */
export async function renameSelf(store: AccountStore, user: Principal, tenant: string, name: unknown): Promise<string> {
  if (user.key) throw new AccountError("an API key cannot change its account", 403);
  const text = typeof name === "string" ? name.trim() : "";
  if (!text) throw new AccountError("enter a name");
  const clean = cleanName(text, user.email);
  await store.updateUser(tenant, user.id, { name: clean });
  return clean;
}

/** What deleting one's account removes in one organization, read before anything is removed. */
export interface DeletionSummary {
  tenant: string;
  email: string;
  role: Role;
  ownedTeams: string[];
  activeKeys: number;
  openRequests: number;
  /** Tasks they started that have not ended; deleting the account does not stop them. */
  unfinishedTasks: { id: string; title: string; status: string }[];
  /** Why the account cannot be deleted here, or null when it can. */
  blocked: string | null;
}

export async function deletionSummary(store: Store, tenant: string, user: Principal): Promise<DeletionSummary> {
  const keys = await store.listKeys(tenant, { kind: "user", id: user.id });
  const now = new Date().toISOString();
  const lastOwner = user.role === "owner" && (await store.countOwners(tenant)) <= 1;
  return {
    tenant,
    email: user.email,
    role: user.role,
    ownedTeams: user.ownedTeams,
    activeKeys: keys.filter((k) => !k.revokedAt && (!k.expiresAt || k.expiresAt > now)).length,
    openRequests: (await store.listRequests(tenant)).filter((r) => r.createdBy === user.email && r.status === "open").length,
    unfinishedTasks: (await everyTask(store, tenant, { createdBy: [user.email], statuses: ["queued", "running", "interrupted"] })).map(({ id, title, status }) => ({ id, title, status })),
    blocked: lastOwner ? "you are the only owner here; make another member an owner first" : null,
  };
}

/**
 * Deleting one's own account in this organization, after its summary was shown: the address
 * typed back confirms it. Sessions, keys, team ownership and tags go with it; the requests and
 * tasks it started stay, under its address, since a team's history is the team's.
 */
export async function deleteSelf(store: AccountStore, tenant: string, user: Principal, confirm: unknown): Promise<void> {
  if (user.key) throw new AccountError("an API key cannot delete its account", 403);
  if (emailKey(confirm) !== user.email) throw new AccountError("type your email address to confirm");
  if (!(await store.deleteUser(tenant, user.id))) throw new AccountError("you are the only owner here; make another member an owner first", 409);
}

/** An account as the event log names whoever acted, before they hold a session. */
function personOf(user: UserRecord): EventActor {
  return { kind: "user", id: user.id, email: user.email, name: user.name };
}

/**
 * A person changing their own password proves the current one. An account without one signs
 * in through the identity provider, and adding a password to it would be a way in that
 * outlives the provider closing that account, so only an admin sets one.
 */
export async function changeOwnPassword(store: AccountStore, user: UserRecord, current: unknown, next: unknown, keepSession: string): Promise<void> {
  if (!user.passwordHash) throw new AccountError("this account signs in through single sign-on; an admin sets a password if it needs one", 403);
  if (typeof current !== "string" || !(await verifyPassword(current, user.passwordHash))) {
    throw new AccountError("the current password is not right", 403);
  }
  const problem = passwordProblem(next);
  if (problem) throw new AccountError(problem);
  await store.updateUser(user.tenant, user.id, { passwordHash: await hashPassword(next as string) });
  await store.deleteSessions(user.tenant, user.id, keepSession);
}

/**
 * Sign-in through the identity provider. A person is known by the provider's issuer and
 * subject, never by the address it reports: an address can be reassigned at the provider,
 * a subject cannot. There are two ways to a first sign-in:
 *
 * - an admin invited the address without a password, and the provider says it verified that
 *   address: the invitation is bound to this subject, once, and from then on the subject is
 *   what counts. The admin chose the address and the provider vouches for who holds it; an
 *   account with a password, or one already bound, is never taken over this way.
 * - nobody has the address and it has an unexpired invitation: the person joins with the role
 *   and teams the invitation names, and the invitation is used up;
 * - nobody has the address otherwise: the person becomes a member, because the provider decided
 *   they are let in, and only an owner or an admin raises a role.
 *
 * Neither happens before the first admin exists: on an empty orchestrator the setup code is the
 * only way in, so whoever the provider lets through first cannot close it.
 */
export async function signInWithOidc(
  store: AccountStore,
  tenant: string,
  identity: { issuer: string; subject: string; email?: string; name?: string },
): Promise<UserRecord> {
  if ((await store.countOwners(tenant)) === 0) throw new AccountError("this orchestrator has no owner yet; it is set up with the setup code first", 403);
  const known = await store.getUserByOidc(tenant, identity.issuer, identity.subject);
  if (known && (await suspended(store, tenant, known.id))) throw TURNED_OFF();
  if (known) return known;
  if (!identity.email) throw new AccountError("the identity provider did not share a verified email address", 403);
  const email = normalizeEmail(identity.email);
  const refused = new AccountError("this address cannot sign in with SSO here; ask an admin", 403);
  const existing = await store.getUserByEmail(tenant, email);
  if (existing) {
    if (existing.passwordHash || existing.oidcSubject) throw refused;
    if (await suspended(store, tenant, existing.id)) throw TURNED_OFF();
    await store.updateUser(tenant, existing.id, { oidcIssuer: identity.issuer, oidcSubject: identity.subject });
    return { ...existing, oidcIssuer: identity.issuer, oidcSubject: identity.subject };
  }
  const invited = await store.takeInviteByEmail(tenant, email, new Date().toISOString());
  if (invited) return joinAs(store, invited, { name: identity.name, oidcIssuer: identity.issuer, oidcSubject: identity.subject });
  if (await scimOn(store, tenant)) throw new AccountError("this organization's directory adds people; ask whoever runs it to assign you", 403);
  if (!(await joinsWithoutInvitation(store, tenant, email))) throw new AccountError("this address is not at a domain this organization verified; ask an owner or admin for an invitation", 403);
  const user: UserRecord = {
    tenant,
    id: newId("usr"),
    email,
    name: cleanName(identity.name, email),
    role: "member",
    passwordHash: null,
    oidcIssuer: identity.issuer,
    oidcSubject: identity.subject,
    forgeLogin: null,
    createdAt: new Date().toISOString(),
  };
  await store.insertUser(user);
  return user;
}

/** The account an invitation becomes, with the address, role and teams the inviter chose; refused when the address found an account some other way meanwhile. */
export async function joinAs(
  store: AccountStore,
  found: InviteRecord,
  how: { name?: unknown; passwordHash?: string; oidcIssuer?: string; oidcSubject?: string },
  now = new Date(),
): Promise<UserRecord> {
  if (await store.getUserByEmail(found.tenant, found.email)) throw new AccountError(`${found.email} already has an account; sign in instead`, 409);
  const user: UserRecord = {
    tenant: found.tenant,
    id: newId("usr"),
    email: found.email,
    name: cleanName(how.name, found.email),
    role: found.role,
    passwordHash: how.passwordHash ?? null,
    oidcIssuer: how.oidcIssuer ?? null,
    oidcSubject: how.oidcSubject ?? null,
    forgeLogin: null,
    createdAt: now.toISOString(),
  };
  await store.insertUser(user);
  if (found.teams.length) await store.setOwnedTeams(found.tenant, user.id, found.teams);
  return user;
}

/**
 * The provider's redirect back, checked in order: the state this browser started with is
 * the one returned, the stored sign-in it names is taken once, belongs to this tenant and
 * has not expired, and only then is the code exchanged and the ID token checked. Each
 * refusal leaves no session behind.
 */
export async function finishOidcSignIn(
  store: AccountStore,
  tenant: string,
  oidc: OidcClient,
  input: { state?: string; code?: string; cookieState?: string; userAgent?: string | null },
  now = new Date(),
): Promise<{ session: NewSession; user: UserRecord }> {
  const { state, code, cookieState } = input;
  if (!state || !code || !cookieState || cookieState !== state) throw new AccountError("the sign-in did not start in this browser; try again", 403);
  const login = await store.takeOidcLogin(state);
  if (!login || login.tenant !== tenant || login.expiresAt <= now.toISOString()) throw new AccountError("that sign-in expired; try again", 403);
  let identity: Awaited<ReturnType<OidcClient["finish"]>>;
  try {
    identity = await oidc.finish(code, login);
  } catch {
    throw new AccountError("the identity provider's answer did not check out", 403);
  }
  const user = await signInWithOidc(store, tenant, identity);
  // Once the directory provisions people it keeps their groups too; a sign-in no longer rewrites them.
  if (identity.groups && !(await scimOn(store, tenant))) await store.setMemberGroups(tenant, user.id, identity.groups);
  return { session: await startSession(store, tenant, user.id, now, input.userAgent ?? null), user };
}

function failure(c: Context, err: unknown) {
  if (err instanceof OrchestratorError) return errorAnswer(c, err);
  throw err;
}

function isJson(c: Context): boolean {
  return (c.req.header("content-type") ?? "").split(";")[0]!.trim() === "application/json";
}

/**
 * A request that signs someone in has no session yet, so no CSRF token to check. A
 * cross-site form can only send form encodings; requiring JSON makes the browser ask first,
 * and the orchestrator never says yes. An Origin that is present must be this orchestrator's own.
 */
export function crossSite(c: Context, publicUrl: string | undefined): boolean {
  if (!isJson(c)) return true;
  const origin = c.req.header("origin");
  if (!origin) return false;
  return origin !== new URL(publicUrl ?? c.req.url).origin;
}

export const CROSS_SITE =
  "sign-in is taken only from the orchestrator's own page; behind a proxy, set ORCHESTRATOR_PUBLIC_URL to the address people open";

export function setSessionCookie(c: Context, tenant: string, session: NewSession, secure: boolean): void {
  setCookie(c, sessionCookie(tenant, secure), session.token, {
    httpOnly: true,
    sameSite: "Strict",
    secure,
    path: "/",
    expires: new Date(session.cookieUntil),
  });
}

/**
 * The single sign-on state cookie, per tenant for the reason the session cookie is. Over https
 * it is a `__Host-` cookie, which a browser takes only for the whole host, so it lives at "/"
 * there; over plain http it stays on the sign-in paths.
 */
export function oidcStateCookie(tenant: string, secure = false): { name: string; path: string } {
  return { name: `${secure ? "__Host-" : ""}th_oidc_state_${tenantMark(tenant)}`, path: secure ? "/" : "/api/auth/oidc" };
}

export interface AuthOptions {
  setupCode?: string;
  oidc?: OidcClient | null;
  /** Addresses of the proxies in front of the orchestrator, whose X-Forwarded-For is believed. */
  trustedProxies?: string[];
}

function bare(address: string): string {
  return address.startsWith("::ffff:") ? address.slice(7) : address;
}

/**
 * Who sent a request, for counting. The connection's own address, unless it is a proxy the
 * operator named: then the last address that proxy appended to X-Forwarded-For that is not
 * itself a named proxy. A header from anyone else is ignored, since a client writes whatever
 * it likes there.
 */
export function clientAddress(remote: string | undefined, forwardedFor: string | undefined, trusted: string[]): string {
  const direct = remote ? bare(remote) : "unknown";
  if (!forwardedFor || !trusted.includes(direct)) return direct;
  const hops = forwardedFor.split(",").map((hop) => bare(hop.trim())).filter(Boolean);
  for (let i = hops.length - 1; i >= 0; i--) if (!trusted.includes(hops[i]!)) return hops[i]!;
  return direct;
}

/**
 * The key a client is counted under. An IPv6 address counts by its /64: one host is routinely
 * handed a whole /64, and counting each address in it would give it billions of fresh budgets.
 */
export function clientKey(address: string): string {
  if (!isIPv6(address)) return address;
  const [head = "", tail = ""] = address.split("::");
  const left = head ? head.split(":") : [];
  const right = address.includes("::") ? (tail ? tail.split(":") : []) : [];
  const groups = [...left, ...Array(8 - left.length - right.length).fill("0"), ...right];
  return `${groups.slice(0, 4).map((g) => parseInt(g, 16).toString(16)).join(":")}::/64`;
}

function remoteOf(c: Context): string | undefined {
  return (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming?.socket?.remoteAddress;
}

/** The key a request's client is counted under, believing X-Forwarded-For only from the named proxies. */
export function clientFrom(trustedProxies: string[]): (c: Context) => string {
  const trusted = trustedProxies.map(bare);
  return (c) => clientKey(clientAddress(remoteOf(c), c.req.header("x-forwarded-for"), trusted));
}

/** The routes that answer before anyone is signed in. */
export const LOCAL_SIGN_IN = "a local orchestrator makes its one owner itself and signs them in from the address its command prints";
const LOCAL_LINK_USED = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>TeamHandbook Orchestrator</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;font:16px/1.5 system-ui,sans-serif;background:#f6f6f4;color:#1d1d1b}main{max-width:32rem;padding:0 16px}code{background:#e8e8e4;padding:2px 6px;border-radius:4px}@media (prefers-color-scheme:dark){body{background:#1b1b1a;color:#ededea}code{background:#2e2e2c}}</style>
<main><h1>This sign-in address was used already</h1><p>A sign-in address works once. Open the sign-in page your command named, <code>open.html</code> in the orchestrator's data folder, in this browser: after each sign-in it holds a new address for five minutes. Later than that, run <code>handbook-orchestrator</code> again in a terminal on this machine for a new one.</p></main>`;

/**
 * What the address a local start opens answers: a button that signs in. Opening the address spends nothing, so a terminal's
 * or a browser's preview of it leaves it for the person; only the button's post, from the page in their browser, trades it.
 */
function localSignInPage(path: string, token: string): string {
  const quoted = (value: string) => value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="referrer" content="no-referrer"><title>TeamHandbook Orchestrator</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;font:16px/1.5 system-ui,sans-serif;background:#f6f6f4;color:#1d1d1b}main{max-width:32rem;padding:0 16px}button{font:inherit;padding:8px 16px;border-radius:6px;border:0;background:#1d1d1b;color:#f6f6f4;cursor:pointer}@media (prefers-color-scheme:dark){body{background:#1b1b1a;color:#ededea}button{background:#ededea;color:#1b1b1a}}</style>
<main><h1>Open TeamHandbook Orchestrator</h1><p>This address signs you in to the orchestrator on this machine, once.</p><form method="post" action="${quoted(path)}"><input type="hidden" name="token" value="${quoted(token)}"><button type="submit" autofocus>Continue</button></form></main>`;
}

export const CLOUD_SIGN_IN = "this orchestrator signs people in with Google, GitHub or Microsoft; it takes no setup code or password";

export function authRoutes(ctx: OrchestratorContext, options: AuthOptions): Hono {
  const app = new Hono();
  const store = ctx.store;
  const secure = secureOrchestrator(ctx.publicUrl);
  const from = clientFrom(options.trustedProxies ?? []);
  // Counted per address signed in to and per client. A client trying many addresses meets the
  // second count; one client hammering cannot lock anyone else out of setup or SSO, because
  // those count per client, with a ceiling for all clients together set far above any real use.
  const attempts = windowLimiter(10);
  const perClient = windowLimiter(30);
  // Each SSO start writes a row that a callback takes or nobody does; rows expire in ten
  // minutes and are purged, and these keep anonymous callers from filling the table.
  const startsPerClient = windowLimiter(10);
  const startsInAll = windowLimiter(600);
  // A cloud orchestrator's people sign in with a provider and create their own organizations: no
  // setup code makes an owner and no password opens an account.
  const cloud = cloudMode();
  const local = localMode();
  const legal = legalLinks();

  app.get("/api/auth/config", async (c) =>
    c.json({ setupNeeded: !cloud && !local && (await store.countOwners(ctx.tenant)) === 0, sso: Boolean(options.oidc), ...legal }),
  );

  route(app, "GET /api/auth/local", async (c) => {
    if (!local) return c.json({ error: "this orchestrator is not a local one" }, 404);
    c.header("Cache-Control", "no-store");
    c.header("Referrer-Policy", "no-referrer");
    const token = c.req.query("token") ?? "";
    if (!(await localLinkOpen(store, ctx.tenant, token))) return c.html(LOCAL_LINK_USED, 410);
    return c.html(localSignInPage(c.req.path, token));
  });

  route(app, "POST /api/auth/local", async (c) => {
    if (!local) return c.json({ error: "this orchestrator is not a local one" }, 404);
    c.header("Cache-Control", "no-store");
    c.header("Referrer-Policy", "no-referrer");
    const form = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>);
    const token = typeof form.token === "string" ? form.token : "";
    const session = await exchangeLocalLink(store, ctx.tenant, token, new Date(), agentOf(c.req.header("user-agent")));
    if (!session) return c.html(LOCAL_LINK_USED, 410);
    setSessionCookie(c, ctx.tenant, session, secure);
    // The browser the start opened spends the page's address; a new one there lets the person's other browser in too.
    // A page that cannot be written leaves this sign-in as it is.
    await ctx.localSignedIn?.().catch(() => undefined);
    return c.redirect(ctx.webBase ?? "/", 303);
  });

  // A local orchestrator signs its one person in from the address its command prints, so its pages offer no sign-in form;
  // a self-hosted one signs people in per organization. Either says so plainly, so no page logs a failed request for it.
  route(app, "GET /api/identity/config", (c) => c.json({ mode: localMode() ? "local" : "self-hosted" }));

  app.post("/api/auth/setup", async (c) => {
    if (cloud) return c.json({ error: CLOUD_SIGN_IN }, 403);
    if (local) return c.json({ error: LOCAL_SIGN_IN }, 403);
    if (crossSite(c, ctx.publicUrl)) return c.json({ error: CROSS_SITE }, 403);
    const verdict = perClient(`setup:${from(c)}`);
    if (!verdict.ok) return tooMany(c, verdict, "too many attempts; wait a minute");
    try {
      const user = await setupFirstOwner(store, ctx.tenant, options.setupCode, await c.req.json().catch(() => ({})));
      await recordEvent(ctx, personOf(user), "orchestrator.setup", { subject: `account:${user.id}`, detail: "created the first owner with the setup code" });
      setSessionCookie(c, ctx.tenant, await startSession(store, ctx.tenant, user.id, new Date(), agentOf(c.req.header("user-agent"))), secure);
      return c.json({ ok: true });
    } catch (err) {
      return failure(c, err);
    }
  });

  app.post("/api/auth/login", async (c) => {
    if (cloud) return c.json({ error: CLOUD_SIGN_IN }, 403);
    if (local) return c.json({ error: LOCAL_SIGN_IN }, 403);
    if (crossSite(c, ctx.publicUrl)) return c.json({ error: CROSS_SITE }, 403);
    const body = (await c.req.json().catch(() => ({}))) as { email?: unknown; password?: unknown };
    // The refusal that held this sign-in back, for the wait the answer gives.
    let held: Verdict | null = null;
    const allow = (key: string) => {
      for (const verdict of [perClient(`login:${from(c)}`), attempts(key)]) if (!verdict.ok) held = verdict;
      return held === null;
    };
    try {
      const user = await signInWithPassword(store, ctx.tenant, body.email, body.password, allow, Boolean(options.oidc));
      await recordEvent(ctx, personOf(user), "account.signin", { subject: `account:${user.id}`, detail: "signed in with a password" });
      setSessionCookie(c, ctx.tenant, await startSession(store, ctx.tenant, user.id, new Date(), agentOf(c.req.header("user-agent"))), secure);
      return c.json({ ok: true });
    } catch (err) {
      if (held) c.header("Retry-After", String((held as Verdict).retryAfter));
      return failure(c, err);
    }
  });

  app.get("/api/auth/oidc/start", async (c) => {
    if (!options.oidc) return c.json({ error: "single sign-on is not configured" }, 404);
    const verdicts = [startsPerClient(from(c)), startsInAll("all")];
    const refused = verdicts.find((v) => !v.ok);
    if (refused) return tooMany(c, refused, "too many sign-ins are starting; wait a minute");
    await store.purgeExpired(new Date().toISOString());
    let start: Awaited<ReturnType<OidcClient["start"]>>;
    try {
      start = await options.oidc.start();
    } catch {
      return c.json({ error: "the identity provider did not answer; try again in a moment" }, 502);
    }
    await store.saveOidcLogin({ ...start.login, tenant: ctx.tenant });
    // Lax, not Strict: this cookie has to come back on the provider's redirect, which is a
    // cross-site navigation. It carries only the state, which is useless without the store row.
    const state = oidcStateCookie(ctx.tenant, secure);
    setCookie(c, state.name, start.login.state, { httpOnly: true, sameSite: "Lax", secure, path: state.path, maxAge: 600 });
    return c.redirect(start.url, 302);
  });

  app.get("/api/auth/oidc/callback", async (c) => {
    const home = ctx.webBase ?? "/";
    const back = (problem: string) => c.redirect(`${home}#/login?problem=${encodeURIComponent(problem)}`, 302);
    if (!options.oidc) return back("single sign-on is not configured");
    const state = oidcStateCookie(ctx.tenant, secure);
    const cookieState = getCookie(c, state.name);
    deleteCookie(c, state.name, { path: state.path, secure });
    try {
      const { session, user } = await finishOidcSignIn(store, ctx.tenant, options.oidc, { state: c.req.query("state"), code: c.req.query("code"), cookieState, userAgent: agentOf(c.req.header("user-agent")) });
      await recordEvent(ctx, personOf(user), "account.signin", { subject: `account:${user.id}`, detail: "signed in through single sign-on" });
      setSessionCookie(c, ctx.tenant, session, secure);
      return c.redirect(home, 302);
    } catch (err) {
      return back(err instanceof AccountError ? err.message : "the identity provider's answer did not check out");
    }
  });

  return app;
}

/** Routes for a signed-in person: themselves, and for an admin, everyone. */
export function accountRoutes(ctx: OrchestratorContext): Hono<OrchestratorEnv> {
  const app = new Hono<OrchestratorEnv>();
  const store = ctx.store;
  const secure = secureOrchestrator(ctx.publicUrl);
  const knownTeams = async () => new Set((await store.listRepos(ctx.tenant)).map((r) => r.team));
  // What every signed-in page links at its foot, read with the session so the page asks once.
  const legal = legalLinks();
  // On a cloud orchestrator an account is a membership of an identity: it comes by invitation and signs in with its provider.
  const cloud = cloudMode();
  const managers = (c: Context<OrchestratorEnv>) => (manages(c.get("user")) ? null : c.json({ error: "only an owner or an admin manages members" }, 403));

  // A team's or the cloud's orchestrator that takes machines' calls offers to connect one; a local
  // one runs its person's tasks with its own runner, so it shows no machines to connect.
  const runners = (ctx.mode ?? "self-hosted") !== "local" && Boolean(ctx.runnerService);
  // Whether a task runs on this orchestrator's own machine: a local one's own runner, or a team's
  // server told to with ORCHESTRATOR_SERVER_TASKS=1. The first screen offers a folder here, and
  // otherwise to connect the person's computer.
  const tasksRunHere = (ctx.mode ?? "self-hosted") === "local" || process.env.ORCHESTRATOR_SERVER_TASKS === "1";
  // A repository is connected by a path on the server only under ORCHESTRATOR_LOCAL_REPOS_ROOT; without it the form offers no such choice.
  const pathRepos = Boolean(ctx.localReposRoot);
  app.get("/api/me", async (c) => c.json({ user: { ...c.get("user"), mode: ctx.mode ?? "self-hosted", runners, tasksRunHere, pathRepos, plan: await shownPlan(ctx), keyCeiling: keyCeiling(c.get("user")) }, csrf: c.get("csrf"), legal }));

  app.post("/api/auth/logout", async (c) => {
    // On a cloud orchestrator the one session is the person's, for every organization: signing out ends it.
    if (cloud) {
      const identity = await identitySessionOf(c, store, secure);
      if (identity) await store.deleteIdentitySession(identity.tokenHash);
      deleteCookie(c, identityCookie(secure), { path: "/", secure });
    }
    const token = getCookie(c, sessionCookie(ctx.tenant, secure));
    if (token) await store.deleteSession(hashToken(token));
    await recordEvent(ctx, c.get("user"), "account.signout", { subject: `account:${c.get("user").id}`, detail: "signed out" });
    deleteCookie(c, sessionCookie(ctx.tenant, secure), { path: "/", secure });
    return c.json({ ok: true });
  });

  // Where this person is signed in, and ending one of those sessions. On a cloud orchestrator the
  // sessions are the person's own, for every organization; elsewhere this organization's.
  route(app, "GET /api/me/sessions", async (c) => {
    if (cloud) {
      const current = await identitySessionOf(c, store, secure);
      return c.json({ sessions: current ? await store.listIdentitySessions(current.identityId, current.tokenHash) : [] });
    }
    const token = getCookie(c, sessionCookie(ctx.tenant, secure));
    return c.json({ sessions: await store.listSessions(ctx.tenant, c.get("user").id, token ? hashToken(token) : undefined) });
  });

  route(app, "DELETE /api/me/sessions/:id", async (c) => {
    const id = c.req.param("id") ?? "";
    const current = cloud ? await identitySessionOf(c, store, secure) : null;
    const ended = cloud ? Boolean(current) && (await store.deleteIdentitySessionById(current!.identityId, id)) : await store.deleteSessionById(ctx.tenant, c.get("user").id, id);
    if (!ended) return c.json({ error: "no session of yours has that id" }, 404);
    await recordEvent(ctx, c.get("user"), "account.session-ended", { subject: `account:${c.get("user").id}`, detail: "ended one of their sessions" });
    return c.json({ ok: true });
  });

  route(app, "GET /api/me/apps", async (c) => c.json({ apps: await grantsOf(ctx, c.get("user").id) }));

  route(app, "DELETE /api/me/apps/:id", async (c) => {
    const clientName = await revokeGrant(ctx, c.get("user").id, c.req.param("id") ?? "");
    if (!clientName) return c.json({ error: "no app of yours has that id" }, 404);
    await recordEvent(ctx, c.get("user"), "oauth.revoked", { subject: "oauth", detail: `took back ${clientName}'s access to the orchestrator's MCP server` });
    return c.json({ ok: true });
  });

  const DIRECTORY_LABEL: Record<string, string> = { google: "Google Workspace", microsoft: "Microsoft" };

  route(app, "GET /api/directory-join", async (c) => {
    if (!cloud) return c.json({ error: "joining by directory is a cloud orchestrator's" }, 404);
    if (!manages(c.get("user"))) return c.json({ error: "only an owner or an admin reads who joins the organization" }, 403);
    const session = await identitySessionOf(c, store, secure);
    const yours = session?.domain && DIRECTORY_LABEL[session.method] ? { provider: session.method, directory: session.domain } : null;
    return c.json({ join: await directoryJoinOf(store, ctx.tenant), yours });
  });

  route(app, "PUT /api/directory-join", async (c) => {
    if (!cloud) return c.json({ error: "joining by directory is a cloud orchestrator's" }, 404);
    try {
      const join = await setDirectoryJoin(store, ctx.tenant, c.get("user"), await identitySessionOf(c, store, secure), await c.req.json().catch(() => ({})));
      const detail = join ? `let people in the ${DIRECTORY_LABEL[join.provider]} directory ${join.directory} join as ${join.role}` : "stopped letting a directory join";
      await recordEvent(ctx, c.get("user"), "org.directory-join", { subject: `org:${ctx.tenant}`, detail });
      return c.json({ join });
    } catch (err) {
      return failure(c, err);
    }
  });

  app.patch("/api/me", async (c) => {
    try {
      const body = (await c.req.json().catch(() => ({}))) as { name?: unknown };
      const name = await renameSelf(store, c.get("user"), ctx.tenant, body.name);
      await recordEvent(ctx, c.get("user"), "account.changed", { subject: `account:${c.get("user").id}`, detail: `${c.get("user").email}: name ${name}` });
      return c.json({ user: { ...c.get("user"), name } });
    } catch (err) {
      return failure(c, err);
    }
  });

  app.get("/api/me/deletion", async (c) => c.json({ summary: await deletionSummary(store, ctx.tenant, c.get("user")) }));

  app.post("/api/me/deletion", async (c) => {
    try {
      const body = (await c.req.json().catch(() => ({}))) as { confirm?: unknown };
      const user = c.get("user");
      const summary = await deletionSummary(store, ctx.tenant, user);
      await deleteSelf(store, ctx.tenant, user, body.confirm);
      await recordEvent(ctx, user, "account.deleted", {
        subject: `account:${user.id}`,
        detail: `${user.email} deleted their own account, which was ${user.role}${summary.ownedTeams.length ? ` owning ${summary.ownedTeams.join(", ")}` : ""}, with ${summary.activeKeys} active key${summary.activeKeys === 1 ? "" : "s"}`,
      });
      deleteCookie(c, sessionCookie(ctx.tenant, secure), { path: "/", secure });
      return c.json({ ok: true });
    } catch (err) {
      return failure(c, err);
    }
  });

  app.post("/api/me/leave", async (c) => {
    try {
      await leave(store, c.get("user"), ctx.tenant);
      await recordEvent(ctx, c.get("user"), "account.left", { subject: `account:${c.get("user").id}`, detail: "left the organization" });
      deleteCookie(c, sessionCookie(ctx.tenant, secure), { path: "/", secure });
      return c.json({ ok: true });
    } catch (err) {
      return failure(c, err);
    }
  });

  app.post("/api/me/password", async (c) => {
    if (cloud) return c.json({ error: CLOUD_SIGN_IN }, 403);
    const user = await store.getUser(ctx.tenant, c.get("user").id);
    if (!user) return c.json({ error: "sign in first" }, 401);
    const body = (await c.req.json().catch(() => ({}))) as { current?: unknown; next?: unknown };
    try {
      await changeOwnPassword(store, user, body.current, body.next, hashToken(getCookie(c, sessionCookie(ctx.tenant, secure)) ?? ""));
      await recordEvent(ctx, c.get("user"), "account.password", { subject: `account:${user.id}`, detail: "changed their own password; their other sessions signed out" });
      return c.json({ ok: true });
    } catch (err) {
      return failure(c, err);
    }
  });

  app.get("/api/teams", async (c) => {
    const repos = await store.listRepos(ctx.tenant);
    const users = await store.listUsers(ctx.tenant);
    const owners = await store.teamOwners(ctx.tenant);
    const restricted = new Set(await restrictedTeamsOf(store, ctx.tenant));
    const teams = [...new Set(repos.map((r) => r.team))].sort().map((team) => ({
      team,
      repos: repos.filter((r) => r.team === team).map((r) => r.id),
      owners: owners
        .filter((o) => o.team === team)
        .flatMap((o) => users.filter((u) => u.id === o.userId).map((u) => ({ id: u.id, name: u.name }))),
      canEdit: canEditTeam(c.get("user"), team),
      restricted: restricted.has(team),
    }));
    return c.json({ teams });
  });

  // Keeping a team's tasks to its owners, or opening them to every member again. Whoever edits the team decides.
  app.put("/api/teams/:team/restricted", async (c) => {
    const team = c.req.param("team");
    if (!(await store.listRepos(ctx.tenant)).some((r) => r.team === team)) return c.json({ error: "no connected repository belongs to that team" }, 404);
    if (!canEditTeam(c.get("user"), team)) return c.json({ error: `only an owner or an admin of the organization, or an owner of ${team}, changes who starts tasks on it` }, 403);
    const { restricted } = (await c.req.json().catch(() => ({}))) as { restricted?: unknown };
    if (typeof restricted !== "boolean") return c.json({ error: "restricted is true or false" }, 400);
    if (restricted) await store.setSetting(ctx.tenant, restrictedKey(team), "1");
    else await store.deleteSetting(ctx.tenant, restrictedKey(team));
    await recordEvent(ctx, c.get("user"), "team.restricted", { subject: `team:${team}`, detail: restricted ? `${team}: tasks only by its owners` : `${team}: tasks by every member` });
    return c.json({ team, restricted });
  });

  // One member's page: their role and teams, and what they opened and started here. Owners and
  // admins open anyone's; everyone opens their own.
  app.get("/api/members/:id", async (c) => {
    const me = c.get("user");
    const id = c.req.param("id");
    if (id !== me.id && !manages(me)) return c.json({ error: "only an owner or an admin opens another member's page" }, 403);
    const member = (await listUserViews(store, ctx.tenant)).find((u) => u.id === id);
    if (!member) return c.json({ error: "no such member" }, 404);
    const requests = (await store.listRequests(ctx.tenant)).filter((r) => r.createdBy === member.email).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const tasks = (await store.taskPage(ctx.tenant, { createdBy: [member.email] }, null, MEMBER_PAGE_ROWS)).tasks;
    const taskTotal = (await store.taskSpendRows(ctx.tenant, { createdBy: [member.email] })).reduce((n, r) => n + r.tasks, 0);
    return c.json({
      member,
      tags: (await memberTags(store, ctx.tenant)).get(member.id) ?? [],
      requests: requests.slice(0, MEMBER_PAGE_ROWS),
      tasks: tasks.map(({ id, repoId, title, status, createdAt, requestNumber }) => ({ id, repoId, title, status, createdAt, requestNumber })),
      totals: { requests: requests.length, tasks: taskTotal },
    });
  });

  app.get("/api/users", async (c) => managers(c) ?? c.json({ users: await listUserViews(store, ctx.tenant) }));

  app.post("/api/users", async (c) => {
    const refused = managers(c);
    if (refused) return refused;
    if (cloud) return c.json({ error: "on a cloud orchestrator people join by invitation; invite them from Members" }, 403);
    try {
      const user = await createUser(store, ctx.tenant, await knownTeams(), await c.req.json().catch(() => ({})), c.get("user"));
      const view = (await listUserViews(store, ctx.tenant)).find((u) => u.id === user.id)!;
      await recordEvent(ctx, c.get("user"), "account.created", {
        subject: `account:${user.id}`,
        detail: `${user.email} as ${user.role}${view.ownedTeams.length ? ` of ${view.ownedTeams.join(", ")}` : ""}, signing in ${view.signIn.length ? `with ${view.signIn.join(" and ")}` : "through single sign-on once invited"}`,
      });
      return c.json({ user: view });
    } catch (err) {
      return failure(c, err);
    }
  });

  app.patch("/api/users/:id", async (c) => {
    const refused = managers(c);
    if (refused) return refused;
    try {
      const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
      if (cloud && body.password !== undefined) return c.json({ error: CLOUD_SIGN_IN }, 403);
      const changed = await updateUser(store, ctx.tenant, await knownTeams(), c.req.param("id"), body, c.get("user"));
      const view = (await listUserViews(store, ctx.tenant)).find((u) => u.id === c.req.param("id"))!;
      if (changed.length) await recordEvent(ctx, c.get("user"), "account.changed", { subject: `account:${view.id}`, detail: `${view.email}: ${changed.join("; ")}` });
      return c.json({ user: view });
    } catch (err) {
      return failure(c, err);
    }
  });

  app.delete("/api/users/:id", async (c) => {
    const refused = managers(c);
    if (refused) return refused;
    try {
      const removed = await removeUser(store, ctx.tenant, c.req.param("id"), c.get("user"));
      await recordEvent(ctx, c.get("user"), "account.removed", { subject: `account:${removed.id}`, detail: `${removed.email}, who was ${removed.role}` });
      return c.json({ ok: true });
    } catch (err) {
      return failure(c, err);
    }
  });

  return app;
}
