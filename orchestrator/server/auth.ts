import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Context, MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import type { AccountStore, UserRecord } from "./accounts.js";
import { principalOf, renewedExpiry } from "./accounts.js";
import { bearerOf, findKey, handlerPattern, keyAuth, keyPrincipal } from "./keys.js";
import { suspended } from "./scim.js";
import type { KeyGrant } from "./keys.js";
import type { Store } from "./store.js";
import { cloudMemberOf, identitySessionOf } from "./cloud-identity.js";
import type { IdentityStore } from "./identities.js";
import { cloudMode, localMode } from "./mode.js";

/**
 * Who may do what in an organization. An owner has full control: grants the owner role and is
 * the only one who changes or removes another owner. An admin manages members, service accounts
 * and settings. A member reads. Owning a team is apart from the role: whoever owns a team
 * proposes changes to, merges requests in and starts tasks on that team's repositories.
 */
export type Role = "owner" | "admin" | "member" | "viewer";

export const ROLES: Role[] = ["owner", "admin", "member", "viewer"];

const RANK: Record<Role, number> = { owner: 2, admin: 1, member: 0, viewer: -1 };

/** Whether `a` reaches at least as high as `b`; nobody grants or touches a role above their own. */
export function reaches(a: Role, b: Role): boolean {
  return RANK[a] >= RANK[b];
}

export interface Principal {
  id: string;
  name: string;
  email: string;
  role: Role;
  /** Teams this person owns, whatever their role. */
  ownedTeams: string[];
  /** Their login on the team's forge, used to assign them the requests they open. */
  forgeLogin?: string;
  /** Set when the request came with an API key: what that key may reach. */
  key?: KeyGrant;
  /**
   * The organization's teams that only their owners start tasks on, read with the account. Every
   * member of an organization starts tasks on its other teams. Left out, nothing is known of it,
   * and only a team's owners and the organization's owners and admins start there.
   */
  restrictedTeams?: string[];
}

export type OrchestratorEnv = { Variables: { user: Principal; csrf: string } };

/** Owners and admins manage the organization: people, repositories, forge access and settings. */
export function manages(user: Principal): boolean {
  return user.role === "owner" || user.role === "admin";
}

export function canEditTeam(user: Principal, team: string): boolean {
  return manages(user) || user.ownedTeams.includes(team);
}

/**
 * The session cookie's name for one tenant's orchestrator. A browser sends a host's cookies to every
 * port of it, so orchestrators of two tenants on one host sharing a name would sign each other out:
 * signing in to the second replaced the first's cookie. The name carries the tenant, hashed so
 * any tenant name makes a valid cookie name. Over https it carries `__Host-` as well, which a
 * browser accepts only from this host, over https, for every path: a sibling subdomain or a
 * plain-http page on the network cannot plant a session of its choosing under the name.
 */
export function sessionCookie(tenant: string, secure = false): string {
  return `${secure ? "__Host-" : ""}th_session_${tenantMark(tenant)}`;
}

/** Whether people reach this orchestrator over https, which decides the cookies' Secure flag and `__Host-` names. */
export function secureOrchestrator(publicUrl: string | undefined): boolean {
  return (publicUrl ?? "").startsWith("https://");
}

/** A short, fixed mark of a tenant's name, for names a browser keeps per host. */
export function tenantMark(tenant: string): string {
  return createHash("sha256").update(tenant).digest("hex").slice(0, 12);
}
export const CSRF_HEADER = "x-csrf-token";

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function newToken(): string {
  return randomBytes(32).toString("base64url");
}

function sameToken(a: string | undefined, b: string): boolean {
  if (!a) return false;
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

const SAFE = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * A browser attaches the session cookie to a request any site makes, so a request that
 * changes something has to carry what only this orchestrator's own page can read: the CSRF token
 * /api/me hands out, sent back in a header. A cross-site form cannot set a header, and the
 * orchestrator answers no CORS preflight that would let a script do it.
 */
export function csrfRefusal(c: Context, expected: string): Response | null {
  if (SAFE.has(c.req.method)) return null;
  if (sameToken(c.req.header(CSRF_HEADER), expected)) return null;
  return c.json({ error: "this change did not come from the orchestrator's own page; reload it and try again" }, 403);
}

/** Who everyone is on an orchestrator run with ORCHESTRATOR_AUTH=dev-admin: no account, only this. */
export const DEV_ADMIN: Principal = { id: "dev", name: "Orchestrator Admin", email: "admin@orchestrator.invalid", role: "owner", ownedTeams: [] };

/**
 * The built-in admin for a demo on one machine. It is refused unless the operator asked for
 * it by name: an orchestrator that silently let everyone be an admin would be the first thing
 * exposed. Its CSRF token is drawn once per process, so the rule above holds here too.
 */
export function devPrincipalAuth(): MiddlewareHandler<OrchestratorEnv> {
  const csrf = newToken();
  return async (c, next) => {
    if (process.env.ORCHESTRATOR_AUTH !== "dev-admin") return c.json({ error: "sign-in is not configured" }, 401);
    const refused = csrfRefusal(c, csrf);
    if (refused) return refused;
    c.set("user", DEV_ADMIN);
    c.set("csrf", csrf);
    await next();
  };
}

/**
 * A signed-in person, read from the store on every request: a role taken away or an account
 * removed takes effect on that person's very next call, not when their session ends.
 */
export function sessionAuth(store: AccountStore & IdentityStore, tenant: string, secure = false): MiddlewareHandler<OrchestratorEnv> {
  return async (c, next) => {
    const signedIn = await sessionOf(c, store, tenant, secure);
    if (!signedIn) return c.json({ error: "sign in first" }, 401);
    const refused = csrfRefusal(c, signedIn.csrf);
    if (refused) return refused;
    const principal = await principalOf(store, signedIn.user);
    if (principal.role === "viewer" && viewerRefused(c)) return c.json({ error: "a viewer reads the organization and changes nothing in it" }, 403);
    c.set("user", principal);
    c.set("csrf", signedIn.csrf);
    await next();
  };
}

/**
 * What a viewer changes: their own account, sign-in and keys, their own MCP servers, and nothing
 * of the organization's. Every other change is refused before its handler runs, so a route added
 * later is read-only to viewers until it is listed here.
 */
const VIEWER_CHANGES = new Set([
  "POST /api/auth/logout",
  "PATCH /api/me",
  "POST /api/me/password",
  "POST /api/me/leave",
  "POST /api/me/deletion",
  "POST /api/keys",
  "DELETE /api/keys/:id",
  "DELETE /api/me/sessions/:id",
  "DELETE /api/me/apps/:id",
  "POST /api/me/mcp-servers",
  "PATCH /api/me/mcp-servers/:name",
  "DELETE /api/me/mcp-servers/:name",
  "POST /api/me/mcp-servers/:name/connect",
  "POST /api/me/mcp-servers/:name/disconnect",
]);

function viewerRefused(c: Context): boolean {
  if (SAFE.has(c.req.method)) return false;
  const pattern = handlerPattern(c);
  return pattern === undefined || !VIEWER_CHANGES.has(`${c.req.method} ${pattern}`);
}

/** When each session was last marked seen by this node; a session is marked at most once a minute, not on every request. */
const lastSeen = new Map<string, number>();
const SEEN_MS = 60_000;

export async function seen(tokenHash: string, touch: (at: string) => Promise<void>, now = Date.now()): Promise<void> {
  if ((lastSeen.get(tokenHash) ?? 0) > now - SEEN_MS) return;
  lastSeen.delete(tokenHash);
  lastSeen.set(tokenHash, now);
  if (lastSeen.size > 10_000) lastSeen.delete(lastSeen.keys().next().value!);
  await touch(new Date(now).toISOString());
}

/** The account this browser's session cookie for `tenant` signs in, or null when it signs in none. */
export async function sessionOf(c: Context, store: AccountStore & IdentityStore, tenant: string, secure = false): Promise<{ user: UserRecord; csrf: string } | null> {
  if (cloudMode()) {
    const identity = await identitySessionOf(c, store, secure);
    const member = identity ? await cloudMemberOf(store, tenant, identity) : null;
    return member && identity ? { user: member, csrf: identity.csrf } : null;
  }
  const token = getCookie(c, sessionCookie(tenant, secure));
  const session = token ? await store.getSession(hashToken(token)) : null;
  if (!session || session.tenant !== tenant || session.expiresAt <= new Date().toISOString()) return null;
  const user = await store.getUser(tenant, session.userId);
  if (!user || (await suspended(store, tenant, user.id))) return null;
  await seen(session.tokenHash, (at) => store.touchSession(session.tokenHash, at, renewedExpiry({ expiresAt: session.expiresAt, startedAt: session.createdAt }, at)));
  return { user, csrf: session.csrf };
}

/**
 * Whether whoever opened a long-lived request still holds what let them in: the same account
 * through a session not ended, or a key not revoked or expired whose account is still there. Read
 * from the store, so a stream held on another node of the orchestrator ends as well. A task's live
 * stream asks this every few seconds and closes on false: removing a member, the directory
 * turning them off or revoking a key reaches a stream opened before.
 */
export async function stillAuthorized(c: Context<OrchestratorEnv>, store: Store, tenant: string, secure = false): Promise<boolean> {
  const user = c.get("user");
  if (user.key) {
    const key = await findKey(store, tenant, bearerOf(c) ?? "");
    return Boolean(key && key.id === user.key.id && (await keyPrincipal(store, key)));
  }
  if (process.env.ORCHESTRATOR_AUTH === "dev-admin") return true;
  const signedIn = await sessionOf(c, store, tenant, secure);
  return signedIn?.user.id === user.id;
}

export const LOOPBACK_HOSTS = ["127.0.0.1", "localhost", "[::1]"];

/**
 * The host names this orchestrator answers to, or null for any. Under dev-admin everyone is an
 * admin to whoever reaches the port, and binding it to 127.0.0.1 does not stop a page that
 * re-resolves its own domain to 127.0.0.1 (DNS rebinding): that page's requests carry its own
 * host name, so only the loopback names are answered. One person's orchestrator on their own machine
 * listens on loopback alone and answers only those names too, whatever is listed: any page they open
 * could otherwise re-resolve its domain to it and call its open routes. Elsewhere the list is opt-in.
 */
export function allowedHosts(mode: AuthMode, listed: string | undefined = process.env.ORCHESTRATOR_ALLOWED_HOSTS, onThisMachine = localMode()): string[] | null {
  if (mode === "dev-admin" || onThisMachine) return LOOPBACK_HOSTS;
  const hosts = (listed ?? "").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);
  return hosts.length ? hosts : null;
}

export function hostGuard(hosts: string[]): MiddlewareHandler {
  return async (c, next) => {
    if (!hosts.includes(new URL(c.req.url).hostname.toLowerCase())) return c.json({ error: "this orchestrator does not answer to that host name" }, 421);
    await next();
  };
}

export type AuthMode = "local" | "dev-admin";

/** ORCHESTRATOR_AUTH, read strictly: a value the orchestrator does not know stops it rather than picking a mode. */
export function authMode(value: string | undefined = process.env.ORCHESTRATOR_AUTH): AuthMode {
  if (value === undefined || value === "" || value === "local") return "local";
  if (value === "dev-admin") return "dev-admin";
  throw new Error(`ORCHESTRATOR_AUTH=${JSON.stringify(value)} is not a mode this orchestrator knows; use local (the default) or dev-admin`);
}

/**
 * A request with an API key is read as that key and nothing else, whatever cookie came with it;
 * one without is a browser session. Keys need accounts, so dev-admin takes none.
 */
export function orchestratorAuth(store: Store, tenant: string, mode: AuthMode = authMode(), secure = false): MiddlewareHandler<OrchestratorEnv> {
  const keys = keyAuth(store, tenant);
  const session = mode === "dev-admin" ? devPrincipalAuth() : sessionAuth(store, tenant, secure);
  return async (c, next) => {
    if (bearerOf(c) === null) return session(c, next);
    if (mode === "dev-admin") return c.json({ error: "API keys need accounts; this orchestrator runs as dev-admin" }, 401);
    return keys(c, next);
  };
}
