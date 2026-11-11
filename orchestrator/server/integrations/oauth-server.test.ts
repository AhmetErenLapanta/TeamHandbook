import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import type { ServerType } from "@hono/node-server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { OAuthClientInformationMixed, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { afterEach, describe, expect, it } from "vitest";
import { seed } from "../../demo/seed.js";
import { createUser, principalOf, setupFirstOwner, startSession } from "../accounts.js";
import { createApp, syncRepo } from "../app.js";
import type { OrchestratorContext } from "../app.js";
import { orchestratorAuth, CSRF_HEADER, sessionCookie } from "../auth.js";
import type { AuthMode } from "../auth.js";
import { orgRoutes } from "../orgs.js";
import { openSqliteStore } from "../store.js";
import { createVault } from "../vault.js";
import { storeKeys } from "./keys.js";
import { OAUTH_LIMITS, oauthPrincipal, oauthRoutes } from "./oauth-server.js";

const CODE = "setup-code-for-tests";
const PASSWORD = "correct horse battery";
const REDIRECT = "http://127.0.0.1:9/callback";

const dirs: string[] = [];
const servers: ServerType[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((resolve) => s.close(resolve))));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** One org on an orchestrator listening on this machine, its public address its own, with a signed-in owner and member. */
async function orchestrator_(mode: AuthMode = "local") {
  const root = mkdtempSync(join(tmpdir(), "orchestrator-oauth-"));
  dirs.push(root);
  const config = JSON.parse(readFileSync(seed(join(root, "demo")).configFile, "utf8"));
  let handler: (request: Request) => Response | Promise<Response> = () => new Response(null, { status: 503 });
  const server = await new Promise<ServerType>((resolve) => {
    const s = serve({ fetch: (r) => handler(r), hostname: "127.0.0.1", port: 0 }, () => resolve(s));
  });
  servers.push(server);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const store = openSqliteStore(":memory:");
  const logged: string[] = [];
  const ctx: OrchestratorContext = {
    store,
    dataDir: join(root, "data"),
    tenant: config.tenant,
    publicUrl: base,
    vault: createVault(randomBytes(32)),
    allowedHosts: null,
    apiKeys: storeKeys(store, config.tenant),
    audit: async (actor, kind, fields) => void logged.push(`${actor.id} ${kind} ${fields.detail}`),
  };
  for (const repo of config.repos) {
    await store.upsertRepo({ ...repo, tenant: config.tenant });
    await syncRepo(ctx, repo.id);
  }
  const owner = await setupFirstOwner(store, ctx.tenant, CODE, { code: CODE, email: "ada@example.invalid", name: "Ada", password: PASSWORD });
  const member = await createUser(store, ctx.tenant, new Set(["Payments", "Platform"]), { email: "max@example.invalid", name: "Max", role: "member", password: PASSWORD }, await principalOf(store, owner));
  const cookieOf = async (userId: string) => `${sessionCookie(ctx.tenant)}=${(await startSession(store, ctx.tenant, userId)).token}`;
  const app = orgRoutes([{ ctx, app: createApp(ctx, orchestratorAuth(store, ctx.tenant, mode)) }], { mode, secure: false, allowedHosts: null });
  handler = (r) => app.fetch(r);
  return { ctx, base, owner: await cookieOf(owner.id), member: await cookieOf(member.id), memberId: member.id, logged };
}

/** An MCP client's sign-in state, kept in memory as Claude Code keeps it on disk; the authorization page it would open is recorded. */
function provider(scope?: string) {
  const kept: { client?: OAuthClientInformationMixed; tokens?: OAuthTokens; verifier?: string; opened?: URL } = {};
  const p: OAuthClientProvider = {
    get redirectUrl() {
      return REDIRECT;
    },
    get clientMetadata() {
      return { client_name: "Claude Code", redirect_uris: [REDIRECT], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none", ...(scope ? { scope } : {}) };
    },
    clientInformation: () => kept.client,
    saveClientInformation: (info) => void (kept.client = info),
    tokens: () => kept.tokens,
    saveTokens: (tokens) => void (kept.tokens = tokens),
    redirectToAuthorization: (url) => void (kept.opened = url),
    saveCodeVerifier: (v) => void (kept.verifier = v),
    codeVerifier: () => kept.verifier!,
  };
  return { p, kept };
}

/** The person's part: open the approval page in a browser holding `cookie`, and press a button with the write scopes ticked. */
async function approve(page: URL, cookie: string, decision: "approve" | "deny" = "approve", ticked: string[] = ["requests:write", "tasks:write"]): Promise<Response> {
  const shown = await fetch(page, { headers: { cookie } });
  const html = await shown.text();
  const consent = /name="consent" value="([^"]+)"/.exec(html)?.[1];
  const org = /name="org" value="([^"]+)"/.exec(html)?.[1];
  const reads = [...html.matchAll(/type="hidden" name="scope" value="([^"]+)"/g)].map((m) => m[1]!);
  const form = new URLSearchParams({ consent: consent ?? "", org: org ?? "", decision });
  for (const s of [...reads, ...ticked]) form.append("scope", s);
  return fetch(new URL("/oauth/authorize", page), { method: "POST", headers: { cookie, "content-type": "application/x-www-form-urlencoded" }, body: form, redirect: "manual" });
}

/** Connects as Claude Code does: a 401 sends it to sign in, the person approves, and the client connects again with its tokens. */
async function connected(base: string, cookie: string, ticked?: string[]) {
  const { p, kept } = provider();
  const url = new URL(`${base}/mcp`);
  await expect(new Client({ name: "claude-code", version: "1" }).connect(new StreamableHTTPClientTransport(url, { authProvider: p }))).rejects.toThrow();
  const back = await approve(kept.opened!, cookie, "approve", ticked);
  const code = new URL(back.headers.get("location")!).searchParams.get("code")!;
  await new StreamableHTTPClientTransport(url, { authProvider: p }).finishAuth(code);
  const client = new Client({ name: "claude-code", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(url, { authProvider: p }));
  return { client, kept };
}

describe("the orchestrator's authorization server, through the official MCP client", () => {
  it("given a signed-in owner, when an MCP client with no key connects, then it is sent to approve in the browser and, approved, reaches the tools as that owner", async () => {
    // given
    const { base, owner, logged } = await orchestrator_();

    // when
    const { client, kept } = await connected(base, owner);
    const tools = (await client.listTools()).tools.map((t) => t.name);

    // then
    expect(kept.opened!.origin + kept.opened!.pathname).toBe(`${base}/oauth/authorize`);
    expect(kept.tokens!.access_token).toMatch(/^th_oa\./);
    expect(tools).toContain("propose_change");
    expect(logged.some((l) => l.includes("oauth.approved") && l.includes("allowed Claude Code to reach the orchestrator's MCP server"))).toBe(true);
    await client.close();
  });

  it("given the write scopes left unticked, when the client connects, then it reads but is offered no tool that proposes or starts anything", async () => {
    // given
    const { base, owner } = await orchestrator_();

    // when
    const { client } = await connected(base, owner, []);
    const tools = (await client.listTools()).tools.map((t) => t.name);

    // then
    expect(tools).toEqual(["list_repositories", "get_repository", "list_requests", "list_policies", "list_my_tasks"]);
    await client.close();
  });

  it("given an issued refresh token, when it is used, then a new pair works and the used one is spent; revoking the pair turns the client away", async () => {
    // given
    const { base, owner } = await orchestrator_();
    const { client, kept } = await connected(base, owner);
    await client.close();
    const first = kept.tokens!;
    const refresh = (token: string) => fetch(`${base}/oauth/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: token }) });
    const list = (token: string) => fetch(`${base}/mcp`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });

    // when
    const renewed = await (await refresh(first.refresh_token!)).json();
    const again = await refresh(first.refresh_token!);
    const oldAccess = await list(first.access_token);
    const newAccess = await list(renewed.access_token);
    await fetch(`${base}/oauth/revoke`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token: renewed.refresh_token }) });
    const revoked = await list(renewed.access_token);

    // then
    expect(again.status).toBe(400);
    expect(oldAccess.status).toBe(401);
    expect(newAccess.status).toBe(200);
    expect(revoked.status).toBe(401);
    expect(revoked.headers.get("www-authenticate")).toContain(`resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`);
  });
});

describe("refreshing a token", () => {
  const refresh = (base: string, token: string) => fetch(`${base}/oauth/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: token }) });
  const list = (base: string, token: string) => fetch(`${base}/mcp`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });

  it("given one refresh token sent twice at once, when both arrive, then one pair is issued, and revoking it leaves no pair that works", async () => {
    // given
    const { ctx, base, owner } = await orchestrator_();
    const { client, kept } = await connected(base, owner);
    await client.close();
    // Each read of the refresh token's row waits for the other request's read, so two requests
    // that are not kept apart both read it unspent; one that waits its turn goes on alone.
    const row = `oauth.token.${createHash("sha256").update(kept.tokens!.refresh_token!).digest("hex")}`;
    const read = ctx.store.getSetting.bind(ctx.store);
    let reads = 0;
    let release: () => void = () => undefined;
    const bothRead = new Promise<void>((resolve) => (release = resolve));
    ctx.store.getSetting = async (tenant, key) => {
      const value = await read(tenant, key);
      if (key === row && ++reads === 2) release();
      if (key === row) await Promise.race([bothRead, new Promise((r) => setTimeout(r, 300))]);
      return value;
    };

    // when
    const answers = await Promise.all([refresh(base, kept.tokens!.refresh_token!), refresh(base, kept.tokens!.refresh_token!)]);
    const issued = await Promise.all(answers.filter((r) => r.ok).map((r) => r.json()));
    await fetch(`${base}/oauth/revoke`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token: issued[0].refresh_token }) });
    const afterRevoke = await list(base, issued[0].access_token);

    // then
    expect(answers.map((r) => r.status).sort()).toEqual([200, 400]);
    expect(issued).toHaveLength(1);
    expect(afterRevoke.status).toBe(401);
  });

  it("given an account removed after it approved an app, when the app refreshes, then nothing is issued and the grant's rows are gone", async () => {
    // given
    const { ctx, base, member, memberId } = await orchestrator_();
    const { client, kept } = await connected(base, member, []);
    await client.close();
    await ctx.store.deleteUser(ctx.tenant, memberId);

    // when
    const answer = await refresh(base, kept.tokens!.refresh_token!);

    // then
    expect(answer.status).toBe(400);
    const left = await ctx.store.getSetting(ctx.tenant, `oauth.token.${createHash("sha256").update(kept.tokens!.access_token).digest("hex")}`);
    expect(left).toBeNull();
  });
});

describe("what the authorization server refuses", () => {
  it("given an approval page shown to the owner, when a form arrives without the owner's session, as another site's form does, then nothing is approved", async () => {
    // given
    const { base, owner } = await orchestrator_();
    const { p, kept } = provider();
    await new Client({ name: "x", version: "1" }).connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { authProvider: p })).catch(() => undefined);
    const html = await (await fetch(kept.opened!, { headers: { cookie: owner } })).text();
    const consent = /name="consent" value="([^"]+)"/.exec(html)![1]!;
    const org = /name="org" value="([^"]+)"/.exec(html)![1]!;

    // when
    const forged = await fetch(`${base}/oauth/authorize`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ consent, org, decision: "approve" }), redirect: "manual" });

    // then
    expect(forged.status).toBe(403);
    expect(forged.headers.get("location")).toBeNull();
  });

  it("given an approval page shown to one person, when another signed-in person posts its form, then nothing is approved", async () => {
    // given
    const { base, owner, member } = await orchestrator_();
    const { p, kept } = provider();
    await new Client({ name: "x", version: "1" }).connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { authProvider: p })).catch(() => undefined);
    const html = await (await fetch(kept.opened!, { headers: { cookie: owner } })).text();
    const form = new URLSearchParams({ consent: /name="consent" value="([^"]+)"/.exec(html)![1]!, org: /name="org" value="([^"]+)"/.exec(html)![1]!, decision: "approve" });

    // when
    const other = await fetch(`${base}/oauth/authorize`, { method: "POST", headers: { cookie: member, "content-type": "application/x-www-form-urlencoded" }, body: form, redirect: "manual" });

    // then
    expect(other.status).toBe(403);
  });

  it("given an approved code, when it is redeemed with another verifier, again, or for another return address, then each is refused", async () => {
    // given
    const { base, owner } = await orchestrator_();
    const register = await (await fetch(`${base}/oauth/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "t", redirect_uris: [REDIRECT] }) })).json();
    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const page = new URL(`${base}/oauth/authorize?${new URLSearchParams({ response_type: "code", client_id: register.client_id, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: "S256", state: "s1" })}`);
    const code = new URL((await approve(page, owner)).headers.get("location")!).searchParams.get("code")!;
    const redeem = (fields: Record<string, string>) => fetch(`${base}/oauth/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", code, client_id: register.client_id, redirect_uri: REDIRECT, code_verifier: verifier, ...fields }) });

    // when
    const wrongVerifier = await redeem({ code_verifier: randomBytes(32).toString("base64url") });
    const used = await redeem({});

    // then
    expect((await wrongVerifier.json()).error).toBe("invalid_grant");
    expect(used.status).toBe(400);
  });

  it("given a registration with a return address on another host over http, when it registers, then it is refused; an altered client id opens no page", async () => {
    // given
    const { base, owner } = await orchestrator_();

    // when
    const plain = await fetch(`${base}/oauth/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "t", redirect_uris: ["http://evil.example.invalid/cb"] }) });
    const altered = await fetch(`${base}/oauth/authorize?${new URLSearchParams({ response_type: "code", client_id: "v1.AAAA.BBBB.CCCC", redirect_uri: REDIRECT, code_challenge: "x".repeat(43), code_challenge_method: "S256" })}`, { headers: { cookie: owner }, redirect: "manual" });

    // then
    expect((await plain.json()).error).toBe("invalid_redirect_uri");
    expect(altered.status).toBe(400);
    expect(altered.headers.get("location")).toBeNull();
  });

  it("given a client that has registered as often as a minute allows, when it registers again, then it is told to wait", async () => {
    // given
    const { base } = await orchestrator_();
    const register = () => fetch(`${base}/oauth/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "t", redirect_uris: [REDIRECT] }) });
    for (let i = 0; i < OAUTH_LIMITS.register; i++) expect((await register()).status).toBe(201);

    // when
    const over = await register();

    // then
    expect(over.status).toBe(429);
    expect((await over.json()).error).toBe("slow_down");
    expect(Number(over.headers.get("retry-after"))).toBeGreaterThan(0);
  });

  it("given an orchestrator in dev-admin mode, when a client looks for the authorization server, then there is none", async () => {
    // given
    const { base } = await orchestrator_("dev-admin");

    // when
    const metadata = await fetch(`${base}/.well-known/oauth-authorization-server`);

    // then
    expect(metadata.status).toBe(404);
  });

  it("given a member's app token, when their domain is verified for single sign-on, then the token is nobody, so someone the identity provider closed has no way in through it", async () => {
    // given
    const { ctx, base, member, memberId } = await orchestrator_();
    const { client, kept } = await connected(base, member, []);
    await client.close();
    const before = await oauthPrincipal(ctx, kept.tokens!.access_token);

    // when
    await ctx.store.saveDomain({ tenant: ctx.tenant, domain: "example.invalid", token: "t", addedBy: "ada@example.invalid", addedAt: "2026-10-25T00:00:00.000Z", verifiedAt: null });
    await ctx.store.markDomainVerified(ctx.tenant, "example.invalid", "2026-10-25T01:00:00.000Z");
    const after = await oauthPrincipal(ctx, kept.tokens!.access_token);

    // then
    expect(before?.id).toBe(memberId);
    expect(after).toBeNull();
  });

  it("given a token of one org, when another org is asked who it is, then it is nobody there; an account removed afterwards is nobody too", async () => {
    // given
    const { ctx, base, member, memberId } = await orchestrator_();
    const { client, kept } = await connected(base, member, []);
    await client.close();

    // when
    const elsewhere = await oauthPrincipal({ ...ctx, tenant: "globex" }, kept.tokens!.access_token);
    const here = await oauthPrincipal(ctx, kept.tokens!.access_token);
    await ctx.store.deleteUser(ctx.tenant, memberId);
    const removed = await oauthPrincipal(ctx, kept.tokens!.access_token);

    // then
    expect(elsewhere).toBeNull();
    expect(here?.id).toBe(memberId);
    expect(removed).toBeNull();
  });
});

describe("an organization made after the orchestrator started", () => {
  it("given the authorization server started with no organization and one served only when asked for, when its owner approves an app, then a token is issued for that organization and names the owner", async () => {
    // given
    const { ctx, owner } = await orchestrator_();
    let asked = 0;
    const later = { list: () => [], get: async (tenant: string) => (asked++, tenant === ctx.tenant ? { ctx } : undefined), memberships: async () => [ctx.tenant] };
    const app = oauthRoutes(later, ctx, "local", false);
    const at = (path: string) => `${ctx.publicUrl}${path}`;
    const verifier = randomBytes(32).toString("base64url");
    const registered = await (await app.request(at("/oauth/register"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "Claude Code", redirect_uris: [REDIRECT] }) })).json();
    const query = new URLSearchParams({ response_type: "code", client_id: registered.client_id, redirect_uri: REDIRECT, code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256", state: "s" });

    // when
    const html = await (await app.request(at(`/oauth/authorize?${query}`), { headers: { cookie: owner } })).text();
    const form = new URLSearchParams({ consent: /name="consent" value="([^"]+)"/.exec(html)?.[1] ?? "", org: /name="org" value="([^"]+)"/.exec(html)?.[1] ?? "", decision: "approve" });
    const back = await app.request(at("/oauth/authorize"), { method: "POST", headers: { cookie: owner, "content-type": "application/x-www-form-urlencoded" }, body: form });
    const code = new URL(back.headers.get("location")!).searchParams.get("code")!;
    const tokens = await (await app.request(at("/oauth/token"), { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", code, client_id: registered.client_id, redirect_uri: REDIRECT, code_verifier: verifier }) })).json();

    // then
    expect(asked).toBeGreaterThan(0);
    expect(tokens.access_token).toMatch(/^th_oa\./);
    expect((await oauthPrincipal(ctx, tokens.access_token))?.email).toBe("ada@example.invalid");
  });
});

describe("the apps a person approved, on their Access page", () => {
  it("given Ada approved Claude Code, when she and Max list their apps and Max then Ada take hers back, then only Ada sees it, no token is shown, Max cannot end it, and once Ada does its tokens open nothing", async () => {
    // given
    const { base, owner, member } = await orchestrator_();
    const { client, kept } = await connected(base, owner);
    await client.close();
    const as = async (cookie: string) => {
      const csrf = ((await (await fetch(`${base}/api/me`, { headers: { cookie } })).json()) as { csrf: string }).csrf;
      return {
        list: async () => ((await (await fetch(`${base}/api/me/apps`, { headers: { cookie } })).json()) as { apps: { id: string; clientName: string; scopes: string[] }[] }).apps,
        end: (id: string) => fetch(`${base}/api/me/apps/${id}`, { method: "DELETE", headers: { cookie, [CSRF_HEADER]: csrf } }),
      };
    };
    const ada = await as(owner);
    const max = await as(member);

    // when
    const adas = await ada.list();
    const maxs = await max.list();
    const byMax = await max.end(adas[0]!.id);
    const byAda = await ada.end(adas[0]!.id);
    const refreshed = await fetch(`${base}/oauth/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: kept.tokens!.refresh_token! }) });
    const listed = await fetch(`${base}/mcp`, { method: "POST", headers: { authorization: `Bearer ${kept.tokens!.access_token}`, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });

    // then
    expect(adas.map((a) => [a.clientName, a.scopes.length > 0])).toEqual([["Claude Code", true]]);
    expect(JSON.stringify(adas)).not.toMatch(/th_o[ar]\.|tokens/);
    expect(maxs).toEqual([]);
    expect([byMax.status, byAda.status]).toEqual([404, 200]);
    expect(await ada.list()).toEqual([]);
    expect([refreshed.status, listed.status]).toEqual([400, 401]);
  });
});
