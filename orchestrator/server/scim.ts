import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { forgetPersonForge } from "./forge/device-sign-in.js";
import type { SecretStore } from "./vault.js";
import { Hono } from "hono";
import type { Context } from "hono";
import type { OrchestratorContext } from "./app.js";
import { AccountError, emailKey, normalizeEmail } from "./accounts.js";
import type { AccountStore, UserRecord } from "./accounts.js";
import type { OrchestratorEnv, Principal } from "./auth.js";
import { markRemoved } from "./directory-join.js";
import { recordEvent } from "./events.js";
import { OFF_PREFIX } from "./store.js";
import type { EventActor } from "./events.js";

/**
 * SCIM 2.0 provisioning: the identity provider adds people, turns them off and back on, removes
 * them, and keeps groups whose names the directory sync maps to tags. It calls with a token of
 * its own, which reaches these routes and nothing else. Once a token is set the directory
 * decides who is here: single sign-on stops adding unknown people and stops rewriting groups.
 *
 * A person the directory turns off is shut out at once: their sessions end, their keys are
 * revoked, the apps they approved lose their tokens, and every way in refuses them until the
 * directory turns them on again. The last owner is never turned off or removed this way.
 */
const TOKEN = /^(th_scim_[0-9a-f]{12})_[A-Za-z0-9_-]{32}$/;
const TOKEN_KEY = "scim.token";
const userKey = (id: string) => `scim.user.${id}`;
const groupKey = (id: string) => `scim.group.${id}`;
const GROUP_PREFIX = "scim.group.";

const USER_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:User";
const GROUP_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:Group";
const LIST_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:ListResponse";
const ERROR_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:Error";
const PATCH_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:PatchOp";
/** SCIM's resource paths, kept as names: a literal user path reads to a source scanner like a home folder on a Mac. */
export const USERS = "/Users";
const ONE_USER = `/api/scim/v2${USERS}/:id`;
export const MAX_PAGE = 200;

/** The event log's name for whoever acts through the directory. */
export const DIRECTORY_ACTOR: EventActor = { kind: "orchestrator", id: null, email: null, name: "Directory (SCIM)" };

interface TokenRow {
  prefix: string;
  hash: string;
  createdBy: string;
  createdAt: string;
  lastUsedAt: string | null;
}

/** What the orchestrator keeps of a provisioned person beside their account; whether they are off is a row of its own, which owner counts read. */
interface ScimUser {
  externalId: string | null;
}

interface ScimGroup {
  displayName: string;
  externalId: string | null;
  members: string[];
  created: string;
}

export interface ScimStore extends AccountStore, Pick<SecretStore, "deleteSecret"> {
  listSettings(tenant: string, prefix: string): Promise<{ key: string; value: string }[]>;
}

export class ScimError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 401 | 403 | 404 | 409,
    readonly scimType?: string,
  ) {
    super(message);
  }
}

function digest(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** Whether a SCIM token is set: the directory, not single sign-on, decides who joins. */
export async function scimOn(store: Pick<AccountStore, "getSetting">, tenant: string): Promise<boolean> {
  return (await store.getSetting(tenant, TOKEN_KEY)) !== null;
}

/** Whether the directory has turned this account off. */
export async function suspended(store: Pick<AccountStore, "getSetting">, tenant: string, userId: string): Promise<boolean> {
  return (await store.getSetting(tenant, `${OFF_PREFIX}${userId}`)) !== null;
}

export async function scimTokenStatus(store: AccountStore, tenant: string): Promise<{ createdBy: string; createdAt: string; lastUsedAt: string | null; prefix: string } | null> {
  const raw = await store.getSetting(tenant, TOKEN_KEY);
  if (!raw) return null;
  const { prefix, createdBy, createdAt, lastUsedAt } = JSON.parse(raw) as TokenRow;
  return { prefix, createdBy, createdAt, lastUsedAt };
}

function ownersOnly(actor: Principal): AccountError | null {
  if (actor.key) return new AccountError("an API key cannot change directory provisioning", 403);
  return actor.role === "owner" ? null : new AccountError("only an owner sets up directory provisioning", 403);
}

/** A new token, replacing any before it; the secret is returned this once. */
export async function createScimToken(store: AccountStore, tenant: string, actor: Principal, now = new Date()): Promise<string> {
  const refused = ownersOnly(actor);
  if (refused) throw refused;
  const prefix = `th_scim_${randomBytes(6).toString("hex")}`;
  const token = `${prefix}_${randomBytes(24).toString("base64url")}`;
  const row: TokenRow = { prefix, hash: digest(token), createdBy: actor.email, createdAt: now.toISOString(), lastUsedAt: null };
  await store.setSetting(tenant, TOKEN_KEY, JSON.stringify(row));
  return token;
}

export async function deleteScimToken(store: AccountStore, tenant: string, actor: Principal): Promise<void> {
  const refused = ownersOnly(actor);
  if (refused) throw refused;
  await store.deleteSetting(tenant, TOKEN_KEY);
}

async function checkToken(store: AccountStore, tenant: string, presented: string | null, now = new Date()): Promise<void> {
  const refused = new ScimError("the SCIM token is not valid", 401);
  const raw = await store.getSetting(tenant, TOKEN_KEY);
  if (!raw || !presented || !TOKEN.test(presented)) throw refused;
  const row = JSON.parse(raw) as TokenRow;
  if (!timingSafeEqual(Buffer.from(digest(presented), "hex"), Buffer.from(row.hash, "hex"))) throw refused;
  if (!row.lastUsedAt || now.getTime() - Date.parse(row.lastUsedAt) >= 60_000) await store.setSetting(tenant, TOKEN_KEY, JSON.stringify({ ...row, lastUsedAt: now.toISOString() }));
}

/**
 * Shuts a person out at once: sessions, keys and app tokens go, and the account is marked off,
 * which every way in reads. Refused for the last owner, whom nothing outside may lock out.
 */
export async function turnOff(store: ScimStore, tenant: string, user: UserRecord): Promise<void> {
  if (!(await store.turnOffUser(tenant, user.id, new Date().toISOString()))) {
    throw new ScimError("this is the organization's only owner still on; make someone else an owner first", 409, "mutability");
  }
  await store.deleteSessions(tenant, user.id);
  const now = new Date().toISOString();
  for (const key of await store.listKeys(tenant, { kind: "user", id: user.id })) if (!key.revokedAt) await store.revokeKey(tenant, key.id, now);
  await store.dropOauthGrants(tenant, user.id);
  await forgetPersonForge(store, tenant, user.id);
}

async function scimUser(store: AccountStore, tenant: string, id: string): Promise<ScimUser> {
  const raw = await store.getSetting(tenant, userKey(id));
  return raw ? { externalId: (JSON.parse(raw) as ScimUser).externalId ?? null } : { externalId: null };
}

async function setScimUser(store: AccountStore, tenant: string, id: string, patch: Partial<ScimUser>): Promise<void> {
  await store.setSetting(tenant, userKey(id), JSON.stringify({ ...(await scimUser(store, tenant, id)), ...patch }));
}

function base(c: Context): string {
  return new URL(c.req.url).pathname.replace(/\/(Users|Groups|ServiceProviderConfig|ResourceTypes|Schemas)(\/.*)?$/, "");
}

async function userResource(store: AccountStore, c: Context, user: UserRecord) {
  const meta = await scimUser(store, user.tenant, user.id);
  const [givenName, ...rest] = user.name.split(" ");
  return {
    schemas: [USER_SCHEMA],
    id: user.id,
    ...(meta.externalId ? { externalId: meta.externalId } : {}),
    userName: user.email,
    name: { formatted: user.name, ...(rest.length ? { givenName, familyName: rest.join(" ") } : {}) },
    displayName: user.name,
    emails: [{ value: user.email, type: "work", primary: true }],
    active: !(await suspended(store, user.tenant, user.id)),
    meta: { resourceType: "User", created: user.createdAt, location: `${base(c)}${USERS}/${user.id}` },
  };
}

function groupResource(c: Context, id: string, group: ScimGroup, users: Map<string, UserRecord>) {
  return {
    schemas: [GROUP_SCHEMA],
    id,
    ...(group.externalId ? { externalId: group.externalId } : {}),
    displayName: group.displayName,
    members: group.members.filter((m) => users.has(m)).map((m) => ({ value: m, display: users.get(m)!.email })),
    meta: { resourceType: "Group", created: group.created, location: `${base(c)}/Groups/${id}` },
  };
}

/** `attr eq "value"`, the one filter Okta and Entra send; anything else is refused rather than ignored. */
function filterOf(text: string | undefined, allowed: string[]): { attr: string; value: string } | null {
  if (!text) return null;
  const match = /^\s*([A-Za-z.]+)\s+eq\s+"((?:[^"\\]|\\.)*)"\s*$/i.exec(text);
  if (!match || !allowed.includes(match[1]!)) throw new ScimError(`this orchestrator filters only by ${allowed.join(" or ")} eq "..."`, 400, "invalidFilter");
  return { attr: match[1]!, value: match[2]!.replace(/\\(.)/g, "$1") };
}

function page<T>(c: Context, all: T[]) {
  const start = Math.max(1, Number(c.req.query("startIndex") ?? 1) || 1);
  const count = Math.min(MAX_PAGE, Math.max(0, Number(c.req.query("count") ?? 100) || 0));
  return { schemas: [LIST_SCHEMA], totalResults: all.length, startIndex: start, itemsPerPage: Math.min(count, Math.max(0, all.length - start + 1)), Resources: all.slice(start - 1, start - 1 + count) };
}

function truthy(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof value === "string" && /^(true|false)$/i.test(value)) return value.toLowerCase() === "true";
  return null;
}

/** The address and name a User body gives, read the ways Okta and Entra send them. */
function readUser(body: Record<string, unknown>): { email?: string; name?: string; active?: boolean; externalId?: string | null } {
  const out: { email?: string; name?: string; active?: boolean; externalId?: string | null } = {};
  const emails = Array.isArray(body.emails) ? (body.emails as { value?: unknown; primary?: unknown }[]) : [];
  const address = typeof body.userName === "string" ? body.userName : (emails.find((e) => e.primary === true) ?? emails[0])?.value;
  if (typeof address === "string") out.email = normalizeEmail(address);
  const name = (body.name ?? {}) as { formatted?: unknown; givenName?: unknown; familyName?: unknown };
  const full = typeof name.formatted === "string" && name.formatted.trim() ? name.formatted : [name.givenName, name.familyName].filter((p) => typeof p === "string" && p).join(" ") || (typeof body.displayName === "string" ? body.displayName : "");
  if (full.trim()) out.name = full.trim().slice(0, 120);
  const active = truthy(body.active);
  if (active !== null) out.active = active;
  if (body.externalId !== undefined) out.externalId = typeof body.externalId === "string" ? body.externalId : null;
  return out;
}

/** Applies a PatchOp's operations to the fields a User body carries, as one flat body. */
function patchedUser(body: Record<string, unknown>): Record<string, unknown> {
  const ops = Array.isArray(body.Operations) ? (body.Operations as { op?: unknown; path?: unknown; value?: unknown }[]) : [];
  const flat: Record<string, unknown> = {};
  const name: Record<string, unknown> = {};
  for (const { op, path, value } of ops) {
    if (typeof op !== "string" || !/^(add|replace)$/i.test(op)) throw new ScimError(`a User takes add and replace operations, not ${String(op)}`, 400, "invalidSyntax");
    if (path === undefined) {
      Object.assign(flat, value as object);
      continue;
    }
    const p = String(path);
    if (p === "active" || p === "userName" || p === "displayName" || p === "externalId") flat[p] = value;
    else if (p === "name.givenName" || p === "name.familyName" || p === "name.formatted") name[p.slice(5)] = value;
    else if (/^emails(\[.*\])?(\.value)?$/.test(p)) flat.emails = [{ value: Array.isArray(value) ? (value[0] as { value?: unknown })?.value : value, primary: true }];
    else throw new ScimError(`this orchestrator does not keep ${p}`, 400, "invalidPath");
  }
  if (Object.keys(name).length) flat.name = { ...((flat.name as object) ?? {}), ...name };
  return flat;
}

async function groups(store: ScimStore, tenant: string): Promise<Map<string, ScimGroup>> {
  return new Map((await store.listSettings(tenant, GROUP_PREFIX)).map((r) => [r.key.slice(GROUP_PREFIX.length), JSON.parse(r.value) as ScimGroup]));
}

/** Each member's groups, as directory sync reads them, rewritten from the directory's groups. */
async function syncMemberGroups(store: ScimStore, tenant: string, userIds: Iterable<string>): Promise<void> {
  const all = [...(await groups(store, tenant)).values()];
  for (const id of new Set(userIds)) await store.setMemberGroups(tenant, id, all.filter((g) => g.members.includes(id)).map((g) => g.displayName));
}

function scimFailure(c: Context, err: unknown) {
  const statuses = [400, 401, 403, 404, 409] as const;
  const known = err instanceof ScimError ? err : err instanceof AccountError ? new ScimError(err.message, statuses.find((s) => s === err.status) ?? 400) : null;
  if (!known) throw err;
  return c.json({ schemas: [ERROR_SCHEMA], status: String(known.status), ...(known.scimType ? { scimType: known.scimType } : {}), detail: known.message }, known.status, { "content-type": "application/scim+json" });
}

/** SCIM's routes, answered before the orchestrator's own sign-in: the SCIM token is their only way in. */
export function scimRoutes(ctx: OrchestratorContext & { store: ScimStore }): Hono<OrchestratorEnv> {
  const app = new Hono<OrchestratorEnv>();
  const store = ctx.store;
  const out = (c: Context, body: unknown, status: 200 | 201 = 200) => c.json(body, status, { "content-type": "application/scim+json" });
  const body = async (c: Context) => (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const event = (kind: string, subject: string, detail: string) => recordEvent(ctx, DIRECTORY_ACTOR, kind, { subject, detail });

  app.use("/api/scim/v2/*", async (c, next) => {
    try {
      const header = c.req.header("authorization") ?? "";
      await checkToken(store, ctx.tenant, header.startsWith("Bearer ") ? header.slice(7).trim() : null);
    } catch (err) {
      return scimFailure(c, err);
    }
    await next();
  });

  app.get("/api/scim/v2/ServiceProviderConfig", (c) =>
    out(c, {
      schemas: ["urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig"],
      patch: { supported: true },
      bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
      filter: { supported: true, maxResults: MAX_PAGE },
      changePassword: { supported: false },
      sort: { supported: false },
      etag: { supported: false },
      authenticationSchemes: [{ type: "oauthbearertoken", name: "Bearer token", description: "The SCIM token an owner created in Settings, Security" }],
    }),
  );

  const userOr404 = async (id: string) => {
    const user = await store.getUser(ctx.tenant, id);
    if (!user) throw new ScimError("no such user", 404);
    return user;
  };

  /** Applies what a body gives to one account; turning off and on goes through the same doors as everywhere. */
  const apply = async (user: UserRecord, given: ReturnType<typeof readUser>): Promise<string[]> => {
    const changed: string[] = [];
    if (given.email && given.email !== user.email) {
      if (await store.getUserByEmail(ctx.tenant, given.email)) throw new ScimError(`${given.email} already has an account`, 409, "uniqueness");
      await store.setUserEmail(ctx.tenant, user.id, given.email);
      changed.push(`address ${given.email}`);
    }
    if (given.name && given.name !== user.name) {
      await store.updateUser(ctx.tenant, user.id, { name: given.name });
      changed.push(`name ${given.name}`);
    }
    if (given.externalId !== undefined) await setScimUser(store, ctx.tenant, user.id, { externalId: given.externalId });
    const off = await suspended(store, ctx.tenant, user.id);
    if (given.active === false && !off) {
      await turnOff(store, ctx.tenant, user);
      changed.push("turned off: sessions ended, keys revoked, app tokens dropped");
    } else if (given.active === true && off) {
      await store.deleteSetting(ctx.tenant, `${OFF_PREFIX}${user.id}`);
      changed.push("turned on");
    }
    return changed;
  };

  app.get("/api/scim/v2/Users", async (c) => {
    try {
      const filter = filterOf(c.req.query("filter"), ["userName", "externalId", "emails.value"]);
      let users = await store.listUsers(ctx.tenant);
      if (filter?.attr === "externalId") {
        const ids = new Set<string>();
        for (const u of users) if ((await scimUser(store, ctx.tenant, u.id)).externalId === filter.value) ids.add(u.id);
        users = users.filter((u) => ids.has(u.id));
      } else if (filter) users = users.filter((u) => u.email === emailKey(filter.value));
      return out(c, page(c, await Promise.all(users.map((u) => userResource(store, c, u)))));
    } catch (err) {
      return scimFailure(c, err);
    }
  });

  app.get(ONE_USER, async (c) => {
    try {
      return out(c, await userResource(store, c, await userOr404(c.req.param("id"))));
    } catch (err) {
      return scimFailure(c, err);
    }
  });

  app.post("/api/scim/v2/Users", async (c) => {
    try {
      const given = readUser(await body(c));
      if (!given.email) throw new ScimError("a User needs userName or an email address", 400, "invalidValue");
      if (await store.getUserByEmail(ctx.tenant, given.email)) throw new ScimError(`${given.email} already has an account`, 409, "uniqueness");
      const user: UserRecord = { tenant: ctx.tenant, id: randomUUID(), email: given.email, name: given.name ?? given.email, role: "member", passwordHash: null, oidcIssuer: null, oidcSubject: null, forgeLogin: null, createdAt: new Date().toISOString() };
      await store.insertUser(user);
      await setScimUser(store, ctx.tenant, user.id, { externalId: given.externalId ?? null });
      if (given.active === false) await turnOff(store, ctx.tenant, user);
      await event("scim.user.created", `account:${user.id}`, `${user.email} added as member${given.active === false ? ", turned off" : ""}`);
      return out(c, await userResource(store, c, user), 201);
    } catch (err) {
      return scimFailure(c, err);
    }
  });

  const update = async (c: Context, given: ReturnType<typeof readUser>) => {
    const user = await userOr404(c.req.param("id")!);
    const changed = await apply(user, given);
    if (changed.length) await event(given.active === false ? "scim.user.deactivated" : "scim.user.changed", `account:${user.id}`, `${user.email}: ${changed.join("; ")}`);
    return out(c, await userResource(store, c, (await store.getUser(ctx.tenant, user.id))!));
  };

  app.put(ONE_USER, async (c) => {
    try {
      return await update(c, readUser(await body(c)));
    } catch (err) {
      return scimFailure(c, err);
    }
  });

  app.patch(ONE_USER, async (c) => {
    try {
      return await update(c, readUser(patchedUser(await body(c))));
    } catch (err) {
      return scimFailure(c, err);
    }
  });

  app.delete(ONE_USER, async (c) => {
    try {
      const user = await userOr404(c.req.param("id"));
      if (!(await store.deleteUser(ctx.tenant, user.id))) throw new ScimError("this is the organization's only owner; make someone else an owner first", 409, "mutability");
      await markRemoved(store, ctx.tenant, user);
      await event("scim.user.deleted", `account:${user.id}`, `${user.email}, who was ${user.role}, removed by the directory`);
      return c.body(null, 204);
    } catch (err) {
      return scimFailure(c, err);
    }
  });

  const groupOr404 = async (id: string) => {
    const group = (await groups(store, ctx.tenant)).get(id);
    if (!group) throw new ScimError("no such group", 404);
    return group;
  };
  const usersById = async () => new Map((await store.listUsers(ctx.tenant)).map((u) => [u.id, u]));
  const memberIds = async (value: unknown): Promise<string[]> => {
    const list = Array.isArray(value) ? value : value === undefined ? [] : [value];
    const known = await usersById();
    return list.map((m) => String((m as { value?: unknown })?.value ?? "")).filter((id) => known.has(id));
  };
  /** Ids a remove names, whether or not the account still exists. */
  const memberIdsAny = async (value: unknown) => (Array.isArray(value) ? value : [value]).map((m) => String((m as { value?: unknown })?.value ?? ""));
  const cleanName = (value: unknown) => {
    if (typeof value !== "string" || !value.trim() || value.length > 200) throw new ScimError("a Group needs a displayName of up to 200 characters", 400, "invalidValue");
    return value.trim();
  };
  const saveGroup = async (id: string, group: ScimGroup, before: string[]) => {
    await store.setSetting(ctx.tenant, groupKey(id), JSON.stringify(group));
    await syncMemberGroups(store, ctx.tenant, [...before, ...group.members]);
  };

  app.get("/api/scim/v2/Groups", async (c) => {
    try {
      const filter = filterOf(c.req.query("filter"), ["displayName", "externalId"]);
      const users = await usersById();
      const all = [...(await groups(store, ctx.tenant))].filter(([, g]) => !filter || (filter.attr === "displayName" ? g.displayName === filter.value : g.externalId === filter.value));
      // Okta asks for groups without members when it only needs their ids.
      const bare = c.req.query("excludedAttributes") === "members";
      return out(c, page(c, all.map(([id, g]) => (bare ? { ...groupResource(c, id, g, users), members: undefined } : groupResource(c, id, g, users)))));
    } catch (err) {
      return scimFailure(c, err);
    }
  });

  app.get("/api/scim/v2/Groups/:id", async (c) => {
    try {
      return out(c, groupResource(c, c.req.param("id"), await groupOr404(c.req.param("id")), await usersById()));
    } catch (err) {
      return scimFailure(c, err);
    }
  });

  app.post("/api/scim/v2/Groups", async (c) => {
    try {
      const b = await body(c);
      const displayName = cleanName(b.displayName);
      if ([...(await groups(store, ctx.tenant)).values()].some((g) => g.displayName === displayName)) throw new ScimError(`a group is already called ${displayName}`, 409, "uniqueness");
      const id = randomUUID();
      const group: ScimGroup = { displayName, externalId: typeof b.externalId === "string" ? b.externalId : null, members: await memberIds(b.members), created: new Date().toISOString() };
      await saveGroup(id, group, []);
      await event("scim.group.created", `group:${id}`, `${displayName} with ${group.members.length} member${group.members.length === 1 ? "" : "s"}`);
      return out(c, groupResource(c, id, group, await usersById()), 201);
    } catch (err) {
      return scimFailure(c, err);
    }
  });

  app.put("/api/scim/v2/Groups/:id", async (c) => {
    try {
      const id = c.req.param("id");
      const before = await groupOr404(id);
      const b = await body(c);
      const group: ScimGroup = { ...before, displayName: cleanName(b.displayName), members: await memberIds(b.members) };
      await saveGroup(id, group, before.members);
      await event("scim.group.changed", `group:${id}`, `${group.displayName}: ${group.members.length} member${group.members.length === 1 ? "" : "s"}`);
      return out(c, groupResource(c, id, group, await usersById()));
    } catch (err) {
      return scimFailure(c, err);
    }
  });

  app.patch("/api/scim/v2/Groups/:id", async (c) => {
    try {
      const id = c.req.param("id");
      const before = await groupOr404(id);
      const b = await body(c);
      const group: ScimGroup = { ...before, members: [...before.members] };
      for (const { op, path, value } of (Array.isArray(b.Operations) ? b.Operations : []) as { op?: unknown; path?: unknown; value?: unknown }[]) {
        const kind = String(op).toLowerCase();
        const p = path === undefined ? undefined : String(path);
        const removing = /^members\[value eq "([^"]+)"\]$/.exec(p ?? "")?.[1];
        if (kind === "remove" && removing) group.members = group.members.filter((m) => m !== removing);
        else if (kind === "remove" && p === "members") {
          const gone = new Set(value === undefined ? group.members : await memberIdsAny(value));
          group.members = group.members.filter((m) => !gone.has(m));
        } else if (kind === "add" && (p === "members" || p === undefined)) {
          const added = await memberIds(p === undefined ? (value as { members?: unknown })?.members : value);
          group.members = [...new Set([...group.members, ...added])];
        } else if (kind === "replace" && p === "members") group.members = await memberIds(value);
        else if (kind === "replace" && (p === "displayName" || p === undefined)) group.displayName = cleanName(p === undefined ? (value as { displayName?: unknown })?.displayName : value);
        else throw new ScimError(`this orchestrator does not take ${String(op)} on ${p ?? "a Group"}`, 400, "invalidPath");
      }
      await saveGroup(id, group, before.members);
      await event("scim.group.changed", `group:${id}`, `${group.displayName}: ${group.members.length} member${group.members.length === 1 ? "" : "s"}`);
      return out(c, groupResource(c, id, group, await usersById()));
    } catch (err) {
      return scimFailure(c, err);
    }
  });

  app.delete("/api/scim/v2/Groups/:id", async (c) => {
    try {
      const id = c.req.param("id");
      const before = await groupOr404(id);
      await store.deleteSetting(ctx.tenant, groupKey(id));
      await syncMemberGroups(store, ctx.tenant, before.members);
      await event("scim.group.deleted", `group:${id}`, `${before.displayName} removed`);
      return c.body(null, 204);
    } catch (err) {
      return scimFailure(c, err);
    }
  });

  return app;
}

/** Turning the directory on and off, and the address it calls, for owners on the Security page. */
export function scimAdminRoutes(ctx: OrchestratorContext): Hono<OrchestratorEnv> {
  const app = new Hono<OrchestratorEnv>();
  const store = ctx.store;
  const failure = (c: Context, err: unknown) => {
    if (err instanceof AccountError) return c.json({ error: err.message }, err.status);
    throw err;
  };
  const baseUrl = () => `${(ctx.publicUrl ?? "").replace(/\/+$/, "")}${ctx.webBase ? `/api/orgs/${encodeURIComponent(ctx.tenant)}` : "/api"}/scim/v2`;

  app.get("/api/scim", async (c) => {
    const user = c.get("user");
    if (user.role !== "owner" && user.role !== "admin") return c.json({ error: "only an owner or an admin sees directory provisioning" }, 403);
    return c.json({ baseUrl: baseUrl(), token: await scimTokenStatus(store, ctx.tenant) });
  });

  app.post("/api/scim/token", async (c) => {
    try {
      const token = await createScimToken(store, ctx.tenant, c.get("user"));
      await recordEvent(ctx, c.get("user"), "scim.token.created", { subject: "scim", detail: `a SCIM token ${token.slice(0, 20)} was made; any token before it stopped working` });
      return c.json({ token, baseUrl: baseUrl() });
    } catch (err) {
      return failure(c, err);
    }
  });

  app.delete("/api/scim/token", async (c) => {
    try {
      await deleteScimToken(store, ctx.tenant, c.get("user"));
      await recordEvent(ctx, c.get("user"), "scim.token.deleted", { subject: "scim", detail: "the SCIM token was deleted; the directory no longer reaches this organization" });
      return c.json({ ok: true });
    } catch (err) {
      return failure(c, err);
    }
  });

  return app;
}
