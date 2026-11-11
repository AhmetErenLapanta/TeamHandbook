import { matchedRoutes } from "hono/route";
import { routeNeed } from "./route-scopes.js";
import type { RouteNeed } from "./route-scopes.js";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { newId } from "./ids.js";
import { Hono } from "hono";
import type { Context, MiddlewareHandler } from "hono";
import type { OrchestratorContext } from "./app.js";
import { AccountError, cleanTeams, overreach, principalOf } from "./accounts.js";
import type { AccountStore } from "./accounts.js";
import { manages } from "./auth.js";
import { keyRefused } from "./domains.js";
import { recordEvent } from "./events.js";
import { limitKeyCall, noteLimited, PER_ACCOUNT_PER_MINUTE, PER_KEY_PER_MINUTE, tooMany } from "./limits.js";
import type { OrchestratorEnv, Principal, Role } from "./auth.js";
import type { Store } from "./store.js";

/**
 * API keys and service accounts. A key acts as the member or service account it belongs to,
 * read again on every request, so a member's key shrinks with their role and stops with their
 * account. On top of that it reaches only the resources its scopes name, and only the routes
 * mapped below: a route the map does not name is refused to every key, so a screen added later
 * is closed to keys until someone decides what it needs.
 */
export const RESOURCES = ["repositories", "requests", "tasks", "usage", "members", "settings", "keys"] as const;
export type Resource = (typeof RESOURCES)[number];
export type Access = "none" | "read" | "write";
export type Scopes = Record<Resource, Access>;

const LEVEL: Record<Access, number> = { none: 0, read: 1, write: 2 };

/**
 * The most a key ever gets per resource. No key changes members, roles, invitations, settings,
 * service accounts or sign-in: those take a person in the orchestrator. `keys: write` mints keys for
 * the key's own account and revokes them, nothing else.
 */
export const MOST: Scopes = { repositories: "write", requests: "write", tasks: "write", usage: "read", members: "read", settings: "read", keys: "write" };

/**
 * The most a key of someone in each role carries: no scope the orchestrator's own checks refuse that
 * role, so the key form offers none that would only answer 403. A member reads no settings and a
 * viewer's key changes nothing, keys included.
 */
export const ROLE_SCOPES: Record<Role, Scopes> = {
  owner: MOST,
  admin: MOST,
  member: { ...MOST, settings: "none" },
  viewer: { repositories: "read", requests: "read", tasks: "read", usage: "read", members: "read", settings: "none", keys: "read" },
};

/** The most a key this caller mints carries: their role's, and no wider than the key they call with. */
export function keyCeiling(actor: Pick<Principal, "role" | "key">): Scopes {
  const role = ROLE_SCOPES[actor.role];
  return Object.fromEntries(RESOURCES.map((r) => [r, actor.key && LEVEL[actor.key.scopes[r]] < LEVEL[role[r]] ? actor.key.scopes[r] : role[r]])) as Scopes;
}

export interface KeyOwner {
  kind: "user" | "service";
  id: string;
}

/** What a key may reach, set on the principal of a request that came with one. */
export interface KeyGrant {
  id: string;
  owner: KeyOwner;
  scopes: Scopes;
  expiresAt: string | null;
}

export interface KeyRecord {
  tenant: string;
  id: string;
  /** `th_sk_` and twelve hex digits: shown in lists and used to find the key; the rest is only hashed. */
  prefix: string;
  secretHash: string;
  name: string;
  owner: KeyOwner;
  scopes: Scopes;
  createdBy: string;
  createdAt: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
  /** The key that minted this one, when a key did; revoking it revokes this one too. */
  mintedBy: string | null;
}

export interface ServiceAccountRecord {
  tenant: string;
  id: string;
  name: string;
  createdBy: string;
  createdAt: string;
}

export interface KeyStore {
  saveKey(key: KeyRecord): Promise<void>;
  /** A key by its prefix, in any tenant: prefixes are unique across the database. */
  keyByPrefix(prefix: string): Promise<KeyRecord | null>;
  getKey(tenant: string, id: string): Promise<KeyRecord | null>;
  listKeys(tenant: string, owner: KeyOwner): Promise<KeyRecord[]>;
  /** Revokes a key and every key minted from it, through every generation, in one transaction. */
  revokeKey(tenant: string, id: string, at: string): Promise<void>;
  touchKey(tenant: string, id: string, at: string): Promise<void>;
  saveServiceAccount(account: ServiceAccountRecord): Promise<void>;
  getServiceAccount(tenant: string, id: string): Promise<ServiceAccountRecord | null>;
  listServiceAccounts(tenant: string): Promise<ServiceAccountRecord[]>;
  renameServiceAccount(tenant: string, id: string, name: string): Promise<void>;
  /** Removes a service account with its keys and the teams it owns. */
  deleteServiceAccount(tenant: string, id: string): Promise<void>;
}

/** The principal id a service account acts under; the event log reads the kind from it. */
export function serviceId(id: string): string {
  return `service:${id}`;
}

export async function servicePrincipal(store: AccountStore, account: ServiceAccountRecord): Promise<Principal> {
  return {
    id: serviceId(account.id),
    name: account.name,
    // The address a request it opens is committed under; .invalid, so it is never a mailbox.
    email: `${account.id}@service-account.invalid`,
    role: "member",
    ownedTeams: await store.ownedTeams(account.tenant, serviceId(account.id)),
  };
}

const KEY = /^(th_sk_[0-9a-f]{12})_[A-Za-z0-9_-]{32}$/;

function digest(text: string): Buffer {
  return createHash("sha256").update(text).digest();
}

export function newKey(): { key: string; prefix: string; secretHash: string } {
  const prefix = `th_sk_${randomBytes(6).toString("hex")}`;
  const key = `${prefix}_${randomBytes(24).toString("base64url")}`;
  return { key, prefix, secretHash: digest(key).toString("hex") };
}

/**
 * The route a request will be handled by, as the pattern it was registered with: the first route
 * of the request's method the router matched, which is the one that answers. Read from the
 * router, so a path that looks like another route's cannot borrow its row.
 */
export function handlerPattern(c: Context): string | undefined {
  return matchedRoutes(c).find((route) => route.method === c.req.method)?.path;
}

/** What a key needs for the route this request reaches; undefined, as for a route the table does not hold, refuses every key. */
export function keyNeed(c: Context): RouteNeed | undefined {
  const pattern = handlerPattern(c);
  return pattern === undefined ? undefined : routeNeed(c.req.method, pattern);
}

export function allows(scopes: Scopes, resource: Resource, access: Access): boolean {
  return LEVEL[scopes[resource] ?? "none"] >= LEVEL[access];
}

/** The key a bearer header carries, if it is one this tenant issued and nobody revoked and it has not expired. */
/** The tenant a presented key was issued in, or null for one that is malformed or unknown; nothing is checked beyond its prefix. */
export async function keyTenant(store: KeyStore, presented: string): Promise<string | null> {
  const prefix = KEY.exec(presented)?.[1];
  return prefix ? ((await store.keyByPrefix(prefix))?.tenant ?? null) : null;
}

export async function findKey(store: KeyStore, tenant: string, presented: string, now = new Date()): Promise<KeyRecord | null> {
  const prefix = KEY.exec(presented)?.[1];
  if (!prefix) return null;
  const found = await store.keyByPrefix(prefix);
  if (!found || found.tenant !== tenant || found.revokedAt) return null;
  if (!timingSafeEqual(digest(presented), Buffer.from(found.secretHash, "hex"))) return null;
  if (found.expiresAt && found.expiresAt <= now.toISOString()) return null;
  return found;
}

/** Last use is written at most once a minute per key, so a busy automation does not write on every call. */
const TOUCH_MS = 60_000;

export function bearerOf(c: Context): string | null {
  const header = c.req.header("authorization");
  return header?.startsWith("Bearer ") ? header.slice(7).trim() : null;
}

/**
 * A request signed with an API key. No cookie is read and no CSRF token asked for: a browser
 * never attaches this header on its own, so another site cannot make a request carry it.
 */
export function keyAuth(store: Store, tenant: string): MiddlewareHandler<OrchestratorEnv> {
  return async (c, next) => {
    const now = new Date();
    const key = await findKey(store, tenant, bearerOf(c) ?? "", now);
    if (!key) return c.json({ error: "this API key is not valid: it was revoked, it expired, or it never existed" }, 401);
    const need = keyNeed(c);
    if (need === undefined || need === "open" || need === "session") return c.json({ error: "an API key cannot do this; it takes a person signed in to the orchestrator" }, 403);
    const principal = await keyPrincipal(store, key);
    if (!principal) return c.json({ error: "this API key is not valid: its account is gone" }, 401);
    // A key keeps the scopes it was made with; an account made a viewer since changes nothing through it.
    if (principal.role === "viewer" && need !== "self" && need[1] === "write") return c.json({ error: "a viewer reads the organization and changes nothing in it" }, 403);
    if (need !== "self" && !allows(key.scopes, need[0], need[1])) return c.json({ error: `this API key has no ${need[1]} access to ${need[0]}` }, 403);
    const verdict = limitKeyCall({ tenant, keyId: key.id, owner: key.owner });
    if (!verdict.ok) {
      await noteLimited({ store, tenant }, principal, key.id, verdict.limit ?? "key");
      return tooMany(c, verdict, verdict.limit === "account" ? `this account's keys made more than ${PER_ACCOUNT_PER_MINUTE} calls in a minute; wait and try again` : `this API key made more than ${PER_KEY_PER_MINUTE} calls in a minute; wait and try again`);
    }
    if (!key.lastUsedAt || now.getTime() - Date.parse(key.lastUsedAt) >= TOUCH_MS) await store.touchKey(tenant, key.id, now.toISOString());
    c.set("user", { ...principal, key: { id: key.id, owner: key.owner, scopes: key.scopes, expiresAt: key.expiresAt } });
    c.set("csrf", "");
    await next();
  };
}

export async function keyPrincipal(store: AccountStore, key: KeyRecord): Promise<Principal | null> {
  if (key.owner.kind === "service") {
    const account = await store.getServiceAccount(key.tenant, key.owner.id);
    return account ? servicePrincipal(store, account) : null;
  }
  const user = await store.getUser(key.tenant, key.owner.id);
  if (!user || (await keyRefused(store, key.tenant, user))) return null;
  return principalOf(store, user);
}

/** The account a principal is: a member, or a service account through its key. */
function ownerOf(actor: Principal): KeyOwner {
  return actor.id.startsWith("service:") ? { kind: "service", id: actor.id.slice("service:".length) } : { kind: "user", id: actor.id };
}

function sameOwner(a: KeyOwner, b: KeyOwner): boolean {
  return a.kind === b.kind && a.id === b.id;
}

export function cleanScopes(input: unknown): Scopes {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new AccountError("scopes give each resource none, read or write");
  const given = input as Record<string, unknown>;
  const unknown = Object.keys(given).filter((k) => !(RESOURCES as readonly string[]).includes(k));
  if (unknown.length) throw new AccountError(`no resource is called ${unknown.join(", ")}`);
  const scopes = Object.fromEntries(RESOURCES.map((r) => [r, given[r] ?? "none"])) as Record<Resource, unknown>;
  for (const r of RESOURCES) {
    if (!(scopes[r] === "none" || scopes[r] === "read" || scopes[r] === "write")) throw new AccountError(`${r} is none, read or write`);
    if (LEVEL[scopes[r] as Access] > LEVEL[MOST[r]]) throw new AccountError(`a key gets at most ${MOST[r]} access to ${r}`);
  }
  if (RESOURCES.every((r) => scopes[r] === "none")) throw new AccountError("a key needs access to at least one resource");
  return scopes as Scopes;
}

export const MAX_KEY_DAYS = 365;

function expiryOf(days: unknown, now: Date): string | null {
  if (days === null || days === undefined) return null;
  if (!Number.isInteger(days) || (days as number) < 1 || (days as number) > MAX_KEY_DAYS) throw new AccountError(`a key expires in 1 to ${MAX_KEY_DAYS} days, or never`);
  return new Date(now.getTime() + (days as number) * 86_400_000).toISOString();
}

/** A key's access as the event log says it: the resources it reaches and how. */
export function describeScopes(scopes: Scopes): string {
  return RESOURCES.filter((r) => scopes[r] !== "none").map((r) => `${r} ${scopes[r]}`).join(", ");
}

export interface KeyView {
  id: string;
  name: string;
  prefix: string;
  owner: KeyOwner;
  scopes: Scopes;
  createdBy: string;
  createdAt: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
  status: "active" | "expired" | "revoked";
}

export function keyView(key: KeyRecord, now = new Date()): KeyView {
  const { id, name, prefix, owner, scopes, createdBy, createdAt, expiresAt, lastUsedAt } = key;
  const status = key.revokedAt ? "revoked" : expiresAt && expiresAt <= now.toISOString() ? "expired" : "active";
  return { id, name, prefix, owner, scopes, createdBy, createdAt, expiresAt, lastUsedAt, status };
}

/**
 * Who may hold keys of an account: the member themselves, a service account through its own
 * key, and for a service account the owners and admins who manage it.
 */
async function mayManageKeysOf(store: AccountStore, tenant: string, actor: Principal, owner: KeyOwner): Promise<AccountError | null> {
  if (actor.key) return sameOwner(actor.key.owner, owner) ? null : new AccountError("a key manages only its own account's keys", 403);
  if (owner.kind === "user") {
    if (owner.id === actor.id) return null;
    const user = await store.getUser(tenant, owner.id);
    if (!user) return new AccountError("no such member", 404);
    return overreach(actor, user.role);
  }
  if (!(await store.getServiceAccount(tenant, owner.id))) return new AccountError("no such service account", 404);
  return manages(actor) ? null : new AccountError("only an owner or an admin manages a service account's keys", 403);
}

/**
 * A new key, its secret shown this once. A key minting a key gives it no resource above its own
 * and no later expiry, so a leaked key cannot widen itself or outlive its own revocation date.
 */
export async function createKey(
  store: AccountStore,
  tenant: string,
  actor: Principal,
  input: { name?: unknown; scopes?: unknown; expiresInDays?: unknown; serviceAccountId?: unknown },
  now = new Date(),
): Promise<{ key: KeyView; secret: string }> {
  const owner: KeyOwner = typeof input.serviceAccountId === "string" && input.serviceAccountId ? { kind: "service", id: input.serviceAccountId } : ownerOf(actor);
  const refused = await mayManageKeysOf(store, tenant, actor, owner);
  if (refused) throw refused;
  const holder = owner.kind === "user" ? await store.getUser(tenant, owner.id) : null;
  if (holder && (await keyRefused(store, tenant, holder))) {
    throw new AccountError(`addresses at ${holder.email.slice(holder.email.lastIndexOf("@") + 1)} sign in with SSO, and a personal key would not work there; give automation a service account`, 403);
  }
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!name || name.length > 80) throw new AccountError("name the key in 1 to 80 characters");
  const scopes = cleanScopes(input.scopes);
  const beyond = RESOURCES.filter((r) => LEVEL[scopes[r]] > LEVEL[ROLE_SCOPES[actor.role][r]]);
  if (beyond.length) throw new AccountError(`a key reaches no further than its maker's role; a ${actor.role}'s key does not take ${beyond.map((r) => `${r} ${scopes[r]}`).join(", ")}`, 403);
  const expiresAt = expiryOf(input.expiresInDays, now);
  if (actor.key) {
    const wider = RESOURCES.filter((r) => LEVEL[scopes[r]] > LEVEL[actor.key!.scopes[r]]);
    if (wider.length) throw new AccountError(`a key mints only keys no wider than itself; this one reaches further on ${wider.join(", ")}`, 403);
    if (actor.key.expiresAt && (!expiresAt || expiresAt > actor.key.expiresAt)) throw new AccountError("a key mints only keys that expire no later than itself", 403);
  }
  const made = newKey();
  const record: KeyRecord = {
    tenant,
    id: newId("key"),
    prefix: made.prefix,
    secretHash: made.secretHash,
    name,
    owner,
    scopes,
    createdBy: actor.email,
    createdAt: now.toISOString(),
    expiresAt,
    lastUsedAt: null,
    revokedAt: null,
    mintedBy: actor.key?.id ?? null,
  };
  await store.saveKey(record);
  return { key: keyView(record, now), secret: made.key };
}

export async function revokeKey(store: AccountStore, tenant: string, actor: Principal, id: string, now = new Date()): Promise<void> {
  const key = await store.getKey(tenant, id);
  if (!key) throw new AccountError("no such key", 404);
  const refused = await mayManageKeysOf(store, tenant, actor, key.owner);
  if (refused) throw refused;
  await store.revokeKey(tenant, id, now.toISOString());
}

export async function listKeysOf(store: AccountStore, tenant: string, actor: Principal, serviceAccountId?: string): Promise<KeyView[]> {
  const owner: KeyOwner = serviceAccountId ? { kind: "service", id: serviceAccountId } : actor.key?.owner ?? ownerOf(actor);
  const refused = await mayManageKeysOf(store, tenant, actor, owner);
  if (refused) throw refused;
  return (await store.listKeys(tenant, owner)).map((k) => keyView(k));
}

export interface ServiceAccountView {
  id: string;
  name: string;
  principalId: string;
  ownedTeams: string[];
  createdBy: string;
  createdAt: string;
  activeKeys: number;
  lastUsedAt: string | null;
}

function managersOnly(actor: Principal): AccountError | null {
  if (actor.key) return new AccountError("an API key cannot manage service accounts", 403);
  return manages(actor) ? null : new AccountError("only an owner or an admin manages service accounts", 403);
}

function cleanAccountName(name: unknown): string {
  const text = typeof name === "string" ? name.trim() : "";
  if (!text || text.length > 80) throw new AccountError("name the service account in 1 to 80 characters");
  return text;
}

export async function serviceAccountViews(store: AccountStore, tenant: string): Promise<ServiceAccountView[]> {
  const now = new Date();
  return Promise.all(
    (await store.listServiceAccounts(tenant)).map(async (a) => {
      const keys = (await store.listKeys(tenant, { kind: "service", id: a.id })).map((k) => keyView(k, now));
      const used = keys.map((k) => k.lastUsedAt).filter((at): at is string => Boolean(at)).sort();
      return {
        id: a.id,
        name: a.name,
        principalId: serviceId(a.id),
        ownedTeams: await store.ownedTeams(tenant, serviceId(a.id)),
        createdBy: a.createdBy,
        createdAt: a.createdAt,
        activeKeys: keys.filter((k) => k.status === "active").length,
        lastUsedAt: used.at(-1) ?? null,
      };
    }),
  );
}

export async function createServiceAccount(store: AccountStore, tenant: string, knownTeams: Set<string>, input: { name?: unknown; teams?: unknown }, actor: Principal): Promise<ServiceAccountRecord> {
  const refused = managersOnly(actor);
  if (refused) throw refused;
  const account: ServiceAccountRecord = { tenant, id: newId("svc"), name: cleanAccountName(input.name), createdBy: actor.email, createdAt: new Date().toISOString() };
  const teams = cleanTeams(input.teams, knownTeams);
  await store.saveServiceAccount(account);
  if (teams.length) await store.setOwnedTeams(tenant, serviceId(account.id), teams);
  return account;
}

export async function updateServiceAccount(store: AccountStore, tenant: string, knownTeams: Set<string>, id: string, input: { name?: unknown; teams?: unknown }, actor: Principal): Promise<void> {
  const refused = managersOnly(actor);
  if (refused) throw refused;
  if (!(await store.getServiceAccount(tenant, id))) throw new AccountError("no such service account", 404);
  if (input.name !== undefined) await store.renameServiceAccount(tenant, id, cleanAccountName(input.name));
  if (input.teams !== undefined) await store.setOwnedTeams(tenant, serviceId(id), cleanTeams(input.teams, knownTeams));
}

export async function removeServiceAccount(store: AccountStore, tenant: string, id: string, actor: Principal): Promise<void> {
  const refused = managersOnly(actor);
  if (refused) throw refused;
  if (!(await store.getServiceAccount(tenant, id))) throw new AccountError("no such service account", 404);
  await store.deleteServiceAccount(tenant, id);
}

function failure(c: Context, err: unknown) {
  if (err instanceof AccountError) return c.json({ error: err.message }, err.status);
  throw err;
}

export function keyRoutes(ctx: OrchestratorContext): Hono<OrchestratorEnv> {
  const app = new Hono<OrchestratorEnv>();
  const store = ctx.store;
  const knownTeams = async () => new Set((await store.listRepos(ctx.tenant)).map((r) => r.team));
  const body = (c: Context) => c.req.json().catch(() => ({}));

  app.get("/api/keys", async (c) => {
    try {
      return c.json({ keys: await listKeysOf(store, ctx.tenant, c.get("user"), c.req.query("serviceAccount") || undefined) });
    } catch (err) {
      return failure(c, err);
    }
  });

  app.post("/api/keys", async (c) => {
    try {
      const made = await createKey(store, ctx.tenant, c.get("user"), await body(c));
      await recordEvent(ctx, c.get("user"), "key.created", { subject: `key:${made.key.id}`, detail: `${made.key.prefix} "${made.key.name}" for ${made.key.owner.kind === "service" ? `service account ${made.key.owner.id}` : `account ${made.key.owner.id}`}: ${describeScopes(made.key.scopes)}, ${made.key.expiresAt ? `expires ${made.key.expiresAt.slice(0, 10)}` : "no expiry"}` });
      return c.json(made);
    } catch (err) {
      return failure(c, err);
    }
  });

  app.delete("/api/keys/:id", async (c) => {
    try {
      await revokeKey(store, ctx.tenant, c.get("user"), c.req.param("id"));
      const key = await store.getKey(ctx.tenant, c.req.param("id"));
      await recordEvent(ctx, c.get("user"), "key.revoked", { subject: `key:${c.req.param("id")}`, detail: `${key?.prefix ?? "a key"} "${key?.name ?? ""}" revoked` });
      return c.json({ ok: true });
    } catch (err) {
      return failure(c, err);
    }
  });

  app.get("/api/service-accounts", async (c) => {
    if (!manages(c.get("user"))) return c.json({ error: "only an owner or an admin sees service accounts" }, 403);
    return c.json({ serviceAccounts: await serviceAccountViews(store, ctx.tenant) });
  });

  app.post("/api/service-accounts", async (c) => {
    try {
      const account = await createServiceAccount(store, ctx.tenant, await knownTeams(), await body(c), c.get("user"));
      await recordEvent(ctx, c.get("user"), "service-account.created", { subject: `account:${serviceId(account.id)}`, detail: account.name });
      return c.json({ serviceAccount: (await serviceAccountViews(store, ctx.tenant)).find((a) => a.id === account.id) });
    } catch (err) {
      return failure(c, err);
    }
  });

  app.patch("/api/service-accounts/:id", async (c) => {
    try {
      const input = (await body(c)) as { name?: unknown; teams?: unknown };
      await updateServiceAccount(store, ctx.tenant, await knownTeams(), c.req.param("id"), input, c.get("user"));
      const owned = await store.ownedTeams(ctx.tenant, serviceId(c.req.param("id")));
      await recordEvent(ctx, c.get("user"), "service-account.changed", { subject: `account:${serviceId(c.req.param("id"))}`, detail: `${input.name === undefined ? "" : "renamed; "}owns ${owned.join(", ") || "no team"}` });
      return c.json({ serviceAccount: (await serviceAccountViews(store, ctx.tenant)).find((a) => a.id === c.req.param("id")) });
    } catch (err) {
      return failure(c, err);
    }
  });

  app.delete("/api/service-accounts/:id", async (c) => {
    try {
      const account = await store.getServiceAccount(ctx.tenant, c.req.param("id"));
      await removeServiceAccount(store, ctx.tenant, c.req.param("id"), c.get("user"));
      await recordEvent(ctx, c.get("user"), "service-account.removed", { subject: `account:${serviceId(c.req.param("id"))}`, detail: `${account?.name ?? "a service account"}, with its keys` });
      return c.json({ ok: true });
    } catch (err) {
      return failure(c, err);
    }
  });

  return app;
}
