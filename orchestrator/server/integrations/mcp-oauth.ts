import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { ChangeRefused } from "../changes.js";
import { remoteUrl } from "./remote.js";

/**
 * The sign-in an MCP server asks for, run by the orchestrator as the MCP authorization spec lays it
 * out: the server names its authorization server (protected resource metadata), the orchestrator
 * registers itself there as a client (dynamic client registration), sends the person's browser
 * to sign in once with PKCE, and keeps the tokens it gets back - sealed - to hand to the tasks
 * that person starts. Every address here is checked the way the server's own was.
 */
export const OAUTH_TIMEOUT_MS = 10_000;
/** A sign-in started and not finished within this is forgotten. */
export const PENDING_MS = 10 * 60_000;
/** A token this close to expiring is refreshed before a task gets it. */
export const REFRESH_AHEAD_MS = 60_000;

export interface OAuthServer {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint: string | null;
}

/** What is sealed for one connected server. */
export interface OAuthTokens {
  accessToken: string;
  refreshToken: string | null;
  /** ISO time the access token stops working, or null when the server did not say. */
  expiresAt: string | null;
  tokenEndpoint: string;
  clientId: string;
  clientSecret: string | null;
  resource: string;
}

export class OAuthFailed extends Error {
  /** The server's own OAuth error code, such as invalid_client, when it gave one. */
  constructor(message: string, readonly code: string | null = null) {
    super(message);
  }
}

type Json = Record<string, unknown>;

async function getJson(url: string, send: typeof fetch): Promise<Json | null> {
  try {
    const res = await send(url, { headers: { accept: "application/json" }, redirect: "error", signal: AbortSignal.timeout(OAUTH_TIMEOUT_MS) });
    if (!res.ok) {
      await res.body?.cancel();
      return null;
    }
    return (await res.json()) as Json;
  } catch {
    return null;
  }
}

/** A `.well-known` address for an issuer or resource that has a path: the path goes after the well-known name (RFC 8414, RFC 9728). */
function wellKnown(base: URL, name: string): string[] {
  const path = base.pathname.replace(/\/+$/, "");
  return path ? [`${base.origin}/.well-known/${name}${path}`, `${base.origin}/.well-known/${name}`] : [`${base.origin}/.well-known/${name}`];
}

/** Where the server's sign-in happens, read from the metadata it and its authorization server publish. */
export async function discover(serverUrl: string, local: boolean, send: typeof fetch = fetch): Promise<OAuthServer> {
  const server = new URL(serverUrl);
  let issuer = server.origin;
  for (const url of wellKnown(server, "oauth-protected-resource")) {
    const meta = await getJson(url, send);
    const named = Array.isArray(meta?.authorization_servers) ? meta!.authorization_servers[0] : undefined;
    if (typeof named === "string") {
      issuer = named;
      break;
    }
  }
  const issuerUrl = remoteUrl(issuer, "the server's sign-in address", local);
  let meta: Json | null = null;
  for (const url of [...wellKnown(issuerUrl, "oauth-authorization-server"), ...wellKnown(issuerUrl, "openid-configuration")]) {
    meta = await getJson(url, send);
    if (meta) break;
  }
  if (!meta || typeof meta.authorization_endpoint !== "string" || typeof meta.token_endpoint !== "string") {
    throw new OAuthFailed("the server names no sign-in the orchestrator can use: its authorization server publishes no metadata");
  }
  const methods = meta.code_challenge_methods_supported;
  if (Array.isArray(methods) && !methods.includes("S256")) throw new OAuthFailed("the server's sign-in does not take PKCE with S256, which the orchestrator requires");
  const endpoint = (value: unknown, what: string) => remoteUrl(value, what, local).toString();
  return {
    authorizationEndpoint: endpoint(meta.authorization_endpoint, "the sign-in page"),
    tokenEndpoint: endpoint(meta.token_endpoint, "the token address"),
    registrationEndpoint: typeof meta.registration_endpoint === "string" ? endpoint(meta.registration_endpoint, "the registration address") : null,
  };
}

async function postForm(url: string, form: Record<string, string>, send: typeof fetch): Promise<Json> {
  let res: Response;
  try {
    res = await send(url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams(form).toString(),
      redirect: "error",
      signal: AbortSignal.timeout(OAUTH_TIMEOUT_MS),
    });
  } catch {
    throw new OAuthFailed("the server's sign-in did not answer");
  }
  const body = (await res.json().catch(() => ({}))) as Json;
  if (!res.ok) throw new OAuthFailed(`the server's sign-in refused (${res.status}${typeof body.error === "string" ? `: ${body.error.slice(0, 60)}` : ""})`, typeof body.error === "string" ? body.error : null);
  return body;
}

/** Registers the orchestrator as a client of the server's sign-in, for one redirect address. */
export async function register(server: OAuthServer, redirectUri: string, send: typeof fetch = fetch): Promise<{ clientId: string; clientSecret: string | null }> {
  if (!server.registrationEndpoint) throw new OAuthFailed("the server's sign-in takes no client registration, so the orchestrator cannot connect to it");
  let res: Response;
  try {
    res = await send(server.registrationEndpoint, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ client_name: "TeamHandbook Orchestrator", redirect_uris: [redirectUri], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" }),
      redirect: "error",
      signal: AbortSignal.timeout(OAUTH_TIMEOUT_MS),
    });
  } catch {
    throw new OAuthFailed("the server's client registration did not answer");
  }
  const body = (await res.json().catch(() => ({}))) as Json;
  if (!res.ok || typeof body.client_id !== "string") throw new OAuthFailed(`the server refused to register the orchestrator (${res.status})`);
  return { clientId: body.client_id, clientSecret: typeof body.client_secret === "string" ? body.client_secret : null };
}

export function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

function tokensOf(body: Json, previous: Pick<OAuthTokens, "tokenEndpoint" | "clientId" | "clientSecret" | "resource" | "refreshToken">, now: Date): OAuthTokens {
  if (typeof body.access_token !== "string" || !body.access_token) throw new OAuthFailed("the server's sign-in returned no access token");
  const seconds = Number(body.expires_in);
  return {
    accessToken: body.access_token,
    refreshToken: typeof body.refresh_token === "string" ? body.refresh_token : previous.refreshToken,
    expiresAt: Number.isFinite(seconds) && seconds > 0 ? new Date(now.getTime() + seconds * 1000).toISOString() : null,
    tokenEndpoint: previous.tokenEndpoint,
    clientId: previous.clientId,
    clientSecret: previous.clientSecret,
    resource: previous.resource,
  };
}

const clientAuth = (t: Pick<OAuthTokens, "clientId" | "clientSecret">) => ({ client_id: t.clientId, ...(t.clientSecret ? { client_secret: t.clientSecret } : {}) });

export async function exchangeCode(
  pending: { tokenEndpoint: string; clientId: string; clientSecret: string | null; verifier: string; redirectUri: string; resource: string },
  code: string,
  send: typeof fetch = fetch,
  now = new Date(),
): Promise<OAuthTokens> {
  const body = await postForm(pending.tokenEndpoint, { grant_type: "authorization_code", code, redirect_uri: pending.redirectUri, code_verifier: pending.verifier, resource: pending.resource, ...clientAuth(pending) }, send);
  return tokensOf(body, { ...pending, refreshToken: null }, now);
}

/** The tokens, refreshed first when the access token is about to expire; null when it has expired and cannot be refreshed. */
export async function freshTokens(tokens: OAuthTokens, send: typeof fetch = fetch, now = new Date()): Promise<OAuthTokens | null> {
  if (!tokens.expiresAt || Date.parse(tokens.expiresAt) - now.getTime() > REFRESH_AHEAD_MS) return tokens;
  if (!tokens.refreshToken) return null;
  try {
    const body = await postForm(tokens.tokenEndpoint, { grant_type: "refresh_token", refresh_token: tokens.refreshToken, resource: tokens.resource, ...clientAuth(tokens) }, send);
    return tokensOf(body, tokens, now);
  } catch (err) {
    if (err instanceof OAuthFailed) return null;
    throw err;
  }
}

/** The sign-ins under way, by their state: in memory, since one orchestrator process runs them and a lost one is started again. */
export interface PendingSignIn {
  tenant: string;
  /** Who began it, as the event log names them when it is finished. */
  user: { id: string; name: string; email: string };
  server: string;
  verifier: string;
  tokenEndpoint: string;
  clientId: string;
  clientSecret: string | null;
  redirectUri: string;
  resource: string;
  /** The hash of the value the beginning browser was given in a cookie; only that browser finishes the sign-in. */
  browser: string;
  /** Set when an owner or admin connects a team's server for everyone's tasks: the server's key in the organization. */
  org?: string;
  /** The kept client this sign-in used, by its key, so its return proves the client or forgets it. */
  kept?: string;
  /** Set when an owner or admin adds the orchestrator to Slack: the events to post once Slack names the channel. */
  slack?: { events: string[] };
  startedAt: number;
}

export class PendingSignIns {
  private readonly pending = new Map<string, PendingSignIn>();

  add(entry: Omit<PendingSignIn, "startedAt">, now = Date.now()): string {
    for (const [state, p] of this.pending) if (now - p.startedAt > PENDING_MS) this.pending.delete(state);
    const state = randomBytes(24).toString("base64url");
    this.pending.set(state, { ...entry, startedAt: now });
    return state;
  }

  /** The org whose sign-in this state began, without using it up. */
  tenantOf(state: string, now = Date.now()): string | null {
    const found = this.pending.get(state);
    return found && now - found.startedAt <= PENDING_MS ? found.tenant : null;
  }

  /** The sign-in this state began, once: a second callback with it finds nothing. */
  take(state: string, now = Date.now()): PendingSignIn | null {
    const found = this.pending.get(state);
    this.pending.delete(state);
    return found && now - found.startedAt <= PENDING_MS ? found : null;
  }
}

/** A value for the browser that begins a sign-in, and the hash the pending sign-in keeps of it. */
export function browserMark(): { value: string; hash: string } {
  const value = randomBytes(24).toString("base64url");
  return { value, hash: createHash("sha256").update(value).digest("hex") };
}

/** Whether the browser returning from a sign-in is the one that began it. */
export function sameBrowser(pending: Pick<PendingSignIn, "browser">, presented: string | undefined): boolean {
  if (!presented) return false;
  const given = createHash("sha256").update(presented).digest();
  const kept = Buffer.from(pending.browser, "hex");
  return given.length === kept.length && timingSafeEqual(given, kept);
}

export function authorizeUrl(server: OAuthServer, clientId: string, redirectUri: string, state: string, challenge: string, resource: string): string {
  const url = new URL(server.authorizationEndpoint);
  for (const [k, v] of Object.entries({ response_type: "code", client_id: clientId, redirect_uri: redirectUri, state, code_challenge: challenge, code_challenge_method: "S256", resource })) url.searchParams.set(k, v);
  return url.toString();
}

export function oauthRefusal(err: unknown): string | null {
  return err instanceof OAuthFailed || err instanceof ChangeRefused ? err.message : null;
}
