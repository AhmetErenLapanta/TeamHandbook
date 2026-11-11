import { keyRefused } from "../domains.js";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import type { Context } from "hono";
import { clientFrom, principalOf } from "../accounts.js";
import type { OrchestratorContext } from "../app.js";
import { sessionOf } from "../auth.js";
import type { AuthMode, Principal } from "../auth.js";
import type { Scopes } from "../keys.js";
import { tooMany, windowLimiter } from "../limits.js";
import type { Verdict } from "../limits.js";
import { MCP_PATH } from "./orchestrator-mcp.js";

/**
 * The orchestrator as the OAuth authorization server of its own MCP server, as the MCP authorization
 * spec lays it out: an MCP client finds it from the server's 401, registers itself, sends the
 * person's browser here to approve, and gets tokens that act as that person, within the scopes
 * they approved and never beyond their role. The API keys the people settings issue keep working
 * beside it.
 */
export const ACCESS_MS = 60 * 60_000;
export const REFRESH_MS = 30 * 24 * 60 * 60_000;
export const CODE_MS = 60_000;
/** Requests per client a minute to each endpoint; far above an MCP client signing in, as a person does, a few times a day. */
export const OAUTH_LIMITS = { register: 10, authorize: 30, token: 30 };
export const CONSENT_MS = 10 * 60_000;
const MAX_REDIRECTS = 5;
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** What an MCP client may be granted: the scopes of an API key the orchestrator's MCP tools read. */
export const OAUTH_SCOPES = ["repositories:read", "requests:read", "tasks:read", "requests:write", "tasks:write"] as const;
export const DEFAULT_SCOPES = ["repositories:read", "requests:read", "tasks:read"];

export interface OAuthOrg {
  ctx: OrchestratorContext;
}

/**
 * The organizations the authorization server reaches, read when a request names one: on a cloud
 * orchestrator that includes one created after the start, served the first time it is asked for.
 * `memberships` says which organizations a browser's cloud identity belongs to; an orchestrator with
 * per-organization sessions leaves it out and is asked about every organization it serves.
 */
export interface OAuthOrgs {
  list(): readonly OAuthOrg[];
  get(tenant: string): Promise<OAuthOrg | undefined>;
  memberships?: (c: Context) => Promise<string[]>;
}

/** What the server shares across organizations: the address it answers at, the key it seals clients with, the proxies it trusts. */
export type OAuthShared = Pick<OrchestratorContext, "publicUrl" | "vault" | "trustedProxies">;

interface Client {
  name: string;
  redirectUris: string[];
}

interface Code {
  tenant: string;
  userId: string;
  clientId: string;
  clientName: string;
  redirectUri: string;
  challenge: string;
  scopes: string[];
  issuedAt: number;
}

interface Consent extends Omit<Code, "tenant" | "userId" | "issuedAt"> {
  state: string | null;
  /** The org and the session's own secret it was shown to; the decision has to come from that session. */
  sessions: { tenant: string; csrf: string; userId: string }[];
  shownAt: number;
}

interface TokenRow {
  kind: "access" | "refresh";
  grant: string;
  userId: string;
  scopes: string[];
  expiresAt: string;
}

interface GrantRow {
  userId: string;
  clientName: string;
  scopes: string[];
  createdAt: string;
  tokens: string[];
}

const ACCESS = "th_oa";
const REFRESH = "th_or";
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const tokenKey = (h: string) => `oauth.token.${h}`;
const grantKey = (id: string) => `oauth.grant.${id}`;

/** A token naming its org, so the orchestrator's one MCP address and token endpoint reach the org that issued it. */
function newToken(prefix: string, tenant: string): string {
  return `${prefix}.${Buffer.from(tenant).toString("base64url")}.${randomBytes(32).toString("base64url")}`;
}

/** The org a token says it belongs to; whether it is one is decided by that org's store. */
export function oauthTenant(token: string): string | null {
  const match = /^th_o[ar]\.([A-Za-z0-9_-]{1,200})\.[A-Za-z0-9_-]{43}$/.exec(token);
  return match ? Buffer.from(match[1]!, "base64url").toString("utf8") : null;
}

/** The redirect addresses an MCP client may register: its own loopback listener, or https. */
export function cleanRedirects(value: unknown): string[] {
  if (!Array.isArray(value) || !value.length || value.length > MAX_REDIRECTS) throw new OAuthError("invalid_redirect_uri", `register one to ${MAX_REDIRECTS} redirect_uris`);
  return value.map((raw) => {
    let url: URL;
    try {
      url = new URL(String(raw));
    } catch {
      throw new OAuthError("invalid_redirect_uri", "a redirect_uri is not a URL");
    }
    const loopback = url.protocol === "http:" && LOOPBACK.has(url.hostname);
    if ((!loopback && url.protocol !== "https:") || url.hash || url.username || url.password) throw new OAuthError("invalid_redirect_uri", "a redirect_uri is https, or http on this machine, with no fragment or credentials");
    return url.toString();
  });
}

export class OAuthError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) {
    super(message);
  }
}

function scopesOf(text: string | undefined): string[] {
  const asked = (text ?? "").split(/\s+/).filter(Boolean);
  const unknown = asked.filter((s) => !(OAUTH_SCOPES as readonly string[]).includes(s));
  if (unknown.length) throw new OAuthError("invalid_scope", `unknown scopes: ${unknown.join(" ").slice(0, 200)}`);
  return asked.length ? [...new Set(asked)] : DEFAULT_SCOPES;
}

/** The scopes as an API key carries them, so the MCP server's scope gate reads both the same way. */
export function keyScopes(scopes: readonly string[]): Scopes {
  const out: Scopes = { repositories: "none", requests: "none", tasks: "none", usage: "none", members: "none", settings: "none", keys: "none" };
  for (const scope of scopes) {
    const [resource, access] = scope.split(":") as [keyof Scopes, "read" | "write"];
    if (access === "write" || out[resource] === "none") out[resource] = access;
  }
  return out;
}

function escape(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
}

const SCOPE_TEXT: Record<string, string> = {
  "repositories:read": "Read the team repositories this orchestrator holds",
  "requests:read": "Read the requests waiting to be merged",
  "tasks:read": "Read your tasks",
  "requests:write": "Propose changes as requests, which a person reviews and merges",
  "tasks:write": "Start agent tasks that end in a request",
};

function page(c: Context, title: string, body: string, status: 200 | 400 | 403 = 200) {
  c.header("X-Frame-Options", "DENY");
  c.header("Content-Security-Policy", "frame-ancestors 'none'; default-src 'none'; style-src 'unsafe-inline'; form-action 'self'");
  c.header("Cache-Control", "no-store");
  return c.html(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escape(title)}</title>` +
      `<style>body{font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;max-width:34rem;margin:3rem auto;padding:0 1rem;color:#18181b;background:#f7f7f8}` +
      `main{background:#fff;border:1px solid #e4e4e7;border-radius:10px;padding:1.25rem 1.5rem}h1{font-size:1.25rem;margin:0 0 .75rem}` +
      `button{font:inherit;padding:.45rem 1rem;border-radius:8px;border:1px solid #2856d8;background:#2856d8;color:#fff;cursor:pointer;margin-right:.5rem}` +
      `button.secondary{background:transparent;border-color:#d1d1d6;color:#18181b}label{display:block;margin:.35rem 0}code{font-size:.9em}.muted{color:#5e5e68}` +
      // White on the dark accent is under 3:1, so the filled button's text turns dark with it.
      `@media (prefers-color-scheme:dark){:root{color-scheme:dark}body{color:#ececef;background:#0c0c0e}main{background:#151518;border-color:#2a2a30}` +
      `button{border-color:#86a2ff;background:#86a2ff;color:#0c0c0e}button.secondary{border-color:#3a3a42;color:#ececef}.muted{color:#a3a3ad}a{color:#86a2ff}}</style>` +
      `</head><body><main>${body}</main></body></html>`,
    status,
  );
}

const lanes = new Map<string, Promise<unknown>>();

/** Runs `work` after every earlier piece of work under the same key has finished. */
function inTurn<T>(key: string, work: () => Promise<T>): Promise<T> {
  const turn = (lanes.get(key) ?? Promise.resolve()).then(work, work);
  const settled = turn.then(() => undefined, () => undefined);
  lanes.set(key, settled);
  void settled.then(() => {
    if (lanes.get(key) === settled) lanes.delete(key);
  });
  return turn;
}

/**
 * The orchestrator's authorization server, mounted once for every org the orchestrator serves: the
 * metadata, client registration, the approval page and the token and revocation endpoints. The
 * org a token belongs to is written in the token; the org a person approves for is the one they
 * are signed in to in this browser.
 */
export function oauthRoutes(orgs: OAuthOrgs, first: OAuthShared, mode: AuthMode, secure: boolean): Hono {
  const app = new Hono();
  // Counted per client: registration writes nothing but is cheap to flood, and the token and
  // approval endpoints are where a stolen code or refresh token would be tried over and over.
  const from = clientFrom(first.trustedProxies ?? []);
  const limits = { register: windowLimiter(OAUTH_LIMITS.register), authorize: windowLimiter(OAUTH_LIMITS.authorize), token: windowLimiter(OAUTH_LIMITS.token) };
  const limited = (limit: (key: string) => Verdict) => async (c: Context, next: () => Promise<void>) => {
    const verdict = limit(from(c));
    return verdict.ok ? next() : tooMany(c, verdict, "slow_down");
  };
  app.use("/oauth/register", limited(limits.register));
  app.use("/oauth/authorize", limited(limits.authorize));
  app.use("/oauth/token", limited(limits.token));
  app.use("/oauth/revoke", limited(limits.token));
  const ctxOf = async (tenant: string | null | undefined) => (tenant ? (await orgs.get(tenant))?.ctx : undefined);
  const base = first.publicUrl?.replace(/\/+$/, "") ?? null;
  const vault = first.vault ?? null;
  const consents = new Map<string, Consent>();
  const codes = new Map<string, Code>();
  // dev-admin makes everyone who reaches the port an admin; no token is issued on that.
  const available = Boolean(base && vault && mode !== "dev-admin");
  const resource = base ? `${base}${MCP_PATH}` : null;

  const sweep = (now: number) => {
    for (const [id, c] of consents) if (now - c.shownAt > CONSENT_MS) consents.delete(id);
    for (const [id, c] of codes) if (now - c.issuedAt > CODE_MS) codes.delete(id);
  };

  const sealClient = (client: Client) => vault!.seal("oauth", "client", JSON.stringify(client));
  const openClient = (id: string): Client | null => {
    try {
      return JSON.parse(vault!.open("oauth", "client", id)) as Client;
    } catch {
      return null;
    }
  };

  const unavailable = (c: Context) => c.json({ error: "temporarily_unavailable", error_description: "this orchestrator has no public address or no ORCHESTRATOR_SECRET_KEY, so it signs no MCP client in; use an API key" }, 404);

  const resourceMetadata = (c: Context) =>
    available ? c.json({ resource, authorization_servers: [base], scopes_supported: OAUTH_SCOPES, bearer_methods_supported: ["header"] }) : unavailable(c);
  app.get("/.well-known/oauth-protected-resource", resourceMetadata);
  app.get(`/.well-known/oauth-protected-resource${MCP_PATH}`, resourceMetadata);

  app.get("/.well-known/oauth-authorization-server", (c) => {
    if (!available) return unavailable(c);
    return c.json({
      issuer: base,
      authorization_endpoint: `${base}/oauth/authorize`,
      token_endpoint: `${base}/oauth/token`,
      registration_endpoint: `${base}/oauth/register`,
      revocation_endpoint: `${base}/oauth/revoke`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      revocation_endpoint_auth_methods_supported: ["none"],
      scopes_supported: OAUTH_SCOPES,
    });
  });

  // No record is kept of a client: its id is its own registration, sealed under the orchestrator's
  // key, so a forged or altered id does not open, and nothing piles up from clients that register
  // and never come back.
  app.post("/oauth/register", async (c) => {
    if (!available) return unavailable(c);
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    try {
      if (!body) throw new OAuthError("invalid_client_metadata", "send the registration as JSON");
      const method = body.token_endpoint_auth_method ?? "none";
      if (method !== "none") throw new OAuthError("invalid_client_metadata", "this orchestrator registers public clients only (token_endpoint_auth_method none)");
      const name = typeof body.client_name === "string" ? body.client_name.replace(/\p{C}+/gu, " ").trim().slice(0, 100) : "";
      const client: Client = { name: name || "An MCP client", redirectUris: cleanRedirects(body.redirect_uris) };
      return c.json({ client_id: sealClient(client), client_name: client.name, redirect_uris: client.redirectUris, token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] }, 201);
    } catch (err) {
      if (err instanceof OAuthError) return c.json({ error: err.code, error_description: err.message }, 400);
      throw err;
    }
  });

  const signedIn = async (c: Context) => {
    const found = [];
    const tenants = orgs.memberships ? await orgs.memberships(c) : orgs.list().map((o) => o.ctx.tenant);
    for (const tenant of tenants) {
      const ctx = await ctxOf(tenant);
      if (!ctx) continue;
      const session = await sessionOf(c, ctx.store, ctx.tenant, secure);
      if (session) found.push({ ctx, user: session.user, csrf: session.csrf });
    }
    return found;
  };

  app.get("/oauth/authorize", async (c) => {
    if (!available) return page(c, "Not available", "<h1>Not available</h1><p>This orchestrator signs no MCP client in. Ask an admin to set ORCHESTRATOR_PUBLIC_URL and ORCHESTRATOR_SECRET_KEY, or use an API key.</p>", 400);
    const q = (name: string) => c.req.query(name);
    const client = openClient(q("client_id") ?? "");
    const redirectUri = q("redirect_uri") ?? "";
    // Until the client and its return address are known good, nothing is sent back to that address.
    if (!client || !client.redirectUris.includes(redirectUri)) return page(c, "Unknown client", "<h1>This sign-in link is not valid</h1><p>The app that opened it is not registered with this orchestrator, or asked to return somewhere it did not register. Start again from the app.</p>", 400);
    const back = (params: Record<string, string>) => {
      const url = new URL(redirectUri);
      for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
      if (q("state")) url.searchParams.set("state", q("state")!);
      return c.redirect(url.toString(), 302);
    };
    if (q("response_type") !== "code") return back({ error: "unsupported_response_type" });
    if (q("code_challenge_method") !== "S256" || !/^[A-Za-z0-9_-]{43,128}$/.test(q("code_challenge") ?? "")) return back({ error: "invalid_request", error_description: "PKCE with S256 is required" });
    if (q("resource") && q("resource") !== resource) return back({ error: "invalid_target", error_description: "this orchestrator grants access to its own MCP server only" });
    let scopes: string[];
    try {
      scopes = scopesOf(q("scope"));
    } catch (err) {
      return back({ error: (err as OAuthError).code, error_description: (err as Error).message });
    }
    const sessions = await signedIn(c);
    if (!sessions.length) {
      return page(
        c,
        "Sign in first",
        `<h1>Sign in to the orchestrator first</h1><p><strong>${escape(client.name)}</strong> asks to reach the TeamHandbook Orchestrator as you. <a href="/" target="_blank" rel="noopener">Sign in to the orchestrator</a> in this browser, then reload this page.</p>`,
      );
    }
    sweep(Date.now());
    const id = randomBytes(24).toString("base64url");
    consents.set(id, {
      clientId: q("client_id")!,
      clientName: client.name,
      redirectUri,
      challenge: q("code_challenge")!,
      scopes,
      state: q("state") ?? null,
      sessions: sessions.map((s) => ({ tenant: s.ctx.tenant, csrf: s.csrf, userId: s.user.id })),
      shownAt: Date.now(),
    });
    const orgChoice =
      sessions.length === 1
        ? `<input type="hidden" name="org" value="${escape(sessions[0]!.ctx.tenant)}"><p>As <strong>${escape(sessions[0]!.user.name)}</strong> (${escape(sessions[0]!.user.email)}) in <strong>${escape(sessions[0]!.ctx.tenant)}</strong>.</p>`
        : `<fieldset><legend>As</legend>${sessions.map((s, i) => `<label><input type="radio" name="org" value="${escape(s.ctx.tenant)}"${i === 0 ? " checked" : ""}> ${escape(s.user.name)} in ${escape(s.ctx.tenant)}</label>`).join("")}</fieldset>`;
    const scopeList = OAUTH_SCOPES.filter((s) => scopes.includes(s) || s.endsWith(":write"))
      .map((s) => {
        const write = s.endsWith(":write");
        return write
          ? `<label><input type="checkbox" name="scope" value="${s}"${scopes.includes(s) ? " checked" : ""}> ${escape(SCOPE_TEXT[s]!)}</label>`
          : `<label><input type="checkbox" checked disabled> ${escape(SCOPE_TEXT[s]!)}</label><input type="hidden" name="scope" value="${s}">`;
      })
      .join("");
    return page(
      c,
      "Approve access",
      `<h1>Allow ${escape(client.name)} to reach the orchestrator?</h1>` +
        `<p class="muted">It returns to <code>${escape(new URL(redirectUri).host)}</code>. It acts as you and never beyond your role; nothing it does merges a request.</p>` +
        `<form method="post" action="/oauth/authorize"><input type="hidden" name="consent" value="${id}">${orgChoice}<fieldset><legend>It may</legend>${scopeList}</fieldset>` +
        `<p><button type="submit" name="decision" value="approve">Approve</button><button class="secondary" type="submit" name="decision" value="deny">Deny</button></p></form>`,
    );
  });

  app.post("/oauth/authorize", async (c) => {
    if (!available) return unavailable(c);
    const form = await c.req.parseBody({ all: true });
    const consent = consents.get(String(form.consent ?? ""));
    consents.delete(String(form.consent ?? ""));
    if (!consent || Date.now() - consent.shownAt > CONSENT_MS) return page(c, "Expired", "<h1>This approval expired</h1><p>Start again from the app.</p>", 400);
    // The decision counts only from the session the page was shown to: the session cookie is
    // SameSite=Strict, so a form another site submits arrives without it and is refused here.
    const tenant = String(form.org ?? "");
    const shown = consent.sessions.find((s) => s.tenant === tenant);
    const ctx = await ctxOf(tenant);
    const now = ctx ? await sessionOf(c, ctx.store, tenant, secure) : null;
    const sameSession = Boolean(shown && now && now.user.id === shown.userId && now.csrf.length === shown.csrf.length && timingSafeEqual(Buffer.from(now.csrf), Buffer.from(shown.csrf)));
    if (!ctx || !sameSession) return page(c, "Not approved", "<h1>Not approved</h1><p>This approval did not come from the browser session it was shown to. Start again from the app.</p>", 403);
    const url = new URL(consent.redirectUri);
    if (consent.state) url.searchParams.set("state", consent.state);
    if (form.decision !== "approve") {
      url.searchParams.set("error", "access_denied");
      return c.redirect(url.toString(), 302);
    }
    const ticked = new Set(([] as unknown[]).concat(form.scope ?? []).map(String));
    // Reading is what the app asked for; writing is what the person ticked on the page, whatever the app asked.
    const scopes = [...consent.scopes.filter((s) => s.endsWith(":read")), ...OAUTH_SCOPES.filter((s) => s.endsWith(":write") && ticked.has(s))];
    const code = randomBytes(32).toString("base64url");
    codes.set(code, { tenant, userId: now!.user.id, clientId: consent.clientId, clientName: consent.clientName, redirectUri: consent.redirectUri, challenge: consent.challenge, scopes, issuedAt: Date.now() });
    await ctx.audit?.(await principalOf(ctx.store, now!.user), "oauth.approved", { subject: "oauth", detail: `allowed ${consent.clientName} to reach the orchestrator's MCP server (${scopes.join(" ")})` });
    url.searchParams.set("code", code);
    return c.redirect(url.toString(), 302);
  });

  const issue = async (ctx: OrchestratorContext, userId: string, clientName: string, scopes: string[], grantId = randomBytes(12).toString("hex")) => {
    const access = newToken(ACCESS, ctx.tenant);
    const refresh = newToken(REFRESH, ctx.tenant);
    const now = Date.now();
    const row = (kind: TokenRow["kind"], ms: number): TokenRow => ({ kind, grant: grantId, userId, scopes, expiresAt: new Date(now + ms).toISOString() });
    await ctx.store.setSetting(ctx.tenant, tokenKey(hash(access)), JSON.stringify(row("access", ACCESS_MS)));
    await ctx.store.setSetting(ctx.tenant, tokenKey(hash(refresh)), JSON.stringify(row("refresh", REFRESH_MS)));
    const grant: GrantRow = { userId, clientName, scopes, createdAt: new Date(now).toISOString(), tokens: [hash(access), hash(refresh)] };
    await ctx.store.setSetting(ctx.tenant, grantKey(grantId), JSON.stringify(grant));
    return { access_token: access, token_type: "Bearer", expires_in: ACCESS_MS / 1000, refresh_token: refresh, scope: scopes.join(" ") };
  };

  const dropGrant = (ctx: OrchestratorContext, grantId: string) => dropGrantRows(ctx, grantId);

  app.post("/oauth/token", async (c) => {
    c.header("Cache-Control", "no-store");
    if (!available) return unavailable(c);
    const form = await c.req.parseBody();
    const field = (name: string) => (typeof form[name] === "string" ? (form[name] as string) : "");
    const fail = (error: string, description: string) => c.json({ error, error_description: description }, 400);
    if (field("grant_type") === "authorization_code") {
      const code = codes.get(field("code"));
      codes.delete(field("code"));
      if (!code || Date.now() - code.issuedAt > CODE_MS) return fail("invalid_grant", "the code is unknown, used or expired");
      if (code.clientId !== field("client_id") || code.redirectUri !== field("redirect_uri")) return fail("invalid_grant", "the code was issued to another client or return address");
      const verified = createHash("sha256").update(field("code_verifier")).digest("base64url");
      if (verified.length !== code.challenge.length || !timingSafeEqual(Buffer.from(verified), Buffer.from(code.challenge))) return fail("invalid_grant", "the code_verifier does not match");
      const ctx = await ctxOf(code.tenant);
      if (!ctx) return fail("invalid_grant", "the organization is gone");
      return c.json(await issue(ctx, code.userId, code.clientName, code.scopes));
    }
    if (field("grant_type") === "refresh_token") {
      const token = field("refresh_token");
      const ctx = await ctxOf(oauthTenant(token));
      if (!ctx || !token.startsWith(`${REFRESH}.`)) return fail("invalid_grant", "the refresh token is unknown or was used");
      // One refresh of a token at a time: two requests sent with it at once would each read it
      // unspent and each mint a pair, and the pair the grant no longer lists would outlive a revoke.
      // The one that waits reads it again, spent.
      const answer = await inTurn(`${ctx.tenant}:${hash(token)}`, async () => {
        const raw = await ctx.store.getSetting(ctx.tenant, tokenKey(hash(token)));
        const row = raw ? (JSON.parse(raw) as TokenRow) : null;
        if (!row || row.kind !== "refresh") return null;
        // Rotated: the old pair is gone before the new one is handed out, so a stolen refresh token used once is spent.
        const grant = await dropGrant(ctx, row.grant);
        if (row.expiresAt <= new Date().toISOString() || !grant) return "expired" as const;
        // An account removed since takes its grants with it; nothing is issued in its name.
        if (!(await ctx.store.getUser(ctx.tenant, row.userId))) return null;
        return issue(ctx, row.userId, grant.clientName, row.scopes, row.grant);
      });
      if (answer === null) return fail("invalid_grant", "the refresh token is unknown or was used");
      if (answer === "expired") return fail("invalid_grant", "the refresh token expired; approve the app again");
      return c.json(answer);
    }
    return fail("unsupported_grant_type", "this orchestrator takes authorization_code and refresh_token");
  });

  app.post("/oauth/revoke", async (c) => {
    if (!available) return unavailable(c);
    const token = String((await c.req.parseBody()).token ?? "");
    const ctx = await ctxOf(oauthTenant(token));
    const raw = ctx ? await ctx.store.getSetting(ctx.tenant, tokenKey(hash(token))) : null;
    if (ctx && raw) await dropGrant(ctx, (JSON.parse(raw) as TokenRow).grant);
    return c.body(null, 200);
  });

  return app;
}

/** An app a person approved, as their Access page shows it: never a token, nor a token's hash. */
export interface AppGrant {
  id: string;
  clientName: string;
  scopes: string[];
  createdAt: string;
}

/** The apps a person approved to reach the orchestrator's MCP server, newest first. */
export async function grantsOf(ctx: Pick<OrchestratorContext, "store" | "tenant">, userId: string): Promise<AppGrant[]> {
  const grants: AppGrant[] = [];
  for (const row of await ctx.store.listSettings(ctx.tenant, grantKey(""))) {
    const grant = JSON.parse(row.value) as GrantRow;
    if (grant.userId === userId) grants.push({ id: row.key.slice(grantKey("").length), clientName: grant.clientName, scopes: grant.scopes, createdAt: grant.createdAt });
  }
  return grants.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Ends one of a person's grants and every token it holds, and says which app it was; null when they hold none by that id. */
export async function revokeGrant(ctx: Pick<OrchestratorContext, "store" | "tenant">, userId: string, grantId: string): Promise<string | null> {
  const raw = /^[0-9a-f]{24}$/.test(grantId) ? await ctx.store.getSetting(ctx.tenant, grantKey(grantId)) : null;
  const grant = raw ? (JSON.parse(raw) as GrantRow) : null;
  if (!grant || grant.userId !== userId) return null;
  await dropGrantRows(ctx, grantId);
  return grant.clientName;
}

/** Deletes a grant and the tokens it lists, and returns what it held. */
async function dropGrantRows(ctx: Pick<OrchestratorContext, "store" | "tenant">, grantId: string): Promise<GrantRow | null> {
  const raw = await ctx.store.getSetting(ctx.tenant, grantKey(grantId));
  const grant = raw ? (JSON.parse(raw) as GrantRow) : null;
  for (const h of grant?.tokens ?? []) await ctx.store.deleteSetting(ctx.tenant, tokenKey(h));
  await ctx.store.deleteSetting(ctx.tenant, grantKey(grantId));
  return grant;
}

/**
 * The person an access token acts as, read from the store at each call so a role taken away or an
 * account removed takes effect at once, carrying the scopes they approved as a key carries its own.
 */
export async function oauthPrincipal(ctx: Pick<OrchestratorContext, "store" | "tenant">, token: string, now = new Date()): Promise<Principal | null> {
  if (!token.startsWith(`${ACCESS}.`) || oauthTenant(token) !== ctx.tenant) return null;
  const raw = await ctx.store.getSetting(ctx.tenant, tokenKey(hash(token)));
  const row = raw ? (JSON.parse(raw) as TokenRow) : null;
  if (!row || row.kind !== "access" || row.expiresAt <= now.toISOString()) return null;
  const user = await ctx.store.getUser(ctx.tenant, row.userId);
  if (!user) {
    // The account is gone: its grant goes too, rather than waiting for a refresh that never comes.
    await dropGrantRows(ctx, row.grant);
    return null;
  }
  // At a verified domain only the identity provider lets a member in; an app's token is not a way around it.
  if (await keyRefused(ctx.store, ctx.tenant, user)) return null;
  return { ...(await principalOf(ctx.store, user)), key: { id: `oauth:${row.grant}`, owner: { kind: "user", id: user.id }, scopes: keyScopes(row.scopes), expiresAt: row.expiresAt } };
}
