import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createUser, principalOf, setupFirstOwner, startSession } from "../accounts.js";
import { createApp } from "../app.js";
import type { OrchestratorContext } from "../app.js";
import { CSRF_HEADER, sessionCookie } from "../auth.js";
import type { Principal } from "../auth.js";
import { openSqliteStore } from "../store.js";
import { createVault, readSecret, storeSecret } from "../vault.js";
import { connectionKey, forgeAppsFromEnv, gitlabToken, readConnection, sealGitLabTokens, writeConnection } from "./oauth.js";
import { connectionToken, forgettingRefused, forgetVerified } from "./oauth-access.js";
import type { GitLabApp } from "./oauth.js";

const TENANT = "acme";
const CODE = "setup-code-for-tests";
const CLIENT_SECRET = "gloas-stand-in-client-secret-0001";
const PUBLIC = "http://127.0.0.1:8080";

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((resolve) => s.close(resolve))));
});

interface StandIn {
  webUrl: string;
  /** Every form posted to /oauth/token and /oauth/revoke, in order. */
  forms: { path: string; form: Record<string, string> }[];
  /** The username GET /api/v4/user answers, by the bearer token it is asked with. */
  users: Map<string, string>;
  /** The scopes the token info says a token has. */
  scopes: string[];
  /** How the token endpoint answers the next call; by default a fresh pair. */
  next: (form: Record<string, string>) => { status: number; body: unknown } | Promise<{ status: number; body: unknown }>;
}

let issued = 0;
function freshPair(): { status: number; body: unknown } {
  issued += 1;
  return { status: 200, body: { access_token: `gl-access-${issued}`, refresh_token: `gl-refresh-${issued}`, expires_in: 7200, token_type: "Bearer" } };
}

/** A GitLab instance's OAuth endpoints and its /user, on this machine. Nothing here reaches a real forge. */
async function standInGitLab(): Promise<StandIn> {
  const stand: StandIn = { webUrl: "", forms: [], users: new Map(), scopes: ["api"], next: () => freshPair() };
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", async () => {
      const path = (req.url ?? "").split("?")[0]!;
      const answer = (status: number, body: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };
      if (req.method === "POST" && (path === "/oauth/token" || path === "/oauth/revoke")) {
        const form = Object.fromEntries(new URLSearchParams(raw));
        stand.forms.push({ path, form });
        if (path === "/oauth/revoke") return answer(200, {});
        const next = await stand.next(form);
        if (next.status === 200 && typeof (next.body as { access_token?: string }).access_token === "string") {
          stand.users.set((next.body as { access_token: string }).access_token, stand.users.get("*") ?? "ada-gl");
        }
        return answer(next.status, next.body);
      }
      if (req.method === "GET" && (path === "/oauth/token/info" || path === "/api/v4/version")) {
        const token = (req.headers.authorization ?? "").replace(/^Bearer /, "");
        if (!stand.users.has(token)) return answer(401, { error: "invalid_token" });
        return answer(200, path === "/api/v4/version" ? { version: "17.5.0" } : { scope: stand.scopes });
      }
      if (req.method === "GET" && path === "/api/v4/user") {
        const token = (req.headers.authorization ?? "").replace(/^Bearer /, "");
        const user = stand.users.get(token);
        return user ? answer(200, { id: 1, username: user }) : answer(401, { message: "401 Unauthorized" });
      }
      answer(404, { message: "404 Not found" });
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  stand.webUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return stand;
}

function gitlabApp(webUrl: string): GitLabApp {
  return { kind: "gitlab", webUrl, apiUrl: `${webUrl}/api/v4`, clientId: "stand-in-client", clientSecret: CLIENT_SECRET };
}

async function organization(webUrl: string, over: Partial<OrchestratorContext> = {}): Promise<{ ctx: OrchestratorContext; owner: Principal; admin: Principal; member: Principal }> {
  const store = openSqliteStore(":memory:");
  const ctx: OrchestratorContext = { store, dataDir: join(mkdtempSync(join(tmpdir(), "forge-oauth-")), "data"), tenant: TENANT, allowedHosts: null, publicUrl: PUBLIC, vault: createVault(randomBytes(32)), addedRepos: new Map(), forgeApps: { gitlab: gitlabApp(webUrl) }, ...over };
  const owner = await principalOf(store, await setupFirstOwner(store, TENANT, CODE, { code: CODE, email: "ada@example.invalid", password: "correct horse battery" }));
  const admin = await principalOf(store, await createUser(store, TENANT, new Set(["Payments"]), { email: "grace@example.invalid", role: "admin" }, owner));
  const member = await principalOf(store, await createUser(store, TENANT, new Set(["Payments"]), { email: "max@example.invalid", role: "member", teams: ["Payments"] }, owner));
  return { ctx, owner, admin, member };
}

async function sessionHeaders(ctx: OrchestratorContext, id: string): Promise<Record<string, string>> {
  const s = await startSession(ctx.store, TENANT, id);
  return { cookie: `${sessionCookie(TENANT)}=${s.token}`, [CSRF_HEADER]: s.csrf, "content-type": "application/json" };
}

/** Begins a GitLab connection as `user` and returns the state and the browser cookie the orchestrator set. */
async function begin(app: ReturnType<typeof createApp>, headers: Record<string, string>) {
  const res = await app.request("/api/forge/gitlab/connect", { method: "POST", headers });
  const body = (await res.json()) as { authorizeUrl?: string; error?: string };
  const browser = (res.headers.get("set-cookie") ?? "").split(";")[0]!;
  const url = body.authorizeUrl ? new URL(body.authorizeUrl) : null;
  return { status: res.status, body, url, state: url?.searchParams.get("state") ?? "", browser };
}

async function callback(app: ReturnType<typeof createApp>, query: string, browser: string) {
  const res = await app.request(`/integrations/forge/callback?${query}`, { headers: browser ? { cookie: browser } : {} });
  return { status: res.status, location: res.headers.get("location") ?? "" };
}

describe("forge applications from the environment", () => {
  it("given no ORCHESTRATOR_FORGE_* setting, when read, then no application is offered and the token form stays", () => {
    expect(forgeAppsFromEnv({})).toEqual({});
  });

  it("given every ORCHESTRATOR_FORGE_* setting empty, as the cloud compose file passes them when none is set, when read, then no application is offered", () => {
    // given
    const env = Object.fromEntries(["GITLAB_CLIENT_ID", "GITLAB_CLIENT_SECRET_FILE", "GITLAB_URL", "GITHUB_APP_ID", "GITHUB_APP_SLUG", "GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET_FILE", "GITHUB_PRIVATE_KEY_FILE", "GITHUB_WEBHOOK_SECRET_FILE", "GITHUB_URL"].map((name) => [`ORCHESTRATOR_FORGE_${name}`, ""]));

    // when
    const apps = forgeAppsFromEnv(env);

    // then
    expect(apps).toEqual({});
  });

  it("given a GitLab client id without its secret, when read, then the start is refused naming the missing setting", () => {
    expect(() => forgeAppsFromEnv({ ORCHESTRATOR_FORGE_GITLAB_CLIENT_ID: "id" })).toThrow(/ORCHESTRATOR_FORGE_GITLAB_CLIENT_SECRET/);
  });

  it("given a GitLab application with no address, when read, then it is gitlab.com's", () => {
    expect(forgeAppsFromEnv({ ORCHESTRATOR_FORGE_GITLAB_CLIENT_ID: "id", ORCHESTRATOR_FORGE_GITLAB_CLIENT_SECRET: "secret" }).gitlab).toMatchObject({ webUrl: "https://gitlab.com", apiUrl: "https://gitlab.com/api/v4" });
  });

  it("given a self-managed GitLab over plain http on another host, when read, then it is refused", () => {
    expect(() => forgeAppsFromEnv({ ORCHESTRATOR_FORGE_GITLAB_CLIENT_ID: "id", ORCHESTRATOR_FORGE_GITLAB_CLIENT_SECRET: "secret", ORCHESTRATOR_FORGE_GITLAB_URL: "http://git.example.com" })).toThrow(/https/);
  });
});

describe("connecting GitLab with one click", () => {
  it("given an owner, when they connect and GitLab returns to the same browser, then the tokens are sealed, the account is named and the event log says who", async () => {
    const gitlab = await standInGitLab();
    const { ctx } = await organization(gitlab.webUrl);
    const app = createApp(ctx);
    const owner = await sessionHeaders(ctx, (await ctx.store.listUsers(TENANT)).find((u) => u.role === "owner")!.id);

    const started = await begin(app, owner);
    expect(started.status).toBe(200);
    expect(started.url!.origin + started.url!.pathname).toBe(`${gitlab.webUrl}/oauth/authorize`);
    expect(started.url!.searchParams.get("code_challenge_method")).toBe("S256");
    expect(started.url!.searchParams.get("redirect_uri")).toBe(`${PUBLIC}/integrations/forge/callback`);
    expect(started.url!.searchParams.get("scope")).toBe("api");

    const back = await callback(app, `code=one-time-code&state=${started.state}`, started.browser);
    expect(back.location).toBe(`/${TENANT}/integrations?forge_connected=gitlab`);
    const exchange = gitlab.forms.find((f) => f.path === "/oauth/token")!.form;
    expect(exchange).toMatchObject({ grant_type: "authorization_code", code: "one-time-code", client_secret: CLIENT_SECRET });
    expect(exchange.code_verifier).toBeTruthy();

    const view = (await (await app.request("/api/forge/gitlab/connection", { headers: owner })).json()) as { connection: Record<string, unknown>; available: boolean };
    expect(view.available).toBe(true);
    expect(view.connection).toMatchObject({ via: "oauth", account: "ada-gl", repos: 0, problem: null });
    expect(JSON.stringify(view)).not.toContain("gl-access-");
    const sealed = JSON.parse((await readSecret(ctx.store, ctx.vault!, TENANT, connectionKey("gitlab")))!) as { accessToken: string };
    expect(sealed.accessToken).toMatch(/^gl-access-/);
    const events = (await ctx.store.eventPage(TENANT, {}, null, 10)).events;
    expect(events.map((e) => e.kind)).toContain("forge.connected");
  });

  it("given a sign-in begun in one browser, when the forge returns to another, then nothing is stored", async () => {
    const gitlab = await standInGitLab();
    const { ctx, owner } = await organization(gitlab.webUrl);
    const app = createApp(ctx);
    const started = await begin(app, await sessionHeaders(ctx, owner.id));

    const back = await callback(app, `code=one-time-code&state=${started.state}`, "th_forge_signin=someone-elses-browser");
    expect(back.location).toContain("forge_problem=");
    expect(gitlab.forms).toEqual([]);
    expect(await readConnection(ctx, "gitlab")).toBeNull();
  });

  it("given a state used once, when the same return comes again, then it is refused as unknown", async () => {
    const gitlab = await standInGitLab();
    const { ctx, owner } = await organization(gitlab.webUrl);
    const app = createApp(ctx);
    const started = await begin(app, await sessionHeaders(ctx, owner.id));
    await callback(app, `code=one-time-code&state=${started.state}`, started.browser);

    const again = await callback(app, `code=one-time-code&state=${started.state}`, started.browser);
    expect(decodeURIComponent(again.location)).toContain("unknown or expired");
  });

  it("given an admin whose role is taken away while on GitLab, when GitLab returns, then the connection is not made", async () => {
    const gitlab = await standInGitLab();
    const { ctx, admin } = await organization(gitlab.webUrl);
    const app = createApp(ctx);
    const started = await begin(app, await sessionHeaders(ctx, admin.id));
    await ctx.store.setRole(TENANT, admin.id, "member");

    const back = await callback(app, `code=one-time-code&state=${started.state}`, started.browser);
    expect(decodeURIComponent(back.location)).toContain("role changed");
    expect(gitlab.forms).toEqual([]);
    expect(await readConnection(ctx, "gitlab")).toBeNull();
  });

  it("given a member, when they try to connect, then they are refused", async () => {
    const gitlab = await standInGitLab();
    const { ctx, member } = await organization(gitlab.webUrl);
    const started = await begin(createApp(ctx), await sessionHeaders(ctx, member.id));
    expect(started.status).toBe(403);
  });

  it("given an orchestrator with no application registered, when the card reads the connection, then it is unavailable and says the operator registers one first, with a token meanwhile", async () => {
    const gitlab = await standInGitLab();
    const { ctx, owner } = await organization(gitlab.webUrl, { forgeApps: {} });
    const app = createApp(ctx);
    const view = (await (await app.request("/api/forge/gitlab/connection", { headers: await sessionHeaders(ctx, owner.id) })).json()) as { available: boolean; missing: string[] };
    expect(view.available).toBe(false);
    expect(view.missing[0]).toBe("Whoever runs the orchestrator registers it as a GitLab OAuth application first; until then, connect with a token under Other ways to connect.");
    expect((await begin(app, await sessionHeaders(ctx, owner.id))).status).toBe(409);
  });

  it("given GitLab's error answer to the code, when it returns, then the person reads GitLab's reason without the client secret", async () => {
    const gitlab = await standInGitLab();
    gitlab.next = () => ({ status: 400, body: { error: "invalid_grant", error_description: `The code was already used (${CLIENT_SECRET})` } });
    const { ctx, owner } = await organization(gitlab.webUrl);
    const app = createApp(ctx);
    const started = await begin(app, await sessionHeaders(ctx, owner.id));

    const back = decodeURIComponent((await callback(app, `code=one-time-code&state=${started.state}`, started.browser)).location);
    expect(back).toContain("already used");
    expect(back).not.toContain(CLIENT_SECRET);
  });

  it("given a connection, when an owner disconnects it, then GitLab is asked to revoke the token and the orchestrator forgets it", async () => {
    const gitlab = await standInGitLab();
    const { ctx, owner } = await organization(gitlab.webUrl);
    const app = createApp(ctx);
    const headers = await sessionHeaders(ctx, owner.id);
    const started = await begin(app, headers);
    await callback(app, `code=one-time-code&state=${started.state}`, started.browser);

    const res = await app.request("/api/forge/gitlab/connection", { method: "DELETE", headers });
    expect(res.status).toBe(200);
    expect(gitlab.forms.at(-1)!.path).toBe("/oauth/revoke");
    expect(await readConnection(ctx, "gitlab")).toBeNull();
    expect(await ctx.store.getSecret(TENANT, connectionKey("gitlab"))).toBeNull();
  });

  it("given a repository reached through the connection, when an owner disconnects, then it is refused naming the repository", async () => {
    const gitlab = await standInGitLab();
    const { ctx, owner } = await organization(gitlab.webUrl);
    const app = createApp(ctx);
    const headers = await sessionHeaders(ctx, owner.id);
    const started = await begin(app, headers);
    await callback(app, `code=one-time-code&state=${started.state}`, started.browser);
    ctx.addedRepos!.set("payments-skills", { id: "payments-skills", forge: "gitlab", kind: "skills", skillsFrom: null, gitOrigin: gitlab.webUrl, memberUrl: null, addedBy: owner.email, addedAt: new Date().toISOString(), connection: "gitlab" });

    const res = await app.request("/api/forge/gitlab/connection", { method: "DELETE", headers });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { repos: string[] }).repos).toEqual(["payments-skills"]);
    expect(await readConnection(ctx, "gitlab")).not.toBeNull();
  });

  it("given a connection serving a repository as one account, when someone reconnects as another, then the new tokens are revoked and the old account stays", async () => {
    const gitlab = await standInGitLab();
    const { ctx, owner } = await organization(gitlab.webUrl);
    const app = createApp(ctx);
    const headers = await sessionHeaders(ctx, owner.id);
    const first = await begin(app, headers);
    await callback(app, `code=one-time-code&state=${first.state}`, first.browser);
    ctx.addedRepos!.set("payments-skills", { id: "payments-skills", forge: "gitlab", kind: "skills", skillsFrom: null, gitOrigin: gitlab.webUrl, memberUrl: null, addedBy: owner.email, addedAt: new Date().toISOString(), connection: "gitlab" });

    gitlab.users.set("*", "someone-else");
    const second = await begin(app, headers);
    const back = decodeURIComponent((await callback(app, `code=two&state=${second.state}`, second.browser)).location);
    expect(back).toContain("sign in to GitLab as ada-gl");
    expect(gitlab.forms.at(-1)!.path).toBe("/oauth/revoke");
    expect((await readConnection(ctx, "gitlab"))!.account).toBe("ada-gl");
  });
});

describe("renewing the GitLab token", () => {
  async function connected(expiresInSeconds: number) {
    const gitlab = await standInGitLab();
    const { ctx, owner } = await organization(gitlab.webUrl);
    const app = createApp(ctx);
    gitlab.next = () => ({ status: 200, body: { access_token: "gl-access-old", refresh_token: "gl-refresh-old", expires_in: expiresInSeconds } });
    const started = await begin(app, await sessionHeaders(ctx, owner.id));
    await callback(app, `code=one-time-code&state=${started.state}`, started.browser);
    gitlab.next = () => freshPair();
    gitlab.forms.length = 0;
    return { gitlab, ctx };
  }

  it("given a token with hours left, when a token is asked for, then the sealed one is given without calling GitLab", async () => {
    const { gitlab, ctx } = await connected(7200);
    expect(await gitlabToken(ctx)).toBe("gl-access-old");
    expect(gitlab.forms).toEqual([]);
  });

  it("given a token about to lapse, when two calls ask at once, then GitLab is asked once and both get the new token, which is sealed", async () => {
    const { gitlab, ctx } = await connected(60);
    const [a, b] = await Promise.all([gitlabToken(ctx), gitlabToken(ctx)]);
    expect(a).toBe(b);
    expect(a).not.toBe("gl-access-old");
    expect(gitlab.forms).toHaveLength(1);
    expect(gitlab.forms[0]!.form).toMatchObject({ grant_type: "refresh_token", refresh_token: "gl-refresh-old", redirect_uri: `${PUBLIC}/integrations/forge/callback` });
    const sealed = JSON.parse((await readSecret(ctx.store, ctx.vault!, TENANT, connectionKey("gitlab")))!) as { accessToken: string };
    expect(sealed.accessToken).toBe(a);
  });

  it("given a refresh token GitLab no longer accepts, when a token is asked for, then the connection is marked to be made again and the card says so", async () => {
    const { gitlab, ctx } = await connected(60);
    gitlab.next = () => ({ status: 400, body: { error: "invalid_grant", error_description: "The provided authorization grant is invalid" } });
    await expect(gitlabToken(ctx)).rejects.toThrow(/made again/);
    expect((await readConnection(ctx, "gitlab"))!.problem).toContain("no longer accepts");
    await expect(gitlabToken(ctx)).rejects.toThrow(/made again/);
    expect(gitlab.forms).toHaveLength(1);
  });

  it("given a GitLab that cannot be reached during a renewal, when a token is asked for, then the call fails but the connection is not marked broken", async () => {
    const { ctx } = await connected(60);
    const record = (await readConnection(ctx, "gitlab"))!;
    ctx.forgeApps = { gitlab: { ...gitlabApp("http://127.0.0.1:9"), apiUrl: record.apiUrl } };
    await expect(gitlabToken(ctx)).rejects.toThrow(/was not renewed: .*; try again, and if it repeats, an owner or an admin connects GitLab again under Integrations/);
    expect((await readConnection(ctx, "gitlab"))!.problem).toBeNull();
  });

  it("given a connection made for another GitLab address, when a token is asked for, then none is given", async () => {
    const { ctx } = await connected(7200);
    const record = (await readConnection(ctx, "gitlab"))!;
    await writeConnection(ctx, "gitlab", { ...record, apiUrl: "https://gitlab.example.com/api/v4" });
    await expect(gitlabToken(ctx)).rejects.toThrow(/another GitLab address/);
  });
});

describe("connecting again and renewing across processes", () => {
  it("given a connection, when the same account connects again, then the pair it replaces is revoked before the new one is sealed", async () => {
    const gitlab = await standInGitLab();
    const { ctx, owner } = await organization(gitlab.webUrl);
    const app = createApp(ctx);
    const headers = await sessionHeaders(ctx, owner.id);
    const first = await begin(app, headers);
    await callback(app, `code=one&state=${first.state}`, first.browser);
    const old = JSON.parse((await readSecret(ctx.store, ctx.vault!, TENANT, connectionKey("gitlab")))!) as { accessToken: string };

    const second = await begin(app, headers);
    await callback(app, `code=two&state=${second.state}`, second.browser);
    const revoked = gitlab.forms.filter((f) => f.path === "/oauth/revoke").map((f) => f.form.token);
    expect(revoked).toEqual([old.accessToken]);
    const now = JSON.parse((await readSecret(ctx.store, ctx.vault!, TENANT, connectionKey("gitlab")))!) as { accessToken: string };
    expect(now.accessToken).not.toBe(old.accessToken);
  });

  it("given another process renewing under the lease, when a token is asked for, then the one it seals is used and GitLab is not called again", async () => {
    const gitlab = await standInGitLab();
    const { ctx, owner } = await organization(gitlab.webUrl);
    const app = createApp(ctx);
    gitlab.next = () => ({ status: 200, body: { access_token: "gl-access-old", refresh_token: "gl-refresh-old", expires_in: 60 } });
    const started = await begin(app, await sessionHeaders(ctx, owner.id));
    await callback(app, `code=one&state=${started.state}`, started.browser);
    gitlab.forms.length = 0;
    const at = new Date();
    expect(await ctx.store.claimLease(TENANT, "forge.renewing.gitlab", "other-process", new Date(at.getTime() + 30_000).toISOString(), at.toISOString())).toBe(true);
    setTimeout(() => void sealGitLabTokens(ctx, { accessToken: "gl-access-from-runner", refreshToken: "gl-refresh-from-runner", expiresAt: new Date(Date.now() + 7_200_000).toISOString() }, owner.email), 300);

    expect(await gitlabToken(ctx)).toBe("gl-access-from-runner");
    expect(gitlab.forms).toEqual([]);
  });

  it("given a renewal GitLab refuses, when someone connected again meanwhile, then the new connection is not marked broken", async () => {
    const gitlab = await standInGitLab();
    const { ctx, owner } = await organization(gitlab.webUrl);
    const app = createApp(ctx);
    gitlab.next = () => ({ status: 200, body: { access_token: "gl-access-old", refresh_token: "gl-refresh-old", expires_in: 60 } });
    const started = await begin(app, await sessionHeaders(ctx, owner.id));
    await callback(app, `code=one&state=${started.state}`, started.browser);
    gitlab.next = async () => {
      const record = (await readConnection(ctx, "gitlab"))!;
      await writeConnection(ctx, "gitlab", { ...record, at: "2099-01-01T00:00:00.000Z" });
      return { status: 400, body: { error: "invalid_grant" } };
    };

    await expect(gitlabToken(ctx)).rejects.toThrow(/made again/);
    expect((await readConnection(ctx, "gitlab"))!.problem).toBeNull();
  });
});

describe("an organization's own GitLab application", () => {
  const ORG_SECRET = "gloas-org-own-secret-0002";

  async function ownApp(over: Partial<OrchestratorContext> = {}) {
    const gitlab = await standInGitLab();
    const host = new URL(gitlab.webUrl).host;
    const org = await organization(gitlab.webUrl, { forgeApps: {}, internalForgeHosts: new Set([host]), ...over });
    const app = createApp(org.ctx);
    const owner = await sessionHeaders(org.ctx, org.owner.id);
    const put = (headers: Record<string, string>, body: unknown) => app.request("/api/forge/gitlab/app", { method: "PUT", headers, body: JSON.stringify(body) });
    return { ...org, gitlab, app, owner, put };
  }

  it("given an orchestrator with no operator application, when an owner enters their GitLab's application, then the org connects through it with its own id and secret, and the secret is never shown", async () => {
    const { gitlab, ctx, app, owner, put } = await ownApp();

    const set = await put(owner, { url: gitlab.webUrl, clientId: "org-own-client", clientSecret: ORG_SECRET });
    expect(set.status).toBe(200);
    const shown = await (await app.request("/api/forge/gitlab/app", { headers: owner })).text();
    expect(shown).not.toContain(ORG_SECRET);
    expect(((await (await app.request("/api/forge/gitlab/connection", { headers: owner })).json()) as { available: boolean }).available).toBe(true);

    const started = await begin(app, owner);
    expect(started.url!.origin).toBe(gitlab.webUrl);
    expect(started.url!.searchParams.get("client_id")).toBe("org-own-client");
    const back = await callback(app, `code=one&state=${started.state}`, started.browser);
    expect(back.location).toBe(`/${TENANT}/integrations?forge_connected=gitlab`);
    expect(gitlab.forms[0]!.form).toMatchObject({ client_id: "org-own-client", client_secret: ORG_SECRET });
    expect(await gitlabToken(ctx)).toMatch(/^gl-access-/);
  });

  it("given an admin or a member, when either enters an application, then it is refused and nothing is kept", async () => {
    const { gitlab, ctx, admin, member, put } = await ownApp();
    for (const who of [admin, member]) {
      expect((await put(await sessionHeaders(ctx, who.id), { url: gitlab.webUrl, clientId: "org-own-client", clientSecret: ORG_SECRET })).status).toBe(403);
    }
    expect(await ctx.store.getSetting(TENANT, "forge.gitlab.app")).toBeNull();
  });

  it("given an address that leads to this machine without the operator's leave, when an owner enters it, then it is refused", async () => {
    const { gitlab, ctx, put, owner } = await ownApp({ internalForgeHosts: new Set() });
    const res = await put(owner, { url: gitlab.webUrl, clientId: "org-own-client", clientSecret: ORG_SECRET });
    expect(res.status).toBe(403);
    expect(await ctx.store.getSetting(TENANT, "forge.gitlab.app")).toBeNull();
  });

  it("given an address with a path or a query, when an owner enters it, then it is refused", async () => {
    const { gitlab, put, owner } = await ownApp();
    expect((await put(owner, { url: `${gitlab.webUrl}/gitlab`, clientId: "org-own-client", clientSecret: ORG_SECRET })).status).toBe(400);
    expect((await put(owner, { url: `${gitlab.webUrl}?x=1`, clientId: "org-own-client", clientSecret: ORG_SECRET })).status).toBe(400);
  });

  it("given GitLab connected through the org's application, when an owner changes or removes the application, then both are refused until GitLab is disconnected", async () => {
    const { gitlab, app, owner, put } = await ownApp();
    await put(owner, { url: gitlab.webUrl, clientId: "org-own-client", clientSecret: ORG_SECRET });
    const started = await begin(app, owner);
    await callback(app, `code=one&state=${started.state}`, started.browser);

    expect((await put(owner, { url: gitlab.webUrl, clientId: "another-client", clientSecret: ORG_SECRET })).status).toBe(409);
    expect((await app.request("/api/forge/gitlab/app", { method: "DELETE", headers: owner })).status).toBe(409);
    expect((await app.request("/api/forge/gitlab/connection", { method: "DELETE", headers: owner })).status).toBe(200);
    expect((await app.request("/api/forge/gitlab/app", { method: "DELETE", headers: owner })).status).toBe(200);
  });
});

describe("returning to the page that began the connection", () => {
  async function startFrom(body: unknown) {
    const gitlab = await standInGitLab();
    const { ctx, owner } = await organization(gitlab.webUrl);
    const app = createApp(ctx);
    const res = await app.request("/api/forge/gitlab/connect", { method: "POST", headers: await sessionHeaders(ctx, owner.id), body: JSON.stringify(body) });
    const state = new URL(((await res.json()) as { authorizeUrl: string }).authorizeUrl).searchParams.get("state")!;
    const browser = (res.headers.get("set-cookie") ?? "").split(";")[0]!;
    return { app, state, browser };
  }

  it("given a connection begun from the welcome wizard, when GitLab returns, then the browser lands back on the wizard", async () => {
    const { app, state, browser } = await startFrom({ return: "welcome" });
    expect((await callback(app, `code=one&state=${state}`, browser)).location).toBe(`/${TENANT}/welcome?forge_connected=gitlab`);
  });

  it("given a connection begun from the wizard, when GitLab returns without completing, then the wizard reads the problem", async () => {
    const { app, state, browser } = await startFrom({ return: "welcome" });
    expect((await callback(app, `state=${state}`, browser)).location).toMatch(new RegExp(`^/${TENANT}/welcome\\?forge_problem=`));
  });

  it("given a return named as an address, when GitLab returns, then the browser lands on Integrations and nowhere else", async () => {
    const { app, state, browser } = await startFrom({ return: "https://elsewhere.example.com/" });
    expect((await callback(app, `code=one&state=${state}`, browser)).location).toBe(`/${TENANT}/integrations?forge_connected=gitlab`);
  });
});

describe("calls to an organization's own GitLab held to the address judged", () => {
  it("given a name the system cannot resolve that the orchestrator judged to an address, when the org connects, then every call goes to that address, and once the name leads inside no call is made", async () => {
    const gitlab = await standInGitLab();
    const port = new URL(gitlab.webUrl).port;
    const host = `gitlab.stand-in.invalid:${port}`;
    let answer = ["127.0.0.1"];
    const { ctx, owner } = await organization(gitlab.webUrl, { forgeApps: {}, internalForgeHosts: new Set([host]), resolveHost: async () => answer });
    await ctx.store.setSetting(TENANT, "forge.gitlab.app", JSON.stringify({ webUrl: `http://${host}`, clientId: "org-own-client", by: "Ada", at: new Date().toISOString() }));
    await storeSecret(ctx.store, ctx.vault!, TENANT, "forge.gitlab.app", "gloas-org-own-secret-0003", owner.email);
    const app = createApp(ctx);
    gitlab.next = () => ({ status: 200, body: { access_token: "gl-access-pinned", refresh_token: "gl-refresh-pinned", expires_in: 60 } });

    const started = await begin(app, await sessionHeaders(ctx, owner.id));
    expect((await callback(app, `code=one&state=${started.state}`, started.browser)).location).toBe(`/${TENANT}/integrations?forge_connected=gitlab`);
    expect(gitlab.forms).toHaveLength(1);

    answer = ["10.0.0.5"];
    ctx.internalForgeHosts = new Set();
    await expect(gitlabToken(ctx)).rejects.toThrow(/network inside it/);
    expect(gitlab.forms).toHaveLength(1);
  });
});

describe("checking the account a GitLab connection signs in as", () => {
  it("given the token now signing in as another GitLab user, when a token is asked for, then none is given and the connection is to be made again", async () => {
    forgetVerified();
    const gitlab = await standInGitLab();
    const { ctx, owner } = await organization(gitlab.webUrl);
    const app = createApp(ctx);
    const started = await begin(app, await sessionHeaders(ctx, owner.id));
    await callback(app, `code=one&state=${started.state}`, started.browser);
    const token = await gitlabToken(ctx);
    expect(await connectionToken(ctx, "gitlab")).toBe(token);

    forgetVerified();
    gitlab.users.set(token, "someone-else");
    await expect(connectionToken(ctx, "gitlab")).rejects.toThrow(/now reaches someone-else, not ada-gl/);
  });
});

describe("a GitLab token the forge refuses", () => {
  it("given GitLab refusing the connection's token on a call, when a token is asked for next, then it is renewed rather than the connection marked, and a renewal refused too marks it", async () => {
    forgetVerified();
    const gitlab = await standInGitLab();
    const { ctx, owner } = await organization(gitlab.webUrl);
    const app = createApp(ctx);
    const started = await begin(app, await sessionHeaders(ctx, owner.id));
    await callback(app, `code=one&state=${started.state}`, started.browser);
    const token = await gitlabToken(ctx);
    gitlab.forms.length = 0;

    const send = forgettingRefused(ctx, "gitlab", token, fetch);
    expect((await send(`${gitlab.webUrl}/api/v4/user`, { headers: { authorization: "Bearer not-the-token" } })).status).toBe(401);

    const renewed = await gitlabToken(ctx);
    expect(renewed).not.toBe(token);
    expect(gitlab.forms.map((f) => f.form.grant_type)).toEqual(["refresh_token"]);
    expect((await readConnection(ctx, "gitlab"))!.problem).toBeNull();

    gitlab.next = () => ({ status: 400, body: { error: "invalid_grant" } });
    await forgettingRefused(ctx, "gitlab", renewed, fetch)(`${gitlab.webUrl}/api/v4/user`);
    await expect(gitlabToken(ctx)).rejects.toThrow(/made again/);
  });
});

describe("checking the GitLab connection from the card", () => {
  it("given a connection whose token has the api scope, when an owner checks it, then it says the token opens, the account, the scope and GitLab's version; without the scope it names what is missing", async () => {
    forgetVerified();
    const gitlab = await standInGitLab();
    const { ctx, owner } = await organization(gitlab.webUrl);
    const app = createApp(ctx);
    const headers = await sessionHeaders(ctx, owner.id);
    const started = await begin(app, headers);
    await callback(app, `code=one&state=${started.state}`, started.browser);

    const good = (await (await app.request("/api/forge/gitlab/connection/check", { headers })).json()) as { check: Record<string, unknown> };
    expect(good.check).toEqual({ ok: true, account: "ada-gl", granted: ["api"], missing: [], version: "17.5.0", problem: null });

    gitlab.scopes = ["read_api"];
    const short = (await (await app.request("/api/forge/gitlab/connection/check", { headers })).json()) as { check: { ok: boolean; missing: string[] } };
    expect(short.check).toMatchObject({ ok: false, missing: ["api"] });
  });
});
