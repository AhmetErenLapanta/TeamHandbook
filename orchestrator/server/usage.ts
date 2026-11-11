import { rateLimiter } from "./limits.js";
import { randomBytes } from "node:crypto";
import { Hono } from "hono";
import type { UsageCount } from "../shared/activity.js";
import type { OrchestratorContext } from "./app.js";
import { mirrorDir } from "./app.js";
import { readInventory } from "./inventory.js";
import type { SetupFinding } from "./setup.js";

/**
 * Skill-use counts from teammates' machines. The receiver is the one orchestrator route that
 * takes requests nobody signed in for - a hook cannot sign in - so everything it accepts is
 * treated as hostile: a random id per repository in the path instead of a token in a team
 * repository (the plugin's own secret scan would refuse that file), only skill names the
 * repository actually ships, a bounded body, a rate limit, hour-level counts, and no address,
 * user, machine or session ever kept.
 */

export const MAX_BODY_BYTES = 64 * 1024;
export const MAX_EVENTS = 500;
const HOUR = /^\d{4}-\d{2}-\d{2}T\d{2}$/;
const INGEST_ID = /^[A-Za-z0-9_-]{32}$/;
const REPO_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;

export type { UsageCount };

export interface UsageStore {
  ingestId(tenant: string, repoId: string): Promise<string | null>;
  setIngestId(tenant: string, repoId: string, id: string): Promise<void>;
  /** Stops a repository's id counting anything; asking the team again issues a new one. */
  dropIngestId(tenant: string, repoId: string): Promise<void>;
  /** The one repository an id writes to: an id given to one team cannot count another team's skills. */
  repoForIngest(id: string): Promise<{ tenant: string; repoId: string } | null>;
  addUsage(tenant: string, repoId: string, skill: string, hour: string, count: number): Promise<void>;
  usage(tenant: string, sinceHour: string, repoId?: string): Promise<UsageCount[]>;
  /** The same counts summed per day (`YYYY-MM-DD`), for a chart and an export. */
  usageDaily(tenant: string, sinceHour: string, repoId?: string): Promise<DailyUsage[]>;
  /** Deletes counts filed under an hour before `beforeHour`; the number of rows deleted. */
  purgeUsage(tenant: string, beforeHour: string): Promise<number>;
}

export interface DailyUsage { repoId: string; skill: string; day: string; count: number }

export async function ensureIngestId(store: UsageStore, tenant: string, repoId: string): Promise<string> {
  const existing = await store.ingestId(tenant, repoId);
  if (existing) return existing;
  const id = newIngestId();
  await store.setIngestId(tenant, repoId, id);
  return id;
}

export function newIngestId(): string {
  return randomBytes(24).toString("base64url");
}

/** How far back a count may be dated, and how far ahead: a queue waits a few turns, not months. */
export const HOURS_BACK = 31 * 24;
export const HOURS_AHEAD = 1;

/** A real hour inside the window, or null. A string shaped like an hour can still name no hour, or the year 9999. */
export function hourWithinWindow(hour: string, now: number = Date.now()): boolean {
  if (!HOUR.test(hour)) return false;
  const at = Date.parse(`${hour}:00:00Z`);
  if (!Number.isFinite(at) || new Date(at).toISOString().slice(0, 13) !== hour) return false;
  return at >= now - HOURS_BACK * 3_600_000 && at <= now + HOURS_AHEAD * 3_600_000;
}

export function ingestUrl(publicUrl: string, ingest: string, repoId: string): string {
  return `${publicUrl.replace(/\/+$/, "")}/ingest/usage/${ingest}/${repoId}`;
}

/**
 * What the setup panel says about the address a team file sends skill-use counts to, against
 * the one this orchestrator issued for the repository: a team file that names another orchestrator, or
 * an id this orchestrator replaced, has every teammate's count go nowhere without anyone being told.
 * Null when the team file names no address.
 */
export function usageAddressFinding(recorded: string | undefined, publicUrl: string | undefined, ingest: string | null, repoId: string): SetupFinding | null {
  if (recorded === undefined) return null;
  const NEXT = "Merge the request that gives the team a new usage address, or open one under Requests to this repository.";
  if (!publicUrl) {
    return { level: "attention", title: "Skill-use reports cannot be checked", detail: "The team file names an address for skill-use counts, and ORCHESTRATOR_PUBLIC_URL is not set, so this orchestrator cannot tell whether that address is its own.", next: "Set ORCHESTRATOR_PUBLIC_URL to the address teammates reach this orchestrator at." };
  }
  if (ingest !== null && recorded === ingestUrl(publicUrl, ingest, repoId)) {
    return { level: "ok", title: "Skill use is reported here", detail: "Teammates who agreed send this repository's skill-use counts to this orchestrator." };
  }
  if (recorded.startsWith(`${publicUrl.replace(/\/+$/, "")}/ingest/usage/`)) {
    return { level: "attention", title: "Skill-use reports are refused", detail: "The team file carries an address this orchestrator no longer accepts, or never issued for this repository, so every count teammates send is refused.", next: NEXT };
  }
  const elsewhere = URL.canParse(recorded) ? new URL(recorded).origin : "another address";
  return { level: "attention", title: "Skill use is reported elsewhere", detail: `The team file sends skill-use counts to ${elsewhere}, not to this orchestrator at ${publicUrl}.`, next: NEXT };
}

export { rateLimiter };

interface IncomingEvent {
  skill: string;
  hour: string;
}

/** The events a body carries, or the reason it is refused whole. A partly bad batch is refused, not trimmed. */
export function parseBatch(body: unknown, now: number = Date.now()): IncomingEvent[] | string {
  const events = (body as { events?: unknown })?.events;
  if (!Array.isArray(events) || events.length === 0) return "no events";
  if (events.length > MAX_EVENTS) return "too many events";
  const parsed: IncomingEvent[] = [];
  for (const event of events) {
    const { skill, hour } = (event ?? {}) as { skill?: unknown; hour?: unknown };
    if (typeof skill !== "string" || typeof hour !== "string" || !hourWithinWindow(hour, now)) return "malformed event";
    parsed.push({ skill, hour });
  }
  return parsed;
}

const shipped = new Map<string, { head: string; skills: Set<string> }>();

/**
 * The skills a repository ships at its synced head. Reading them means reading the whole tree,
 * and every teammate's batch asks: on a large repository with many ids at their limit, that was
 * most of the orchestrator's work. A commit never changes, so the set is kept per mirror until a
 * sync moves the head; one entry per repository.
 */
async function shippedSkills(mirror: string, head: string): Promise<Set<string>> {
  const known = shipped.get(mirror);
  if (known?.head === head) return known.skills;
  const skills = new Set((await readInventory(mirror, head)).skills.map((s) => s.slug));
  shipped.set(mirror, { head, skills });
  return skills;
}

/** The tenant an ingest id was issued to, or null for an id that is malformed or nobody issued. */
export async function ingestTenant(store: UsageStore, ingest: string): Promise<string | null> {
  if (!INGEST_ID.test(ingest)) return null;
  return (await store.repoForIngest(ingest))?.tenant ?? null;
}

export function usageRoutes(ctx: OrchestratorContext & { usage: UsageStore }, allow = rateLimiter(60)): Hono {
  const app = new Hono();
  app.post("/ingest/usage/:ingest/:repo", async (c) => {
    const ingest = c.req.param("ingest");
    const repoId = c.req.param("repo");
    // Every refusal below answers the same way, so the endpoint does not tell a prober which
    // ids, repositories or skills exist.
    const refuse = () => c.json({ error: "refused" }, 400);
    if (!INGEST_ID.test(ingest) || !REPO_ID.test(repoId)) return refuse();
    // The id is looked up before the limiter sees it, so only ids the orchestrator issued take a
    // place in its table: a flood of made-up ids is refused without crowding out a real one.
    // A real id is 24 random bytes, so learning that a guessed one exists is not a concern.
    const owner = await ctx.usage.repoForIngest(ingest);
    // Ids are looked up across every tenant a shared database holds, so an id this orchestrator did
    // not issue - another tenant's - is refused the same way as one nobody issued.
    if (!owner || owner.tenant !== ctx.tenant || owner.repoId !== repoId) return refuse();
    if (!allow(ingest)) return c.json({ error: "rate limited" }, 429);
    const repo = await ctx.store.getRepo(ctx.tenant, repoId);
    if (!repo?.head) return refuse();
    const length = Number(c.req.header("content-length") ?? NaN);
    if (!Number.isFinite(length) || length > MAX_BODY_BYTES) return refuse();
    const text = await c.req.text();
    if (text.length > MAX_BODY_BYTES) return refuse();
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return refuse();
    }
    const events = parseBatch(body);
    if (typeof events === "string") return refuse();
    // A copy that cannot be read is a refusal like any other here: the caller signed in to
    // nothing, and an error would tell them about the orchestrator's own folders.
    const shipped = await shippedSkills(mirrorDir(ctx, repoId), repo.head).catch(() => null);
    if (!shipped || events.some((e) => !shipped.has(e.skill))) return refuse();
    const counts = new Map<string, number>();
    for (const e of events) counts.set(`${e.skill}\u0000${e.hour}`, (counts.get(`${e.skill}\u0000${e.hour}`) ?? 0) + 1);
    for (const [key, count] of counts) {
      const [skill, hour] = key.split("\u0000");
      await ctx.usage.addUsage(ctx.tenant, repoId, skill!, hour!, count);
    }
    return c.json({ accepted: events.length });
  });
  return app;
}
