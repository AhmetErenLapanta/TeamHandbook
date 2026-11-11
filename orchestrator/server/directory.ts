import { createHash } from "node:crypto";
import { Hono } from "hono";
import type { Context } from "hono";
import type { OrchestratorContext } from "./app.js";
import { AccountError, overreach } from "./accounts.js";
import type { AccountStore } from "./accounts.js";
import { manages } from "./auth.js";
import { recordEvent } from "./events.js";
import type { OrchestratorEnv, Principal } from "./auth.js";

/**
 * Member tags, the audiences team policies name. A tag is given by hand, or comes from the
 * identity provider: each sign-in records the groups the ID token lists, and a group the
 * organization mapped to a tag gives its members that tag, which they lose once a later sign-in
 * no longer lists the group. Only groups someone mapped give tags, and a new mapping is
 * previewed - who gains and loses which tag - before it applies, so a group the provider starts
 * sending changes no audience on its own.
 */
export interface GroupTag {
  group: string;
  tag: string;
}

export interface DirectoryStore {
  /** Replaces the groups a member's last sign-in listed. */
  setMemberGroups(tenant: string, userId: string, groups: string[]): Promise<void>;
  memberGroups(tenant: string): Promise<{ userId: string; group: string }[]>;
  groupTags(tenant: string): Promise<GroupTag[]>;
  /** Replaces the whole mapping in one transaction. */
  setGroupTags(tenant: string, mapping: GroupTag[]): Promise<void>;
  manualTags(tenant: string): Promise<{ userId: string; tag: string }[]>;
  setManualTags(tenant: string, userId: string, tags: string[]): Promise<void>;
}

const TAG = /^[a-z0-9][a-z0-9-]{0,39}$/;
/** Groups kept from one ID token, and the longest name: a provider listing more sends a dump, not a membership. */
export const MAX_GROUPS = 200;
const MAX_GROUP_LENGTH = 200;

export function cleanTag(tag: unknown): string {
  const text = typeof tag === "string" ? tag.trim().toLowerCase() : "";
  if (!TAG.test(text)) throw new AccountError("a tag is up to 40 lower-case letters, digits and dashes, starting with a letter or digit");
  return text;
}

/** The groups an ID token's claim lists, or undefined when it lists none in a form the orchestrator reads. */
export function groupsFrom(claim: unknown): string[] | undefined {
  if (!Array.isArray(claim) || !claim.every((g) => typeof g === "string")) return undefined;
  return [...new Set((claim as string[]).map((g) => g.trim()).filter((g) => g && g.length <= MAX_GROUP_LENGTH))].slice(0, MAX_GROUPS);
}

export function cleanMapping(input: unknown, known: Set<string>): GroupTag[] {
  if (!Array.isArray(input)) throw new AccountError("the mapping is a list of groups and the tag each gives");
  const seen = new Set<string>();
  return input.map((entry) => {
    const { group, tag } = (entry ?? {}) as { group?: unknown; tag?: unknown };
    if (typeof group !== "string" || !known.has(group)) throw new AccountError(`no member's sign-in has listed the group ${String(group)}`);
    if (seen.has(group)) throw new AccountError(`the group ${group} is mapped twice`);
    seen.add(group);
    return { group, tag: cleanTag(tag) };
  });
}

/** Every member's tags, by member: their own tags and those their groups give under `mapping`. */
export function tagsUnder(mapping: GroupTag[], groups: { userId: string; group: string }[], manual: { userId: string; tag: string }[]): Map<string, { tag: string; source: "manual" | "directory" }[]> {
  const byGroup = new Map(mapping.map((m) => [m.group, m.tag]));
  const tags = new Map<string, Map<string, "manual" | "directory">>();
  const add = (userId: string, tag: string, source: "manual" | "directory") => {
    const mine = tags.get(userId) ?? new Map<string, "manual" | "directory">();
    if (!mine.has(tag) || source === "manual") mine.set(tag, source);
    tags.set(userId, mine);
  };
  for (const { userId, group } of groups) {
    const tag = byGroup.get(group);
    if (tag) add(userId, tag, "directory");
  }
  for (const { userId, tag } of manual) add(userId, tag, "manual");
  return new Map([...tags].map(([userId, mine]) => [userId, [...mine].map(([tag, source]) => ({ tag, source })).sort((a, b) => a.tag.localeCompare(b.tag))]));
}

/** Each member's tags now, for policy audiences and the member page. */
export async function memberTags(store: AccountStore, tenant: string): Promise<Map<string, { tag: string; source: "manual" | "directory" }[]>> {
  return tagsUnder(await store.groupTags(tenant), await store.memberGroups(tenant), await store.manualTags(tenant));
}

export interface TagChange {
  member: { id: string; name: string; email: string };
  gains: string[];
  loses: string[];
}

export interface Preview {
  changes: TagChange[];
  /** Names the state the preview read; applying with it refuses once anything it read has changed. */
  fingerprint: string;
}

/** Who gains and loses which tag if `mapping` replaced the one in force, read from the groups each member last signed in with. */
export async function previewMapping(store: AccountStore, tenant: string, input: unknown): Promise<{ mapping: GroupTag[]; preview: Preview }> {
  const groups = await store.memberGroups(tenant);
  const mapping = cleanMapping(input, new Set(groups.map((g) => g.group)));
  const current = await store.groupTags(tenant);
  const manual = await store.manualTags(tenant);
  const before = tagsUnder(current, groups, manual);
  const after = tagsUnder(mapping, groups, manual);
  const users = await store.listUsers(tenant);
  const names = (list: { tag: string }[] | undefined) => new Set((list ?? []).map((t) => t.tag));
  const changes = users.flatMap((u) => {
    const was = names(before.get(u.id));
    const will = names(after.get(u.id));
    const gains = [...will].filter((t) => !was.has(t)).sort();
    const loses = [...was].filter((t) => !will.has(t)).sort();
    return gains.length || loses.length ? [{ member: { id: u.id, name: u.name, email: u.email }, gains, loses }] : [];
  });
  const fingerprint = createHash("sha256").update(JSON.stringify({ current, mapping, groups, manual })).digest("hex").slice(0, 32);
  return { mapping, preview: { changes, fingerprint } };
}

function ownersOnly(actor: Principal): AccountError | null {
  if (actor.key) return new AccountError("an API key cannot change directory sync", 403);
  return actor.role === "owner" ? null : new AccountError("only an owner changes directory sync", 403);
}

/** Applies a mapping only as it was previewed: the fingerprint has to match what the orchestrator reads now. */
export async function applyMapping(store: AccountStore, tenant: string, actor: Principal, input: { mapping?: unknown; fingerprint?: unknown }): Promise<Preview> {
  const refused = ownersOnly(actor);
  if (refused) throw refused;
  const { mapping, preview } = await previewMapping(store, tenant, input.mapping);
  if (input.fingerprint !== preview.fingerprint) throw new AccountError("the groups or tags changed since this preview; preview again before applying", 409);
  await store.setGroupTags(tenant, mapping);
  return preview;
}

export async function setTagsByHand(store: AccountStore, tenant: string, actor: Principal, userId: string, input: unknown): Promise<void> {
  const user = await store.getUser(tenant, userId);
  if (!user) throw new AccountError("no such member", 404);
  const refused = overreach(actor, user.role);
  if (refused) throw refused;
  if (!Array.isArray(input)) throw new AccountError("tags is a list");
  await store.setManualTags(tenant, userId, [...new Set(input.map(cleanTag))]);
}

function failure(c: Context, err: unknown) {
  if (err instanceof AccountError) return c.json({ error: err.message }, err.status);
  throw err;
}

export function directoryRoutes(ctx: OrchestratorContext): Hono<OrchestratorEnv> {
  const app = new Hono<OrchestratorEnv>();
  const store = ctx.store;
  const managers = (c: Context<OrchestratorEnv>) => (manages(c.get("user")) ? null : c.json({ error: "only an owner or an admin sees directory sync" }, 403));

  app.get("/api/directory", async (c) => {
    const refused = managers(c);
    if (refused) return refused;
    const groups = await store.memberGroups(ctx.tenant);
    const mapping = await store.groupTags(ctx.tenant);
    const counts = new Map<string, number>();
    for (const { group } of groups) counts.set(group, (counts.get(group) ?? 0) + 1);
    return c.json({
      sso: ctx.oidc ? { issuer: ctx.oidc.issuer, groupsClaim: ctx.oidc.groupsClaim } : null,
      groups: [...counts].sort(([a], [b]) => a.localeCompare(b)).map(([group, members]) => ({ group, members, tag: mapping.find((m) => m.group === group)?.tag ?? null })),
    });
  });

  app.post("/api/directory/preview", async (c) => {
    const refused = managers(c);
    if (refused) return refused;
    try {
      const body = (await c.req.json().catch(() => ({}))) as { mapping?: unknown };
      return c.json((await previewMapping(store, ctx.tenant, body.mapping)).preview);
    } catch (err) {
      return failure(c, err);
    }
  });

  app.put("/api/directory", async (c) => {
    try {
      const input = (await c.req.json().catch(() => ({}))) as { mapping?: unknown; fingerprint?: unknown };
      const preview = await applyMapping(store, ctx.tenant, c.get("user"), input);
      const mapping = await store.groupTags(ctx.tenant);
      await recordEvent(ctx, c.get("user"), "directory.applied", {
        subject: "directory",
        detail: `${mapping.map((m) => `${m.group} gives ${m.tag}`).join("; ") || "no group gives a tag"}; ${preview.changes.length} member${preview.changes.length === 1 ? "" : "s"} changed tags`,
      });
      return c.json(preview);
    } catch (err) {
      return failure(c, err);
    }
  });

  app.get("/api/tags", async (c) => {
    const refused = managers(c);
    if (refused) return refused;
    const tags = await memberTags(store, ctx.tenant);
    const users = new Map((await store.listUsers(ctx.tenant)).map((u) => [u.id, u]));
    const byTag = new Map<string, { id: string; name: string; source: string }[]>();
    for (const [userId, list] of tags) {
      const user = users.get(userId);
      if (!user) continue;
      for (const { tag, source } of list) byTag.set(tag, [...(byTag.get(tag) ?? []), { id: user.id, name: user.name, source }]);
    }
    // By name, so the list reads the same at every call; member ids are random.
    return c.json({ tags: [...byTag].sort(([a], [b]) => a.localeCompare(b)).map(([tag, members]) => ({ tag, members: members.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)) })) });
  });

  app.put("/api/members/:id/tags", async (c) => {
    try {
      const body = (await c.req.json().catch(() => ({}))) as { tags?: unknown };
      await setTagsByHand(store, ctx.tenant, c.get("user"), c.req.param("id"), body.tags);
      const manual = (await store.manualTags(ctx.tenant)).filter((t) => t.userId === c.req.param("id")).map((t) => t.tag);
      await recordEvent(ctx, c.get("user"), "account.tags", { subject: `account:${c.req.param("id")}`, detail: `tags by hand: ${manual.join(", ") || "none"}` });
      return c.json({ tags: (await memberTags(store, ctx.tenant)).get(c.req.param("id")) ?? [] });
    } catch (err) {
      return failure(c, err);
    }
  });

  return app;
}
