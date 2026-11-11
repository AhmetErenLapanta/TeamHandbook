import { Hono } from "hono";
import { isId, newId, OLDER_IDS } from "./ids.js";
import { eventSummary } from "./event-summary.js";
import type { OrchestratorContext } from "./app.js";
import { maskUrl } from "./app.js";
import { manages } from "./auth.js";
import type { OrchestratorEnv, Principal } from "./auth.js";
import { detectSecret } from "./plugin.js";
import { EVENT_FLOOR_DAYS } from "./store.js";

/**
 * Who did something the event log records: a person, by the account they were signed in with;
 * a service account, by its key; or the orchestrator itself, at a start. The name and address are
 * the ones the account had then: an account renamed or removed later does not rewrite history.
 */
export interface EventActor {
  kind: "user" | "service" | "orchestrator";
  id: string | null;
  email: string | null;
  name: string | null;
}

export interface OrchestratorEvent {
  tenant: string;
  id: string;
  at: string;
  /** What happened, as `area.what`: `request.opened`, `account.changed`, `repo.disconnected`. */
  kind: string;
  actor: EventActor;
  repoId: string | null;
  /** What it happened to: `request:12`, `account:<id>`, `forge`. */
  subject: string | null;
  detail: string;
}

export interface EventFilter {
  repoId?: string;
  subject?: string;
  kindPrefix?: string;
  since?: string;
  until?: string;
}

export interface EventCursor {
  at: string;
  id: string;
}

export interface EventStore {
  /** The one way a row enters the log; the database refuses to change or delete one younger than its floor. */
  appendEvent(event: OrchestratorEvent): Promise<void>;
  /** Newest first, the rows after `after`. */
  eventPage(tenant: string, filter: EventFilter, after: EventCursor | null, limit: number): Promise<{ events: OrchestratorEvent[]; next: EventCursor | null }>;
  /** One of the tenant's rows, or null for an id it does not hold. */
  getEvent(tenant: string, id: string): Promise<OrchestratorEvent | null>;
  /** The oldest row still kept of each kind asked for, by time then id; a kind with none is left out. */
  firstEvents(tenant: string, kinds: readonly string[]): Promise<Record<string, OrchestratorEvent>>;
  /** The same for each person, by actor id then kind; a row the orchestrator itself wrote, with no actor id, is left out. */
  firstEventsByActor(tenant: string, kinds: readonly string[]): Promise<Record<string, Record<string, OrchestratorEvent>>>;
  /** Deletes a tenant's rows older than `before`; the database keeps every row younger than its floor whatever `before` says. */
  purgeEvents(tenant: string, before: string): Promise<number>;
}

export const ORCHESTRATOR_ACTOR: EventActor = { kind: "orchestrator", id: null, email: null, name: "TeamHandbook Orchestrator" };

export function actorOf(user: Principal): EventActor {
  return { kind: user.id.startsWith("service:") ? "service" : "user", id: user.id, email: user.email, name: user.name };
}

const TEXT_MAX = 500;

/**
 * Text as the log keeps it. Titles, branch names and forge messages come from teammates and
 * forges, so a credential in one is masked before it is stored - the log is read by admins and
 * exported, and it is the persistence boundary secrets are redacted at.
 */
export function loggedText(text: string): string {
  const flat = maskUrl(text).replace(/\p{C}+/gu, " ").trim().slice(0, TEXT_MAX);
  const secret = detectSecret(flat);
  return secret ? `[withheld: it looks like a ${secret}]` : flat;
}

/**
 * Appends one event. A failure to write it fails the call it records: an action the log
 * would not show is one an admin cannot account for afterwards.
 */
export async function recordEvent(
  ctx: Pick<OrchestratorContext, "store" | "tenant">,
  actor: Principal | EventActor,
  kind: string,
  fields: { repoId?: string | null; subject?: string | null; detail: string },
  now = new Date(),
): Promise<void> {
  const by = "role" in actor ? actorOf(actor) : actor;
  await ctx.store.appendEvent({
    tenant: ctx.tenant,
    id: newId("evt", now.getTime()),
    at: now.toISOString(),
    kind,
    actor: { ...by, email: by.email && loggedText(by.email), name: by.name && loggedText(by.name) },
    repoId: fields.repoId ?? null,
    subject: fields.subject ? loggedText(fields.subject) : null,
    detail: loggedText(fields.detail),
  });
}


/** The setting that holds how many days the log keeps; absent, it keeps everything. */
export const RETENTION_SETTING = "events.retentionDays";
export const RETENTION_MAX_DAYS = 3650;

export function retentionProblem(days: unknown): string | null {
  if (days === null) return null;
  if (typeof days !== "number" || !Number.isInteger(days) || days < EVENT_FLOOR_DAYS || days > RETENTION_MAX_DAYS) {
    return `the event log keeps between ${EVENT_FLOOR_DAYS} and ${RETENTION_MAX_DAYS} days, or everything`;
  }
  return null;
}

/** Deletes what the tenant's retention no longer keeps; nothing when it keeps everything. */
export async function purgeOldEvents(ctx: Pick<OrchestratorContext, "store" | "tenant">, now = new Date()): Promise<number> {
  const days = Number(await ctx.store.getSetting(ctx.tenant, RETENTION_SETTING));
  if (!days) return 0;
  return ctx.store.purgeEvents(ctx.tenant, new Date(now.getTime() - days * 86_400_000).toISOString());
}

const COLUMNS = ["at", "kind", "actor_kind", "actor_name", "actor_email", "repo", "subject", "detail"] as const;

function row(e: OrchestratorEvent): Record<(typeof COLUMNS)[number], string> {
  return { at: e.at, kind: e.kind, actor_kind: e.actor.kind, actor_name: e.actor.name ?? "", actor_email: e.actor.email ?? "", repo: e.repoId ?? "", subject: e.subject ?? "", detail: e.detail };
}

/**
 * One CSV field. A cell a spreadsheet would read as a formula - a title a teammate wrote as
 * `=HYPERLINK(...)` - is prefixed so it stays text; quotes are doubled and the field quoted.
 */
export function csvField(value: string): string {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return `"${safe.replace(/"/g, '""')}"`;
}

export function csvHeader(): string {
  return `${COLUMNS.join(",")}\r\n`;
}

export function csvLine(e: OrchestratorEvent): string {
  const r = row(e);
  return `${COLUMNS.map((c) => csvField(r[c])).join(",")}\r\n`;
}

export function jsonLine(e: OrchestratorEvent): string {
  return `${JSON.stringify({ at: e.at, kind: e.kind, actor: e.actor, repo: e.repoId, subject: e.subject, detail: e.detail })}\n`;
}

const PAGE = 100;
const EXPORT_PAGE = 500;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

function cursorOf(given: string | undefined): EventCursor | null | undefined {
  if (given === undefined) return null;
  try {
    const parsed = JSON.parse(Buffer.from(given, "base64url").toString("utf8")) as Partial<EventCursor>;
    return typeof parsed.at === "string" && typeof parsed.id === "string" ? { at: parsed.at, id: parsed.id } : undefined;
  } catch {
    return undefined;
  }
}

function filterOf(query: (name: string) => string | undefined): EventFilter | string {
  const filter: EventFilter = {};
  const repo = query("repo");
  const kind = query("kind");
  const since = query("since");
  const until = query("until");
  if (repo) filter.repoId = repo;
  if (kind) {
    if (!/^[a-z]+(\.[a-z]+)*$/.test(kind)) return "kind is a word or words joined by dots, such as request or account.changed";
    filter.kindPrefix = kind;
  }
  if (since) {
    if (!DAY.test(since)) return "since is a day, as 2026-10-01";
    filter.since = `${since}T00:00:00.000Z`;
  }
  if (until) {
    if (!DAY.test(until)) return "until is a day, as 2026-10-31";
    filter.until = new Date(Date.parse(`${until}T00:00:00.000Z`) + 86_400_000).toISOString();
  }
  return filter;
}

/**
 * The tenant's event log, for an admin: who signed in, changed an account or a setting,
 * connected or disconnected a repository, opened, merged or closed a request. A page at a time
 * on screen, and whole as CSV or JSON lines, read page by page so a long log is not held in
 * memory at once.
 */
export function eventRoutes(ctx: OrchestratorContext): Hono<OrchestratorEnv> {
  const app = new Hono<OrchestratorEnv>();
  // Owners and admins: the log is the record of what both of them do.
  const adminOnly = (user: Principal) => manages(user);

  app.get("/api/events", async (c) => {
    if (!adminOnly(c.get("user"))) return c.json({ error: "only an owner or an admin reads the event log" }, 403);
    const filter = filterOf((n) => c.req.query(n));
    if (typeof filter === "string") return c.json({ error: filter }, 400);
    const after = cursorOf(c.req.query("after"));
    if (after === undefined) return c.json({ error: "after is not a page this orchestrator handed out" }, 400);
    const page = await ctx.store.eventPage(ctx.tenant, filter, after, PAGE);
    const retention = await ctx.store.getSetting(ctx.tenant, RETENTION_SETTING);
    return c.json({
      events: page.events.map((e) => ({ ...e, summary: eventSummary(e) })),
      next: page.next && Buffer.from(JSON.stringify(page.next)).toString("base64url"),
      retentionDays: retention ? Number(retention) : null,
    });
  });

  app.get("/api/events/export", async (c) => {
    if (!adminOnly(c.get("user"))) return c.json({ error: "only an owner or an admin exports the event log" }, 403);
    const format = c.req.query("format") ?? "csv";
    if (format !== "csv" && format !== "jsonl") return c.json({ error: "format is csv or jsonl" }, 400);
    const filter = filterOf((n) => c.req.query(n));
    if (typeof filter === "string") return c.json({ error: filter }, 400);
    const encoder = new TextEncoder();
    const user = c.get("user");
    let after: EventCursor | null = null;
    let started = false;
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (!started && format === "csv") controller.enqueue(encoder.encode(csvHeader()));
        started = true;
        const page = await ctx.store.eventPage(ctx.tenant, filter, after, EXPORT_PAGE);
        controller.enqueue(encoder.encode(page.events.map(format === "csv" ? csvLine : jsonLine).join("")));
        after = page.next;
        if (after) return;
        // Written once the export is read to its end, so it is not part of the export it records.
        await recordEvent(ctx, user, "events.exported", { detail: `exported the event log as ${format === "csv" ? "CSV" : "JSON lines"}` });
        controller.close();
      },
    });
    const day = new Date().toISOString().slice(0, 10);
    return new Response(body, {
      headers: {
        "content-type": format === "csv" ? "text/csv; charset=utf-8" : "application/x-ndjson; charset=utf-8",
        "content-disposition": `attachment; filename="orchestrator-events-${day}.${format}"`,
        "cache-control": "no-store",
      },
    });
  });

  app.put("/api/events/retention", async (c) => {
    if (!adminOnly(c.get("user"))) return c.json({ error: "only an admin sets how long the event log keeps" }, 403);
    const { days } = (await c.req.json().catch(() => ({}))) as { days?: unknown };
    const problem = retentionProblem(days ?? null);
    if (problem) return c.json({ error: problem }, 400);
    const kept = (days ?? null) as number | null;
    if (kept === null) await ctx.store.deleteSetting(ctx.tenant, RETENTION_SETTING);
    else await ctx.store.setSetting(ctx.tenant, RETENTION_SETTING, String(kept));
    await recordEvent(ctx, c.get("user"), "events.retention", { detail: kept === null ? "the event log keeps everything" : `the event log keeps ${kept} days` });
    const purged = await purgeOldEvents(ctx);
    return c.json({ retentionDays: kept, purged });
  });

  // One entry and the address of its page, so a notification, a request or a message can point at it.
  app.get("/api/events/:id", async (c) => {
    if (!adminOnly(c.get("user"))) return c.json({ error: "only an owner or an admin reads the event log" }, 403);
    const id = c.req.param("id");
    const event = isId("evt", id, OLDER_IDS.event) ? await ctx.store.getEvent(ctx.tenant, id) : null;
    if (!event) return c.json({ error: "there is no such entry in the event log, or it is past the log's retention" }, 404);
    const base = (ctx.publicUrl ?? new URL(c.req.url).origin).replace(/\/+$/, "");
    return c.json({ event: { ...event, summary: eventSummary(event) }, link: `${base}/${encodeURIComponent(ctx.tenant)}/activity/audit/${encodeURIComponent(id)}` });
  });

  return app;
}
