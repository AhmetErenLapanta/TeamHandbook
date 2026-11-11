import { randomBytes } from "node:crypto";
import type { OrchestratorContext } from "../app.js";
import { OrchestratorError } from "../errors.js";
import { forgeDestination } from "../connect.js";
import { readSecretEnv } from "../secret-env.js";
import { installationSettingsUrl } from "./oauth-github.js";
import { pinnedFetch } from "./pinned-fetch.js";
import { maskSecrets, readSecret, storeSecret } from "../vault.js";

/**
 * One click from the screen to a team's GitLab or GitHub: the operator registers the orchestrator
 * once as a GitLab OAuth application or a GitHub App, and an owner or an admin of an org signs
 * in to it in the browser. The org then holds one connection per forge, sealed in the vault,
 * and the repositories connected through it are reached with tokens the orchestrator renews itself.
 * An orchestrator without the application keeps the token form it always had.
 */
export const APP_FORGES = ["gitlab", "github"] as const;
export type AppForge = (typeof APP_FORGES)[number];

export interface GitLabApp {
  kind: "gitlab";
  /** The instance's address, https://gitlab.com unless the operator names a self-managed one. */
  webUrl: string;
  apiUrl: string;
  clientId: string;
  clientSecret: string;
  /** How calls reach it: held to the address judged for an org's own GitLab, plain fetch for the operator's. */
  send?: typeof fetch;
}

export interface GitHubApp {
  kind: "github";
  webUrl: string;
  apiUrl: string;
  appId: string;
  /** The app's URL name, as github.com/apps/<slug> shows it. */
  slug: string;
  clientId: string;
  clientSecret: string;
  privateKey: string;
  /** The secret GitHub signs the app's own deliveries with; without it they are not taken. */
  webhookSecret?: string;
}

export interface ForgeApps {
  gitlab?: GitLabApp;
  github?: GitHubApp;
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** An application's address: https, or plain http on this machine for a stand-in. */
function appAddress(raw: string, name: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${name} is not an address`);
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACK.has(url.hostname))) throw new Error(`${name} is https (plain http only on this machine)`);
  if (url.username || url.password || url.search || url.hash) throw new Error(`${name} is an address with no credential, query or fragment`);
  return url;
}

/**
 * The applications the operator registered, from the environment. A forge's settings are all
 * set or none: half of them would show a Connect button that fails on its first use.
 */
export function forgeAppsFromEnv(env: NodeJS.ProcessEnv): ForgeApps {
  const apps: ForgeApps = {};
  const group = (prefix: string, names: string[], secrets: string[]) => {
    const values = Object.fromEntries([...names.map((n) => [n, env[`${prefix}${n}`]?.trim() || undefined]), ...secrets.map((n) => [n, readSecretEnv(env, `${prefix}${n}`)])]) as Record<string, string | undefined>;
    const given = Object.entries(values).filter(([, v]) => v);
    if (!given.length) return null;
    const missing = Object.entries(values).filter(([, v]) => !v).map(([n]) => `${prefix}${n}`);
    if (missing.length) throw new Error(`set ${missing.join(", ")} as well, or none of ${prefix}*`);
    return values as Record<string, string>;
  };
  const gitlab = group("ORCHESTRATOR_FORGE_GITLAB_", ["CLIENT_ID"], ["CLIENT_SECRET"]);
  if (gitlab) {
    const web = appAddress(env.ORCHESTRATOR_FORGE_GITLAB_URL?.trim() || "https://gitlab.com", "ORCHESTRATOR_FORGE_GITLAB_URL");
    const webUrl = web.toString().replace(/\/+$/, "");
    apps.gitlab = { kind: "gitlab", webUrl, apiUrl: `${webUrl}/api/v4`, clientId: gitlab.CLIENT_ID!, clientSecret: gitlab.CLIENT_SECRET! };
  }
  const github = group("ORCHESTRATOR_FORGE_GITHUB_", ["APP_ID", "APP_SLUG", "CLIENT_ID"], ["CLIENT_SECRET", "PRIVATE_KEY"]);
  if (github) {
    const web = appAddress(env.ORCHESTRATOR_FORGE_GITHUB_URL?.trim() || "https://github.com", "ORCHESTRATOR_FORGE_GITHUB_URL");
    // The same two places connect.ts reaches GitHub at: github.com, or a stand-in on this machine.
    if (web.hostname !== "github.com" && !LOOPBACK.has(web.hostname)) throw new Error("ORCHESTRATOR_FORGE_GITHUB_URL is https://github.com, or a stand-in on this machine");
    if (!/^[0-9]+$/.test(github.APP_ID!)) throw new Error("ORCHESTRATOR_FORGE_GITHUB_APP_ID is the app's number");
    if (!/^[a-z0-9][a-z0-9-]{0,99}$/.test(github.APP_SLUG!)) throw new Error("ORCHESTRATOR_FORGE_GITHUB_APP_SLUG is the app's URL name");
    if (!github.PRIVATE_KEY!.includes("PRIVATE KEY-----")) throw new Error("ORCHESTRATOR_FORGE_GITHUB_PRIVATE_KEY is the app's private key in PEM");
    const webUrl = web.origin;
    const webhookSecret = readSecretEnv(env, "ORCHESTRATOR_FORGE_GITHUB_WEBHOOK_SECRET");
    if (webhookSecret !== undefined && webhookSecret.length < 16) throw new Error("ORCHESTRATOR_FORGE_GITHUB_WEBHOOK_SECRET is at least 16 characters");
    apps.github = { kind: "github", webUrl, apiUrl: web.hostname === "github.com" ? "https://api.github.com" : `${webUrl}/api`, appId: github.APP_ID!, slug: github.APP_SLUG!, clientId: github.CLIENT_ID!, clientSecret: github.CLIENT_SECRET!, privateKey: github.PRIVATE_KEY!, ...(webhookSecret ? { webhookSecret } : {}) };
  }
  return apps;
}

/**
 * An org's own GitLab OAuth application, for a self-managed GitLab the operator's application
 * does not reach: entered by an owner, its secret sealed in the vault. Where it is set it is the
 * org's GitLab; elsewhere the operator's is.
 */
export interface OrgGitLabApp {
  webUrl: string;
  clientId: string;
  by: string;
  at: string;
}

export const ORG_GITLAB_APP = "forge.gitlab.app";

export async function readOrgGitLabApp(ctx: Pick<OrchestratorContext, "store" | "tenant">): Promise<OrgGitLabApp | null> {
  const raw = await ctx.store.getSetting(ctx.tenant, ORG_GITLAB_APP);
  try {
    return raw ? (JSON.parse(raw) as OrgGitLabApp) : null;
  } catch {
    return null;
  }
}

/** The application an org connects a forge through: its own GitLab one when an owner entered it, else the operator's. */
/** What finds an org's forge application and judges where an org's own one may be reached. */
export type ForgeAppContext = Pick<OrchestratorContext, "store" | "tenant" | "vault" | "forgeApps" | "internalForgeHosts" | "resolveHost">;

export async function forgeApp<K extends AppForge>(ctx: ForgeAppContext, kind: K): Promise<(K extends "gitlab" ? GitLabApp : GitHubApp) | null> {
  type App = K extends "gitlab" ? GitLabApp : GitHubApp;
  if (kind === "gitlab") {
    const own = await readOrgGitLabApp(ctx);
    if (own) {
      const secret = await readSecret(ctx.store, ctx.vault ?? null, ctx.tenant, ORG_GITLAB_APP).catch(() => null);
      if (!secret) return null;
      // Judged on every use and held there: the client secret and the tokens go only to the address judged now.
      const web = new URL(own.webUrl);
      const send = pinnedFetch(web.host, await forgeDestination(ctx, web));
      return { kind: "gitlab", webUrl: own.webUrl, apiUrl: `${own.webUrl}/api/v4`, clientId: own.clientId, clientSecret: secret, send } as App;
    }
  }
  return (ctx.forgeApps?.[kind] as App | undefined) ?? null;
}

/** What the org keeps of a connection beside its sealed tokens: who connected which account, and what went wrong since. */
export interface ConnectionRecord {
  via: "oauth" | "app";
  /** The account on the forge: the GitLab user signed in, or the GitHub account the app is installed on. */
  account: string;
  /** The API origin it was made for; a connection made for another address is not used. */
  apiUrl: string;
  /** Where the sign-in returned; GitLab asks for the same address again on every renewal. */
  redirectUri?: string;
  installationId?: number;
  /** Whether the GitHub account the app is on is an organization: only there does an app create a repository. */
  organization?: boolean;
  by: string;
  byEmail: string;
  at: string;
  /** Why the tokens could not be renewed, until someone connects again. */
  problem: string | null;
}

/** A connection as the API shows it. The token is never part of it. */
export interface ForgeConnection {
  via: "oauth" | "app";
  account: string;
  by: string;
  at: string;
  repos: number;
  problem: string | null;
  /** GitHub only: where the installation's repositories are chosen, so a repository made by hand can be added to it. */
  manageUrl?: string;
}

export interface GitLabTokens {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: string | null;
}

export const connectionKey = (kind: AppForge) => `forge.connection.${kind}`;

export async function readConnection(ctx: Pick<OrchestratorContext, "store" | "tenant">, kind: AppForge): Promise<ConnectionRecord | null> {
  const raw = await ctx.store.getSetting(ctx.tenant, connectionKey(kind));
  try {
    return raw ? (JSON.parse(raw) as ConnectionRecord) : null;
  } catch {
    return null;
  }
}

export async function writeConnection(ctx: Pick<OrchestratorContext, "store" | "tenant">, kind: AppForge, record: ConnectionRecord): Promise<void> {
  await ctx.store.setSetting(ctx.tenant, connectionKey(kind), JSON.stringify(record));
}

/** The repositories connected from the screen that reach their forge through this connection. */
export function connectionRepos(ctx: Pick<OrchestratorContext, "addedRepos">, kind: AppForge): string[] {
  return [...(ctx.addedRepos ?? new Map()).values()].filter((a) => a.connection === kind).map((a) => a.id);
}

/** The org's connection to a forge for the Integrations card; null when there is none. */
export async function forgeConnectionView(ctx: Pick<OrchestratorContext, "store" | "tenant" | "addedRepos" | "forgeApps">, kind: AppForge): Promise<ForgeConnection | null> {
  const record = await readConnection(ctx, kind);
  if (!record) return null;
  const github = kind === "github" ? ctx.forgeApps?.github : undefined;
  return { via: record.via, account: record.account, by: record.by, at: record.at, repos: connectionRepos(ctx, kind).length, problem: record.problem, ...(github ? { manageUrl: installationSettingsUrl(github, record) } : {}) };
}

/** A forge's sign-in that failed, in words for the screen: never a token, never the forge's whole answer. */
export class ForgeSignInFailed extends Error {}

const MESSAGE_MAX = 200;

type Json = Record<string, unknown>;

async function postForm(url: string, form: Record<string, string>, secrets: string[], send: typeof fetch = fetch): Promise<Json> {
  let res: Response;
  try {
    res = await send(url, { method: "POST", headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(form).toString(), redirect: "manual", signal: AbortSignal.timeout(30_000) });
  } catch {
    throw new ForgeSignInFailed(`${new URL(url).host} is unreachable`);
  }
  const body = (await res.json().catch(() => ({}))) as Json;
  if (!res.ok || typeof body.error === "string") {
    const said = typeof body.error_description === "string" ? body.error_description : typeof body.error === "string" ? body.error : `answered ${res.status}`;
    const failure = new ForgeSignInFailed(maskSecrets(`GitLab refused: ${said}`, secrets).replace(/\p{C}+/gu, " ").slice(0, MESSAGE_MAX));
    (failure as ForgeSignInFailed & { code?: string }).code = typeof body.error === "string" ? body.error : undefined;
    throw failure;
  }
  return body;
}

export async function apiGet<T>(url: string, headers: Record<string, string>, secrets: string[], send: typeof fetch = fetch): Promise<T> {
  let res: Response;
  try {
    res = await send(url, { headers: { accept: "application/json", ...headers }, redirect: "manual", signal: AbortSignal.timeout(30_000) });
  } catch {
    throw new ForgeSignInFailed(`${new URL(url).host} is unreachable`);
  }
  if (!res.ok) throw new ForgeSignInFailed(maskSecrets(`${new URL(url).host} answered ${res.status} on ${new URL(url).pathname}`, secrets).slice(0, MESSAGE_MAX));
  return (await res.json()) as T;
}

function gitlabTokens(body: Json, now: Date, previous: string | null): GitLabTokens {
  if (typeof body.access_token !== "string" || !body.access_token) throw new ForgeSignInFailed("GitLab's sign-in returned no access token");
  const seconds = Number(body.expires_in);
  return {
    accessToken: body.access_token,
    refreshToken: typeof body.refresh_token === "string" && body.refresh_token ? body.refresh_token : previous,
    expiresAt: Number.isFinite(seconds) && seconds > 0 ? new Date(now.getTime() + seconds * 1000).toISOString() : null,
  };
}

/** GitLab's sign-in page for this orchestrator's application, asking for the `api` scope: requests, commits, projects and hooks all need it. */
export function gitlabAuthorizeUrl(app: GitLabApp, redirectUri: string, state: string, challenge: string): string {
  const url = new URL(`${app.webUrl}/oauth/authorize`);
  for (const [k, v] of Object.entries({ client_id: app.clientId, redirect_uri: redirectUri, response_type: "code", scope: "api", state, code_challenge: challenge, code_challenge_method: "S256" })) url.searchParams.set(k, v);
  return url.toString();
}

export async function gitlabExchange(app: GitLabApp, code: string, verifier: string, redirectUri: string, now = new Date()): Promise<GitLabTokens> {
  const body = await postForm(`${app.webUrl}/oauth/token`, { grant_type: "authorization_code", client_id: app.clientId, client_secret: app.clientSecret, code, redirect_uri: redirectUri, code_verifier: verifier }, [app.clientSecret, code], app.send);
  return gitlabTokens(body, now, null);
}

/** The username the tokens sign in as: what the card names the connection by. */
export async function gitlabAccount(app: GitLabApp, accessToken: string): Promise<string> {
  const user = await apiGet<{ username?: unknown }>(`${app.apiUrl}/user`, { authorization: `Bearer ${accessToken}` }, [accessToken], app.send);
  if (typeof user.username !== "string" || !user.username) throw new ForgeSignInFailed("GitLab named no user for the sign-in");
  return user.username.slice(0, 100);
}

/** Asks GitLab to forget the tokens. Best effort: the orchestrator forgets them either way. */
export async function gitlabRevoke(app: GitLabApp, tokens: GitLabTokens): Promise<void> {
  await postForm(`${app.webUrl}/oauth/revoke`, { client_id: app.clientId, client_secret: app.clientSecret, token: tokens.accessToken }, [app.clientSecret, tokens.accessToken], app.send).catch(() => undefined);
}

/** A GitLab token is renewed this long before it lapses, so a fetch or a request never starts on one about to. */
export const RENEW_AHEAD_MS = 5 * 60_000;

const renewing = new Map<string, Promise<string>>();

export async function readGitLabTokens(ctx: Pick<OrchestratorContext, "store" | "tenant" | "vault">): Promise<GitLabTokens | null> {
  const raw = await readSecret(ctx.store, ctx.vault ?? null, ctx.tenant, connectionKey("gitlab"));
  return raw ? (JSON.parse(raw) as GitLabTokens) : null;
}

/** Why a connection gave no token, in words for a log or a screen; a route answers it as a conflict the card tells how to fix. */
export class ConnectionUnusable extends OrchestratorError {
  constructor(message: string) {
    super("forge-connection", message, 409);
  }
}

/** Whether sealed tokens last long enough to start a fetch or a request on. */
function lasting(tokens: GitLabTokens | null, now: Date): boolean {
  return Boolean(tokens && (!tokens.expiresAt || Date.parse(tokens.expiresAt) - now.getTime() > RENEW_AHEAD_MS));
}

/**
 * A token for the org's GitLab connection that lasts at least a few minutes, renewed with the
 * refresh token when it would not. GitLab spends a refresh token on use, so one renewal runs at a
 * time for an org: in this process by a shared promise, across the web and task-runner processes
 * by a lease in the database, whose holder reads the sealed tokens again before it spends one.
 */
export async function gitlabToken(ctx: ForgeAppContext, now = new Date()): Promise<string> {
  const app = await forgeApp(ctx, "gitlab");
  const record = await readConnection(ctx, "gitlab");
  if (!app || !record) throw new ConnectionUnusable("GitLab is not connected for this organization; an owner or an admin connects it under Integrations");
  if (new URL(record.apiUrl).origin !== new URL(app.apiUrl).origin) throw new ConnectionUnusable("the GitLab connection was made for another GitLab address; an owner or an admin connects GitLab again under Integrations");
  if (record.problem) throw new ConnectionUnusable(`the GitLab connection needs to be made again: ${record.problem}; an owner or an admin connects GitLab again under Integrations`);
  const tokens = await readGitLabTokens(ctx);
  if (!tokens) throw new ConnectionUnusable("the GitLab connection holds no token; an owner or an admin connects GitLab again under Integrations");
  if (lasting(tokens, now)) return tokens.accessToken;
  const key = `${ctx.tenant}:gitlab`;
  const running = renewing.get(key);
  if (running) return running;
  const renewal = renewGitLab(ctx, app, now).finally(() => renewing.delete(key));
  renewing.set(key, renewal);
  return renewal;
}

const RENEW_LEASE = "forge.renewing.gitlab";
/** Long enough for one call to GitLab's token endpoint, which gives up after thirty seconds. */
const LEASE_MS = 45_000;
const LEASE_POLL_MS = 250;

async function renewGitLab(ctx: Pick<OrchestratorContext, "store" | "tenant" | "vault">, app: GitLabApp, now: Date): Promise<string> {
  const holder = randomBytes(9).toString("base64url");
  for (let waited = 0; ; waited += LEASE_POLL_MS) {
    const at = new Date();
    if (await ctx.store.claimLease(ctx.tenant, RENEW_LEASE, holder, new Date(at.getTime() + LEASE_MS).toISOString(), at.toISOString())) break;
    // Another process is renewing: what it seals is the token to use.
    await new Promise((resolve) => setTimeout(resolve, LEASE_POLL_MS));
    const sealed = await readGitLabTokens(ctx);
    if (sealed && lasting(sealed, now)) return sealed.accessToken;
    if (waited > LEASE_MS) throw new ConnectionUnusable("the GitLab token is being renewed; try again in a minute");
  }
  try {
    const record = await readConnection(ctx, "gitlab");
    const tokens = await readGitLabTokens(ctx);
    if (!record || !tokens) throw new ConnectionUnusable("GitLab is not connected for this organization; an owner or an admin connects it under Integrations");
    if (record.problem) throw new ConnectionUnusable(`the GitLab connection needs to be made again: ${record.problem}; an owner or an admin connects GitLab again under Integrations`);
    if (lasting(tokens, now)) return tokens.accessToken;
    if (!tokens.refreshToken) return await markBroken(ctx, "gitlab", record, "GitLab gave no refresh token, and the token has lapsed");
    try {
      const body = await postForm(`${app.webUrl}/oauth/token`, { grant_type: "refresh_token", client_id: app.clientId, client_secret: app.clientSecret, refresh_token: tokens.refreshToken, redirect_uri: record.redirectUri ?? "" }, [app.clientSecret, tokens.refreshToken, tokens.accessToken], app.send);
      const fresh = gitlabTokens(body, now, tokens.refreshToken);
      await storeSecret(ctx.store, ctx.vault ?? null, ctx.tenant, connectionKey("gitlab"), JSON.stringify(fresh), record.byEmail);
      return fresh.accessToken;
    } catch (err) {
      if (!(err instanceof ForgeSignInFailed)) throw err;
      if ((err as ForgeSignInFailed & { code?: string }).code === "invalid_grant") return await markBroken(ctx, "gitlab", record, "GitLab no longer accepts its sign-in (it was revoked, or the application changed)");
      throw new ConnectionUnusable(`the GitLab token was not renewed: ${err.message}; try again, and if it repeats, an owner or an admin connects GitLab again under Integrations`);
    }
  } finally {
    await ctx.store.deleteSetting(ctx.tenant, RENEW_LEASE);
  }
}

/**
 * Marks the connection to be made again, unless someone made it again meanwhile: a new connection is not marked for the old one's failure.
 * `step` is what fixes it, when that is not connecting again: a suspension is lifted on GitHub itself.
 */
export async function markBroken(ctx: Pick<OrchestratorContext, "store" | "tenant">, kind: AppForge, record: ConnectionRecord, problem: string, step = `an owner or an admin connects ${kind === "gitlab" ? "GitLab" : "GitHub"} again under Integrations`): Promise<never> {
  const current = await readConnection(ctx, kind);
  if (current && current.at === record.at) await writeConnection(ctx, kind, { ...current, problem });
  throw new ConnectionUnusable(`the ${kind === "gitlab" ? "GitLab" : "GitHub"} connection needs to be made again: ${problem}; ${step}`);
}

export async function sealGitLabTokens(ctx: Pick<OrchestratorContext, "store" | "tenant" | "vault">, tokens: GitLabTokens, by: string): Promise<void> {
  await storeSecret(ctx.store, ctx.vault ?? null, ctx.tenant, connectionKey("gitlab"), JSON.stringify(tokens), by);
}

/** A sign-in begun in a browser, by its state: in memory, since a lost one is simply begun again. */
export interface PendingConnect {
  tenant: string;
  kind: AppForge;
  userId: string;
  verifier: string;
  redirectUri: string;
  browser: string;
  /** The page the browser returns to: the welcome wizard that began it, or Integrations. */
  page: ReturnPage;
  startedAt: number;
}

export type ReturnPage = "integrations" | "welcome";

export const PENDING_CONNECT_MS = 10 * 60_000;

export class PendingConnects {
  private readonly pending = new Map<string, PendingConnect>();

  add(entry: Omit<PendingConnect, "startedAt">, now = Date.now()): string {
    for (const [state, p] of this.pending) if (now - p.startedAt > PENDING_CONNECT_MS) this.pending.delete(state);
    const state = randomBytes(24).toString("base64url");
    this.pending.set(state, { ...entry, startedAt: now });
    return state;
  }

  tenantOf(state: string, now = Date.now()): string | null {
    const found = this.pending.get(state);
    return found && now - found.startedAt <= PENDING_CONNECT_MS ? found.tenant : null;
  }

  take(state: string, now = Date.now()): PendingConnect | null {
    const found = this.pending.get(state);
    this.pending.delete(state);
    return found && now - found.startedAt <= PENDING_CONNECT_MS ? found : null;
  }
}

/** Every org's forge sign-ins: a forge returns each to the one callback address, and the state says whose it is. */
export const PENDING_CONNECTS = new PendingConnects();

export const FORGE_CALLBACK = "/integrations/forge/callback";
