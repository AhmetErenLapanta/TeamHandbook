import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { seed } from "../demo/seed.js";
import { principalOf, setupFirstOwner, startSession } from "./accounts.js";
import { createApp, syncRepo } from "./app.js";
import type { OrchestratorContext } from "./app.js";
import { sessionCookie } from "./auth.js";
import type { OidcClient } from "./oidc.js";
import { storeKeys } from "./integrations/keys.js";
import { browserMark } from "./integrations/mcp-oauth.js";
import { PENDING_SIGN_INS, signInCookie } from "./integrations/personal-mcp.js";
import { invite } from "./invites.js";
import { createKey } from "./keys.js";
import { orgRoutes } from "./orgs.js";
import { openSqliteStore } from "./store.js";
import type { Store } from "./store.js";
import { ensureIngestId } from "./usage.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const CODE = "setup-code-for-tests";
const PASSWORD = "correct horse battery";
const OPTIONS = { mode: "local" as const, secure: false, allowedHosts: null };

/** A provider that lets anyone through as the identity given, without a network. */
function provider(identity: { subject: string; email: string; name: string }): OidcClient {
  let n = 0;
  return {
    issuer: "https://idp.example.invalid",
    groupsClaim: "groups",
    start: async () => {
      const state = `state-${++n}`;
      return { url: "https://idp.example.invalid/authorize", login: { state, nonce: "n", verifier: "v", expiresAt: new Date(Date.now() + 600_000).toISOString() } };
    },
    finish: async () => ({ issuer: "https://idp.example.invalid", ...identity }),
  };
}

/** Two orgs on one store, each with an owner; `sso` is the provider the second org takes. */
async function twoOrgs(sso: OidcClient | null = null): Promise<{ store: Store; app: ReturnType<typeof orgRoutes> }> {
  const store = openSqliteStore(":memory:");
  await setupFirstOwner(store, "acme", CODE, { code: CODE, email: "ada@example.invalid", name: "Ada", password: PASSWORD });
  await setupFirstOwner(store, "beta", CODE, { code: CODE, email: "bo@example.invalid", name: "Bo", password: PASSWORD });
  const org = (tenant: string, oidc: OidcClient | null) => {
    const ctx: OrchestratorContext = { store, dataDir: "unused", tenant, allowedHosts: null, oidc, apiKeys: storeKeys(store, tenant), ...(tenant === "acme" ? {} : { webBase: `/${tenant}/` }) };
    return { ctx, app: createApp(ctx) };
  };
  return { store, app: orgRoutes([org("acme", null), org("beta", sso)], OPTIONS) };
}

function cookieOf(res: Response): string {
  return res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
}

describe("one orchestrator serving several orgs", () => {
  it("given a browser signed in to the second org only, when it reads each org and one the orchestrator does not serve, then only the second org answers it and the picker names only that org", async () => {
    // given
    const { store, app } = await twoOrgs();
    const bo = (await store.getUserByEmail("beta", "bo@example.invalid"))!;
    const session = await startSession(store, "beta", bo.id);
    const headers = { cookie: `${sessionCookie("beta")}=${session.token}` };

    // when
    const beta = await app.request("/api/orgs/beta/me", { headers });
    const acme = await app.request("/api/orgs/acme/me", { headers });
    const unprefixed = await app.request("/api/me", { headers });
    const unknown = await app.request("/api/orgs/gamma/me", { headers });
    const picker = await (await app.request("/api/orgs", { headers })).json();

    // then
    expect(beta.status).toBe(200);
    expect((await beta.json()).user).toMatchObject({ name: "Bo", role: "owner" });
    expect(acme.status).toBe(401);
    expect(unprefixed.status).toBe(401);
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toEqual({ error: "this orchestrator does not serve that organization", code: "unknown-org" });
    expect(picker).toEqual({ default: "acme", orgs: [{ tenant: "beta", orgName: "beta", name: "Bo", role: "owner" }] });
  });

  it("given the owner of the second org, when they sign in under its prefix, then the session is that org's and the first org's paths still refuse it", async () => {
    // given
    const { app } = await twoOrgs();

    // when
    const login = await app.request("/api/orgs/beta/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "bo@example.invalid", password: PASSWORD }) });
    const cookie = cookieOf(login);
    const me = await app.request("/api/orgs/beta/me", { headers: { cookie } });
    const first = await app.request("/api/me", { headers: { cookie } });

    // then
    expect(login.status).toBe(200);
    expect(cookie).toContain(sessionCookie("beta"));
    expect((await me.json()).user.name).toBe("Bo");
    expect(first.status).toBe(401);
  });

  it("given an invitation from the second org, when its link is opened and accepted, then the person joins the second org and not the first", async () => {
    // given
    const { store, app } = await twoOrgs();
    const bo = await principalOf(store, (await store.getUserByEmail("beta", "bo@example.invalid"))!);
    const { invited } = await invite(store, "beta", new Set(), { emails: "di@example.invalid", role: "member" }, bo);
    const token = invited[0]!.token;

    // when
    const read = await app.request("/api/join/read", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) });
    const joined = await app.request("/api/join", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token, name: "Di", password: PASSWORD }) });

    // then
    expect(read.status).toBe(200);
    expect((await read.json()).invite).toMatchObject({ email: "di@example.invalid" });
    expect(joined.status).toBe(200);
    expect(cookieOf(joined)).toContain(sessionCookie("beta"));
    expect(await store.getUserByEmail("beta", "di@example.invalid")).toMatchObject({ name: "Di" });
    expect(await store.getUserByEmail("acme", "di@example.invalid")).toBeNull();
  });

  it("given single sign-on taken by the second org only, when someone signs in through it there, then the provider's answer at the one callback address lands in that org, and the first org offers no sign-on", async () => {
    // given
    const { store, app } = await twoOrgs(provider({ subject: "cy-1", email: "cy@example.invalid", name: "Cy" }));

    // when
    const start = await app.request("/api/orgs/beta/auth/oidc/start");
    const state = cookieOf(start);
    const back = await app.request(`/api/auth/oidc/callback?state=state-1&code=c`, { headers: { cookie: state } });
    const elsewhere = await app.request("/api/orgs/acme/auth/oidc/start");

    // then
    expect(start.status).toBe(302);
    expect(back.status).toBe(302);
    expect(back.headers.get("location")).toBe("/beta/");
    expect(cookieOf(back)).toContain(sessionCookie("beta"));
    expect(await store.getUserByEmail("beta", "cy@example.invalid")).toMatchObject({ name: "Cy", role: "member" });
    expect(await store.getUserByEmail("acme", "cy@example.invalid")).toBeNull();
    expect(elsewhere.status).toBe(404);
  });

  it("given a key of the second org, when it calls the orchestrator's one MCP address, then the second org answers it", async () => {
    // given
    const { store, app } = await twoOrgs();
    const bo = await principalOf(store, (await store.getUserByEmail("beta", "bo@example.invalid"))!);
    const { secret } = await createKey(store, "beta", bo, { name: "assistant", scopes: { repositories: "read", requests: "read", tasks: "none", usage: "none", members: "none", settings: "none", keys: "none" } });
    const initialize = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } };

    // when
    const res = await app.request("/mcp", { method: "POST", headers: { authorization: `Bearer ${secret}`, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify(initialize) });

    // then
    expect(res.status).toBe(200);
    expect((await res.json()).result.serverInfo).toBeDefined();
  });

  it("given an MCP server sign-in begun in the second org, when the server sends the browser back, then the second org takes the return and the first never sees its state", async () => {
    // given
    const { app } = await twoOrgs();
    const browser = browserMark();
    const state = PENDING_SIGN_INS.add({ tenant: "beta", user: { id: "u", name: "Bo", email: "bo@example.invalid" }, server: "tracker", verifier: "v", tokenEndpoint: "http://127.0.0.1:9/token", clientId: "c", clientSecret: null, redirectUri: "http://127.0.0.1/cb", resource: "http://127.0.0.1:9/mcp", browser: browser.hash });

    // when
    const back = await app.request(`/integrations/mcp-oauth/callback?state=${state}`, { headers: { cookie: `${signInCookie(false).name}=${browser.value}` } });

    // then
    expect(back.status).toBe(302);
    expect(back.headers.get("location")).toContain(encodeURIComponent("The sign-in to tracker was not completed."));
  });

  it("given a team file's usage address issued by the second org, when a batch arrives at it, then the second org counts it", async () => {
    // given
    const root = mkdtempSync(join(tmpdir(), "orchestrator-orgs-"));
    dirs.push(root);
    const config = JSON.parse(readFileSync(seed(join(root, "demo")).configFile, "utf8"));
    const store = openSqliteStore(":memory:");
    const first: OrchestratorContext = { store, dataDir: join(root, "data"), tenant: "acme", allowedHosts: null };
    const second: OrchestratorContext = { ...first, tenant: config.tenant };
    for (const repo of config.repos) {
      await store.upsertRepo({ ...repo, tenant: second.tenant });
      await syncRepo(second, repo.id);
    }
    const ingest = await ensureIngestId(store, second.tenant, "payments-skills");
    const app = orgRoutes([{ ctx: first, app: createApp(first) }, { ctx: second, app: createApp(second) }], OPTIONS);
    const body = JSON.stringify({ events: [{ skill: "release-checklist", hour: new Date(Date.now() - 3_600_000).toISOString().slice(0, 13) }] });

    // when
    const res = await app.request(`/ingest/usage/${ingest}/payments-skills`, { method: "POST", body, headers: { "content-type": "application/json", "content-length": String(body.length) } });

    // then
    expect(res.status).toBe(200);
    expect((await store.usage(second.tenant, "1970-01-01T00")).map((u) => [u.skill, u.count])).toEqual([["release-checklist", 1]]);
  });
});

describe("routes an organization's prefix reaches", () => {
  // Answered without a member's session on purpose: liveness, the sign-in page's settings and its
  // provider round trip, an invitation read and accepted by its token; and a local orchestrator's
  // sign-in mode, which every orchestrator answers, and the one-time address its command prints and the button that spends it, which answer 404 on any other;
  // an attachment's signed download address, which answers the same 404 to any address it did not sign;
  // a machine's hello and its claim of a one-time code, made before it holds any credential; and
  // its calls, each checked against the machine's own signature and then its lease or, for its
  // answer to a folder list or an undo, the ask's nonce, never a session.
  const OPEN = ["GET /api/health", "GET /api/auth/config", "GET /api/auth/oidc/start", "GET /api/auth/oidc/callback", "POST /api/join/read", "POST /api/join", "GET /api/identity/config", "GET /api/auth/local", "POST /api/auth/local", "GET /api/attachments/:att", "GET /api/runner/hello", "POST /api/runner/claim", "POST /api/runner/poll", "POST /api/runner/status", "POST /api/runner/tasks/:id/renew", "POST /api/runner/tasks/:id/events", "POST /api/runner/tasks/:id/requests", "POST /api/runner/tasks/:id/progress", "POST /api/runner/tasks/:id/follow-ups", "POST /api/runner/tasks/:id/attachments/:att", "POST /api/runner/tasks/:id/request", "POST /api/runner/tasks/:id/finish", "POST /api/runner/folders/:nonce", "POST /api/runner/undos/:nonce", "POST /api/runner/checks/:nonce", "POST /api/runner/lessons/:nonce", "POST /api/runner/lesson-ops/:nonce", "POST /api/runner/pushes/:nonce"];

  it("given a browser signed in to the second org only, when it calls every route of the first org's app under the first org's prefix, then each one refuses it but the routes open by design", async () => {
    // given
    const { store, app } = await twoOrgs();
    const bo = (await store.getUserByEmail("beta", "bo@example.invalid"))!;
    const session = await startSession(store, "beta", bo.id);
    const ctx: OrchestratorContext = { store, dataDir: "unused", tenant: "acme", allowedHosts: null, oidc: null, apiKeys: storeKeys(store, "acme") };
    const routes = createApp(ctx).routes.filter((r) => r.method !== "ALL" && r.path.startsWith("/api/"));

    // when
    const answered: string[] = [];
    for (const route of routes) {
      const path = route.path.replace(/:[A-Za-z]+(\{[^}]*\})?/g, "x").replace(/\*$/, "x");
      const res = await app.request(`/api/orgs/acme${path.slice("/api".length)}`, {
        method: route.method,
        headers: { cookie: `${sessionCookie("beta")}=${session.token}`, "content-type": "application/json" },
        ...(route.method === "GET" || route.method === "HEAD" ? {} : { body: "{}" }),
      });
      // A 404 counts as answered too: a route that looks a record up before it asks who is calling would leak through it.
      if (![401, 403, 405].includes(res.status)) answered.push(`${route.method} ${route.path}`);
    }

    // then
    expect(routes.length).toBeGreaterThan(100);
    expect(answered.sort()).toEqual([...OPEN].sort());
  });
});
