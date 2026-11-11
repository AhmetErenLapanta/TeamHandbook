import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import type { OrchestratorContext } from "./app.js";
import { Hono } from "hono";
import { route, ROUTE_SCOPES } from "./route-scopes.js";
import { openSqliteStore } from "./store.js";
import { createVault } from "./vault.js";

/** An organization's orchestrator with every part that adds routes switched on: tasks, jobs, the vault. */
function everyRoute() {
  const ctx = {
    store: openSqliteStore(":memory:"),
    dataDir: "unused",
    tenant: "acme",
    allowedHosts: null,
    vault: createVault(randomBytes(32)),
    // Routes are only registered here, never called, so the runner answers nothing.
    tasks: new Proxy({}, { get: () => () => null }),
    jobs: () => ({ jobs: [], triggerSecret: null }),
  } as unknown as OrchestratorContext;
  const app = createApp(ctx);
  return { app, routes: [...new Set(app.routes.filter((r) => r.method !== "ALL").map((r) => `${r.method} ${r.path}`))] };
}

describe("the table of what each route takes", () => {
  it("given every route an organization's orchestrator registers, when they are set against the table, then each has its row and each row its route", () => {
    // given
    const { routes } = everyRoute();

    // when
    const withoutRow = routes.filter((r) => !(r in ROUTE_SCOPES));
    const withoutRoute = Object.keys(ROUTE_SCOPES).filter((r) => !routes.includes(r));

    // then
    expect(withoutRow).toEqual([]);
    expect(withoutRoute).toEqual([]);
  });

  it("given the table, when each route is called with no session and no key, then the open ones answer and every other one asks to sign in", async () => {
    // given
    const { app, routes } = everyRoute();

    // when
    const answered: string[] = [];
    for (const route of routes) {
      const [method, pattern] = route.split(" ") as [string, string];
      const res = await app.request(pattern.replace(/:[a-zA-Z]+(\{[^}]*\})?/g, "x"), { method, headers: { "content-type": "application/json" }, ...(method === "GET" ? {} : { body: "{}" }) });
      const asked = res.status === 401 && (await res.text()).includes("sign in first");
      if (asked === (ROUTE_SCOPES[route as keyof typeof ROUTE_SCOPES] === "open")) answered.push(route);
    }

    // then
    expect(answered).toEqual([]);
  });
});

describe("registering a route by its row", () => {
  it("given a route in the table, when it is registered through route(), then it answers at its path, and a route with no row does not type-check", async () => {
    // given
    const app = new Hono();

    // when
    route(app, "GET /api/health", (c) => c.json({ ok: true }));
    // @ts-expect-error a route without a row in ROUTE_SCOPES is not a RouteKey
    route(app, "GET /api/nowhere", (c) => c.json({}));

    // then
    expect(await (await app.request("/api/health")).json()).toEqual({ ok: true });
  });
});
