import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import type { MiddlewareHandler } from "hono";
import { createApp } from "./app.js";
import type { OrchestratorContext } from "./app.js";
import type { OrchestratorEnv, Principal } from "./auth.js";
import { eventSummary } from "./event-summary.js";
import { csvField, ORCHESTRATOR_ACTOR, loggedText, purgeOldEvents, recordEvent, RETENTION_SETTING } from "./events.js";
import { openSqliteStore } from "./store.js";

const ADMIN: Principal = { id: "a", name: "Ada Example", email: "ada@example.invalid", role: "admin", ownedTeams: [] };
const MEMBER: Principal = { id: "m", name: "Max Example", email: "max@example.invalid", role: "member", ownedTeams: [] };

function as(user: Principal): MiddlewareHandler<OrchestratorEnv> {
  return async (c, next) => {
    c.set("user", user);
    await next();
  };
}

function context(tenant = "acme"): OrchestratorContext {
  return { store: openSqliteStore(":memory:"), dataDir: "/nonexistent", tenant };
}

describe("the event log", () => {
  it("given events recorded for two tenants of one store, when each tenant's log is read, then it holds only its own, newest first", async () => {
    // given
    const store = openSqliteStore(":memory:");
    const acme = { store, tenant: "acme" };
    const globex = { store, tenant: "globex" };
    await recordEvent(acme, ADMIN, "account.created", { detail: "first" }, new Date("2026-10-20T10:00:00Z"));
    await recordEvent(globex, ADMIN, "account.created", { detail: "theirs" }, new Date("2026-10-21T10:00:00Z"));
    await recordEvent(acme, ADMIN, "account.changed", { detail: "second" }, new Date("2026-10-22T10:00:00Z"));

    // when
    const page = await store.eventPage("acme", {}, null, 10);

    // then
    expect(page.events.map((e) => e.detail)).toEqual(["second", "first"]);
  });

  it("given a recorded event, when any statement changes it or deletes it while it is young, then the database refuses", async () => {
    // given
    const dir = mkdtempSync(join(tmpdir(), "orchestrator-events-"));
    const file = join(dir, "orchestrator.db");
    const store = openSqliteStore(file);
    await recordEvent({ store, tenant: "acme" }, ADMIN, "account.created", { detail: "kept" });
    const raw = new DatabaseSync(file);

    try {
      // when
      const update = () => raw.exec("UPDATE events SET detail = 'rewritten'");
      const remove = () => raw.exec("DELETE FROM events");
      const purge = await store.purgeEvents("acme", new Date(Date.now() + 86_400_000).toISOString()).catch((err: Error) => err);

      // then
      expect(update).toThrow("the event log is append-only");
      expect(remove).toThrow("an event younger than 30 days is kept");
      expect(String(purge)).toContain("an event younger than 30 days is kept");
      expect((await store.eventPage("acme", {}, null, 10)).events.map((e) => e.detail)).toEqual(["kept"]);
    } finally {
      raw.close();
      await store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("given a title carrying a token and a control character, when it is recorded, then the log keeps neither", async () => {
    // given
    const ctx = context();

    // when
    await recordEvent(ctx, ADMIN, "request.opened", { subject: "request:1", detail: '"fix" pushed with https://oauth2:glpat-Zx9Qw8Er7Ty6Ui5Op4As@git.example.invalid/x.git\u001b[2J' });

    // then
    const [event] = (await ctx.store.eventPage("acme", {}, null, 10)).events;
    expect(event!.detail).not.toContain("glpat-");
    expect(event!.detail).not.toContain("\u001b");
    expect(loggedText("token ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789")).toBe("[withheld: it looks like a github-token]");
  });

  it.each([["=HYPERLINK(\"x\")"], ["+1+1"], ["-2"], ["@SUM(A1)"]])("given a cell %j, when it is written to CSV, then a spreadsheet reads it as text", (value) => {
    expect(csvField(value)).toBe(`"'${value.replace(/"/g, '""')}"`);
  });

  it("given a retention of 30 days and events of 40 and of 10 days ago, when old events are purged, then only the older goes", async () => {
    // given
    const ctx = context();
    const now = new Date("2026-10-25T12:00:00Z");
    await recordEvent(ctx, ADMIN, "account.created", { detail: "old" }, new Date(now.getTime() - 40 * 86_400_000));
    await recordEvent(ctx, ADMIN, "account.created", { detail: "recent" }, new Date(now.getTime() - 10 * 86_400_000));
    await ctx.store.setSetting("acme", RETENTION_SETTING, "30");

    // when
    const purged = await purgeOldEvents(ctx, now);

    // then
    expect(purged).toBe(1);
    expect((await ctx.store.eventPage("acme", {}, null, 10)).events.map((e) => e.detail)).toEqual(["recent"]);
  });
});

describe("the event log over HTTP", () => {
  it("given a member, when they ask for the log, its export or its retention, then each is refused", async () => {
    const app = createApp(context(), as(MEMBER));
    expect((await app.request("/api/events")).status).toBe(403);
    expect((await app.request("/api/events/export")).status).toBe(403);
    expect((await app.request("/api/events/retention", { method: "PUT", body: "{}", headers: { "content-type": "application/json" } })).status).toBe(403);
  });

  it("given an admin and more events than a page, when the log is read page by page and exported, then every event comes once and the export says who exported", async () => {
    // given
    const ctx = context();
    for (let i = 0; i < 130; i++) await recordEvent(ctx, ADMIN, "account.changed", { detail: `change ${i}` }, new Date(Date.UTC(2026, 9, 1) + i * 60_000));
    const app = createApp(ctx, as(ADMIN));

    // when
    const first = await (await app.request("/api/events")).json();
    const second = await (await app.request(`/api/events?after=${first.next}`)).json();
    const jsonl = await (await app.request("/api/events/export?format=jsonl&until=2099-12-31")).text();
    const csv = await (await app.request("/api/events/export?format=csv&until=2099-12-31")).text();

    // then
    expect(first.events).toHaveLength(100);
    expect(second.events).toHaveLength(30);
    expect(second.next).toBeNull();
    expect(new Set([...first.events, ...second.events].map((e: { detail: string }) => e.detail)).size).toBe(130);
    expect(jsonl.trim().split("\n")).toHaveLength(130);
    const lines = csv.trim().split("\r\n");
    expect(lines[0]).toBe("at,kind,actor_kind,actor_name,actor_email,repo,subject,detail");
    expect(lines.slice(1).filter((l) => l.includes('"events.exported"'))).toHaveLength(1);
    expect(lines).toHaveLength(1 + 130 + 1);
    expect((await ctx.store.eventPage("acme", { kindPrefix: "events.exported" }, null, 10)).events).toHaveLength(2);
  });

  it.each([[10], [5000], ["30"]])("given a retention of %j, when an admin sets it, then it is refused", async (days) => {
    const app = createApp(context(), as(ADMIN));
    const res = await app.request("/api/events/retention", { method: "PUT", body: JSON.stringify({ days }), headers: { "content-type": "application/json" } });
    expect(res.status).toBe(400);
  });
});

describe("one entry of the event log", () => {
  const OWNER: Principal = { id: "o", name: "Olu Example", email: "olu@example.invalid", role: "owner", ownedTeams: [] };

  it("given an entry of this org and one of another org on the same store, when an owner opens each by id, then the first comes back with its page's address and the second is not found", async () => {
    // given
    const ctx = { ...context(), publicUrl: "https://orchestrator.example.invalid/" };
    await recordEvent(ctx, ADMIN, "forge.set", { repoId: "payments-skills", detail: "set the forge access" });
    await recordEvent({ ...ctx, tenant: "globex" }, ADMIN, "forge.set", { detail: "theirs" });
    const [mine] = (await ctx.store.eventPage("acme", {}, null, 1)).events;
    const [theirs] = (await ctx.store.eventPage("globex", {}, null, 1)).events;
    const app = createApp(ctx, as(OWNER));

    // when
    const found = await app.request(`/api/events/${mine!.id}`);
    const elsewhere = await app.request(`/api/events/${theirs!.id}`);
    const listed = await app.request("/api/events");
    const exported = await app.request("/api/events/export?format=jsonl");

    // then
    expect(await found.json()).toEqual({ event: { ...mine, summary: "Ada Example set a repository's GitLab or GitHub access" }, link: `https://orchestrator.example.invalid/acme/activity/audit/${mine!.id}` });
    expect(elsewhere.status).toBe(404);
    expect(listed.status).toBe(200);
    expect([exported.status, exported.headers.get("content-type")]).toEqual([200, "application/x-ndjson; charset=utf-8"]);
  });

  it.each([
    ["a member", MEMBER, "valid", 403],
    ["an id the orchestrator never writes", ADMIN, "../export", 404],
  ])("given %s, when an entry is opened, then it is refused", async (_label, user, id, status) => {
    // given
    const ctx = context();
    await recordEvent(ctx, ADMIN, "forge.set", { detail: "set the forge access" });
    const [entry] = (await ctx.store.eventPage("acme", {}, null, 1)).events;

    // when
    const res = await createApp(ctx, as(user)).request(`/api/events/${id === "valid" ? entry!.id : encodeURIComponent(id)}`);

    // then
    expect(res.status).toBe(status);
  });
});

describe("every refusal in one shape", () => {
  it("given a refusal a route writes itself, one thrown as an OrchestratorError and the receiver's own, when each is answered, then the first two carry a code beside the message and the receiver's answer is left as it was", async () => {
    // given
    const app = createApp(context(), as(MEMBER));

    // when
    const forbidden = await app.request("/api/events");
    const unknown = await app.request("/api/repos/nope/inventory");
    const refusedByAccount = await app.request("/api/me/password", { method: "POST", body: JSON.stringify({}), headers: { "content-type": "application/json" } });
    const ingest = await app.request("/ingest/usage/x/y", { method: "POST", body: "{}", headers: { "content-type": "application/json" } });

    // then
    expect(await forbidden.json()).toEqual({ error: "only an owner or an admin reads the event log", code: "forbidden" });
    expect(await unknown.json()).toEqual({ error: "unknown repository", code: "not-found" });
    expect([refusedByAccount.status, (await refusedByAccount.json()).code]).toEqual([401, "signed-out"]);
    expect(await ingest.text()).toBe(JSON.stringify({ error: "refused" }));
  });
});

describe("an entry said as a person says it", () => {
  const user = { kind: "user" as const, id: "u", email: "lee@example.invalid", name: "Lee Lead" };
  it.each([
    ["the orchestrator set up", { kind: "orchestrator.setup", actor: user, subject: "account:u", detail: "created the first owner with the setup code" }, "Lee Lead set up the orchestrator"],
    ["a request the orchestrator merged", { kind: "request.merged", actor: ORCHESTRATOR_ACTOR, subject: "request:4", detail: 'GitLab says "x" is merged' }, "System merged request #4"],
    ["a kind the list does not know", { kind: "something.new", actor: user, subject: null, detail: "did something new" }, "Lee Lead did something new"],
    ["a person with no name", { kind: "account.signin", actor: { ...user, name: null }, subject: null, detail: "signed in" }, "lee@example.invalid signed in"],
  ])("given %s, when its summary is read, then it says who did what", (_label, event, said) => {
    expect(eventSummary(event)).toBe(said);
  });

  it("given an entry in the list the Activity page reads, when the log is read, then each entry carries its summary", async () => {
    // given
    const ctx = context();
    await recordEvent(ctx, ADMIN, "orchestrator.setup", { subject: "account:a", detail: "created the first owner with the setup code" });

    // when
    const { events } = await (await createApp(ctx, as(ADMIN)).request("/api/events")).json();

    // then
    expect(events.map((e: { kind: string; summary: string }) => [e.kind, e.summary])).toEqual([["orchestrator.setup", "Ada Example set up the orchestrator"]]);
  });
});
