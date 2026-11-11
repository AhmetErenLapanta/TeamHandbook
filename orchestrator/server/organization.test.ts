import type { MiddlewareHandler } from "hono";
import { describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import type { OrchestratorContext } from "./app.js";
import type { OrchestratorEnv, Principal } from "./auth.js";
import { openSqliteStore } from "./store.js";

const OWNER: Principal = { id: "o", name: "Olu Example", email: "olu@example.invalid", role: "owner", ownedTeams: [] };
const ADMIN: Principal = { id: "a", name: "Ada Example", email: "ada@example.invalid", role: "admin", ownedTeams: [] };
const MEMBER: Principal = { id: "m", name: "Max Example", email: "max@example.invalid", role: "member", ownedTeams: [] };

function as(user: Principal): MiddlewareHandler<OrchestratorEnv> {
  return async (c, next) => {
    c.set("user", user);
    await next();
  };
}

const context = (): OrchestratorContext => ({ store: openSqliteStore(":memory:"), dataDir: "/nonexistent", tenant: "acme" });

const rename = (ctx: OrchestratorContext, user: Principal, name: unknown) =>
  createApp(ctx, as(user)).request("/api/org", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ name }) });

describe("the organization's name", () => {
  it("given an org never renamed, when an owner renames it and a member reads it, then the member sees the new name, the tenant stays and the log says who renamed it from what", async () => {
    // given
    const ctx = context();
    const before = await (await createApp(ctx, as(MEMBER)).request("/api/org")).json();

    // when
    const res = await rename(ctx, OWNER, "  Acme Payments  ");
    const after = await (await createApp(ctx, as(MEMBER)).request("/api/org")).json();
    const { events } = await ctx.store.eventPage("acme", {}, null, 10);

    // then
    expect(before).toEqual({ tenant: "acme", name: "acme" });
    expect(res.status).toBe(200);
    expect(after).toEqual({ tenant: "acme", name: "Acme Payments" });
    expect(events.map((e) => [e.kind, e.actor.email, e.subject, e.detail])).toEqual([["org.renamed", OWNER.email, "org:acme", 'renamed the organization from "acme" to "Acme Payments"']]);
  });

  it.each([
    ["an admin", ADMIN, "Acme", 403],
    ["a member", MEMBER, "Acme", 403],
    ["an empty name", OWNER, "   ", 400],
    ["a name with a line break", OWNER, "Acme\nPayments", 400],
    ["a name past 80 characters", OWNER, "A".repeat(81), 400],
    ["a name carrying a token", OWNER, "ghp_abcdefghijklmnopqrstuvwxyz0123456789", 400],
  ])("given %s, when the org is renamed, then it is refused and nothing is written", async (_label, user, name, status) => {
    // given
    const ctx = context();

    // when
    const res = await rename(ctx, user, name);

    // then
    expect(res.status).toBe(status);
    expect(await (await createApp(ctx, as(MEMBER)).request("/api/org")).json()).toEqual({ tenant: "acme", name: "acme" });
    expect((await ctx.store.eventPage("acme", {}, null, 10)).events).toEqual([]);
  });
});
