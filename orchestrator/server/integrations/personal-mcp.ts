import { createHash } from "node:crypto";
import { Hono } from "hono";
import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { OrchestratorContext } from "../app.js";
import { secureOrchestrator } from "../auth.js";
import type { OrchestratorEnv, Principal } from "../auth.js";
import { ChangeRefused } from "../changes.js";
import { auditServer, refusalSummary } from "../plugin.js";
import { SERVER_NAME } from "../skill-rules.js";
import type { McpTool } from "../tasks/agents.js";
import { READING_TOOL } from "../tasks/profile.js";
import { maskSecrets, NO_VAULT, readSecret, storeSecret } from "../vault.js";
import { auditChange } from "./audit.js";
import { listTools, McpCallFailed } from "./mcp-client.js";
import { authorizeUrl, browserMark, discover, exchangeCode, freshTokens, OAuthFailed, oauthRefusal, PENDING_MS, PendingSignIns, pkce, register, sameBrowser } from "./mcp-oauth.js";
import type { OAuthServer, OAuthTokens } from "./mcp-oauth.js";
import { remoteUrl } from "./remote.js";
import { localMode } from "../mode.js";
import { READ_TOOLS } from "../work/mcp-jira.js";
import { CATALOG, catalogUrl } from "./catalog.js";
import { finishSlackAdd, slackApp, slackAuthorizeUrl, slackBase } from "./slack.js";
import { FORGES } from "../../shared/forge-def.js";
import { forgeApp } from "../forge/oauth.js";

/**
 * A person's own MCP server: given to the tasks they start, with their own access to it, and
 * to nobody else. A server meant for the whole team goes into the team repository through a
 * request, as every team change does.
 */
export interface PersonalServer {
  name: string;
  description: string;
  transport: "http" | "stdio";
  url?: string;
  command?: string;
  args?: string[];
  /** How a task reaches it: no credential, a static token, or the server's own sign-in. */
  auth: "none" | "token" | "oauth";
  /** The tools a task may call; a server with none is not given to a task at all. */
  tools: string[];
  /** The tools the server described when they were last loaded, each marked when it can change something. */
  known?: Record<string, { writes: boolean }>;
  /** The catalogue entry it was added from: once it is signed in, its tools that read are allowed, and no other. */
  catalog?: string;
  addedAt: string;
}

export const MAX_PERSONAL_SERVERS = 20;
export const MAX_TOOLS = 100;
const TOOL = /^[A-Za-z0-9_.-]{1,128}$/;
export const OAUTH_CALLBACK = "/integrations/mcp-oauth/callback";

const listKey = (userId: string) => `mcp.personal.${userId}`;
export const secretName = (userId: string, server: string, kind: "token" | "oauth") => `mcp.personal.${userId}.${server}.${kind}`;

export async function personalServers(ctx: Pick<OrchestratorContext, "store" | "tenant">, userId: string): Promise<PersonalServer[]> {
  const raw = await ctx.store.getSetting(ctx.tenant, listKey(userId));
  try {
    return raw ? (JSON.parse(raw) as PersonalServer[]) : [];
  } catch {
    return [];
  }
}

async function saveServers(ctx: Pick<OrchestratorContext, "store" | "tenant">, userId: string, servers: PersonalServer[]): Promise<void> {
  if (servers.length) await ctx.store.setSetting(ctx.tenant, listKey(userId), JSON.stringify(servers));
  else await ctx.store.deleteSetting(ctx.tenant, listKey(userId));
}

function cleanText(value: unknown, max: number, what: string): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (text.length > max) throw new ChangeRefused(`the ${what} is at most ${max} characters`);
  if (/\p{C}/u.test(text)) throw new ChangeRefused(`the ${what} holds a control character`);
  return text;
}

/** A server as a person describes it, checked by the same share rule a team server passes, so no literal secret sits in it. */
export function cleanServer(body: Record<string, unknown>, local: boolean, now = new Date()): PersonalServer {
  const name = String(body.name ?? "");
  if (!SERVER_NAME.test(name)) throw new ChangeRefused("a server name is letters, digits, dot, dash or underscore");
  const description = cleanText(body.description, 200, "description");
  const auth = body.auth ?? "none";
  if (auth !== "none" && auth !== "token" && auth !== "oauth") throw new ChangeRefused("auth is none, token or oauth");
  let entry: Pick<PersonalServer, "transport" | "url" | "command" | "args">;
  if (body.transport === "http") {
    entry = { transport: "http", url: remoteUrl(body.url, "the server's address", local).toString() };
  } else if (body.transport === "stdio") {
    if (auth !== "none") throw new ChangeRefused("a server run as a command takes no token or sign-in here; its command runs inside the task");
    const command = cleanText(body.command, 200, "command");
    if (!command) throw new ChangeRefused("name the command that starts the server");
    const args = body.args === undefined ? [] : body.args;
    if (!Array.isArray(args) || args.length > 50 || !args.every((a) => typeof a === "string" && a.length <= 500)) throw new ChangeRefused("args is a list of at most 50 arguments");
    entry = { transport: "stdio", command, args: args as string[] };
  } else {
    throw new ChangeRefused("a server is reached over http or run as a command (stdio)");
  }
  const audit = auditServer(entry.transport === "http" ? { type: "http", url: entry.url } : { command: entry.command, args: entry.args });
  if (!audit.migratable) throw new ChangeRefused(`this server is not taken as written: ${refusalSummary(audit)}`);
  return { name, description, ...entry, auth, tools: [], addedAt: now.toISOString() };
}

/**
 * Whether a tool can change something: what the server says of it (`readOnlyHint`,
 * `destructiveHint`) first, else its name, read by the pattern the run-as-me guard reads. A tool
 * neither says nor names as reading counts as writing, since a task's agent calls it as the person.
 */
export function toolWrites(name: string, annotations: { readOnlyHint?: boolean; destructiveHint?: boolean } = {}): boolean {
  if (annotations.destructiveHint === true) return true;
  if (annotations.readOnlyHint !== undefined) return !annotations.readOnlyHint;
  return !READING_TOOL.test(name);
}

/**
 * Whether a tool surely only reads: nothing it declares or its name says it writes, and its name
 * starts with a reading verb. A service names its tools after itself (notion-search,
 * linear_list_issues), so the verb is read past that. Only such a tool is allowed, or ticked,
 * before the person picks it.
 */
export function surelyReads(name: string, annotations: { readOnlyHint?: boolean; destructiveHint?: boolean } = {}, service?: string): boolean {
  return !toolWrites(name, annotations) && READING_TOOL.test(service ? name.replace(new RegExp(`^${service}[-_]`, "i"), "") : name);
}

/** Whether a picked tool writes, by what the server said when its tools were loaded, else by its name. */
export function pickedWrites(server: Pick<PersonalServer, "known">, tool: string): boolean {
  return server.known?.[tool]?.writes ?? toolWrites(tool);
}

export function cleanTools(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > MAX_TOOLS || !value.every((t) => typeof t === "string" && TOOL.test(t))) {
    throw new ChangeRefused(`tools is a list of at most ${MAX_TOOLS} tool names, letters, digits, dot, dash or underscore`);
  }
  return [...new Set(value as string[])].sort();
}

/** Where an organization's sign-in to a team's server is sealed, by the server's key. */
export const orgSecretName = (key: string) => `mcp.org.${key}.oauth`;

async function readSealedTokens(ctx: Pick<OrchestratorContext, "store" | "tenant" | "vault">, name: string): Promise<OAuthTokens | null> {
  const sealed = await readSecret(ctx.store, ctx.vault ?? null, ctx.tenant, name);
  return sealed ? (JSON.parse(sealed) as OAuthTokens) : null;
}

const readTokens = (ctx: Pick<OrchestratorContext, "store" | "tenant" | "vault">, userId: string, server: string) => readSealedTokens(ctx, secretName(userId, server, "oauth"));

/** The access token sealed under `name`, renewed and sealed again first when it is about to expire; null when there is none that works. */
export async function sealedAccess(ctx: Pick<OrchestratorContext, "store" | "tenant" | "vault">, name: string, send: typeof fetch = fetch): Promise<string | null> {
  const tokens = await readSealedTokens(ctx, name);
  if (!tokens) return null;
  const fresh = await freshTokens(tokens, send);
  if (!fresh) return null;
  if (fresh !== tokens) await storeSecret(ctx.store, ctx.vault ?? null, ctx.tenant, name, JSON.stringify(fresh), "orchestrator");
  return fresh.accessToken;
}

/**
 * The credential a call to the server carries now: a static token, or the sign-in's access
 * token, refreshed and sealed again first when it is about to expire. Null when the server
 * needs one and has none that works.
 */
export async function credentialFor(ctx: Pick<OrchestratorContext, "store" | "tenant" | "vault">, userId: string, server: PersonalServer, send: typeof fetch = fetch): Promise<string | null | undefined> {
  if (server.auth === "none") return undefined;
  if (server.auth === "token") return readSecret(ctx.store, ctx.vault ?? null, ctx.tenant, secretName(userId, server.name, "token"));
  return sealedAccess(ctx, secretName(userId, server.name, "oauth"), send);
}

/** The variable a task's agent reads one server's credential from; the server's definition names it, never the value. */
export function credentialVariable(server: string): string {
  return `TH_MCP_${server.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`;
}

/** A server as a task's agent gets it: remote with headers that name variables, or a command the task runs. */
export type TaskServer = { type: "http"; url: string; headers: Record<string, string> } | { command: string; args: string[] };

export interface UserMcp {
  servers: Record<string, TaskServer>;
  tools: McpTool[];
  /** Each variable a server's headers name, with its value: for the agent's environment and the redaction of every log line. */
  secrets: Record<string, string>;
  /** Why a server of theirs was left out, for the task's log. */
  notes: string[];
}

export const NO_USER_MCP: UserMcp = { servers: {}, tools: [], secrets: {}, notes: [] };

/** A team's server as the organization connects it: its key is its name and address, the same server in every repository that declares it. */
export function teamServerKey(name: string, url: string): string {
  return createHash("sha256").update(`${name}\0${normalAddress(url)}`).digest("hex").slice(0, 16);
}

/** What an owner or admin set for a team's server, for everyone's tasks: the tools a task may call of it. */
export interface OrgServer {
  name: string;
  url: string;
  tools: string[];
  known?: Record<string, { writes: boolean }>;
}

export interface OrgConnection {
  by: string;
  email: string;
  at: string;
}

const orgKey = (key: string) => `mcp.org.${key}`;

export async function readOrgServer(ctx: Pick<OrchestratorContext, "store" | "tenant">, key: string): Promise<OrgServer | null> {
  const raw = await ctx.store.getSetting(ctx.tenant, orgKey(key));
  return raw ? (JSON.parse(raw) as OrgServer) : null;
}

export async function saveOrgServer(ctx: Pick<OrchestratorContext, "store" | "tenant">, key: string, server: OrgServer): Promise<void> {
  await ctx.store.setSetting(ctx.tenant, orgKey(key), JSON.stringify(server));
}

export async function readOrgConnection(ctx: Pick<OrchestratorContext, "store" | "tenant">, key: string): Promise<OrgConnection | null> {
  const raw = await ctx.store.getSetting(ctx.tenant, `${orgKey(key)}.connection`);
  return raw ? (JSON.parse(raw) as OrgConnection) : null;
}

/** Forgets the organization's sign-in to a team's server; its tool picks stay for the next one. */
export async function dropOrgConnection(ctx: Pick<OrchestratorContext, "store" | "tenant">, key: string): Promise<void> {
  await ctx.store.deleteSecret(ctx.tenant, orgSecretName(key));
  await ctx.store.deleteSetting(ctx.tenant, `${orgKey(key)}.connection`);
}

/** A remote server that sends no credential of its own: the kind a person or the organization signs in to. */
export function needsSignIn(config: unknown): config is { url: string } {
  const c = config as { url?: unknown; headers?: unknown } | null;
  if (!c || typeof c.url !== "string") return false;
  const values = c.headers && typeof c.headers === "object" && !Array.isArray(c.headers) ? Object.values(c.headers) : [];
  return !values.some((v) => typeof v === "string" && v.includes("${"));
}

/** An address as two definitions are compared by: the same server whatever case or trailing slash it is written with. */
function normalAddress(u: unknown): string | null {
  return typeof u === "string" && URL.canParse(u) ? new URL(u).toString().replace(/\/+$/, "").toLowerCase() : null;
}

function sameAddress(a: unknown, b: unknown): boolean {
  return normalAddress(a) !== null && normalAddress(a) === normalAddress(b);
}

/**
 * What a task the person starts gets of their own servers: each one with at least one tool
 * allowed and a credential that works, refreshed before the task starts, since nobody is there
 * to sign in during it. A server of theirs named as one the team repository declares, at the
 * same address, is their sign-in to the team's server: the team's definition goes to the task
 * with their credential (user decision, option A). At another address the team's stays and theirs
 * is left out. A sign-in that has lapsed leaves its server out; each says so in a note, and the
 * task runs on.
 */
export async function userMcpForTask(ctx: Pick<OrchestratorContext, "store" | "tenant" | "vault">, user: Principal, team: Record<string, unknown> = {}, send: typeof fetch = fetch): Promise<UserMcp> {
  const out: UserMcp = { servers: {}, tools: [], secrets: {}, notes: [] };
  for (const server of await personalServers(ctx, user.id)) {
    if (!server.tools.length) continue;
    const declared = Object.hasOwn(team, server.name) ? (team[server.name] as Record<string, unknown>) : null;
    if (declared && !(server.transport === "http" && sameAddress(declared.url, server.url))) {
      out.notes.push(`Your MCP server ${server.name} is left out: the team repository declares a server by that name at another address.`);
      continue;
    }
    let credential: string | null | undefined;
    try {
      credential = await credentialFor(ctx, user.id, server, send);
    } catch (err) {
      out.notes.push(`Your MCP server ${server.name} is left out: ${(err as Error).message}.`);
      continue;
    }
    if (credential === null) {
      out.notes.push(`Your MCP server ${server.name} is left out: ${server.auth === "oauth" ? "its sign-in has lapsed; connect it again under Integrations" : "no token is stored for it"}.`);
      continue;
    }
    const variable = credentialVariable(server.name);
    const headers: Record<string, string> = credential ? { Authorization: `Bearer \${${variable}}` } : {};
    out.servers[server.name] =
      declared ? { ...declared, headers } as TaskServer
      : server.transport === "http" ? { type: "http", url: server.url!, headers }
      : { command: server.command!, args: server.args ?? [] };
    if (credential) out.secrets[variable] = credential;
    out.tools.push(...server.tools.map((tool) => ({ server: server.name, tool })));
    const whose = credential ? `${user.name}'s own sign-in` : "no sign-in";
    out.notes.push(declared ? `MCP server ${server.name}, as the team declares it, comes with ${whose}.` : `MCP server ${server.name}, ${user.name}'s own, comes with ${whose}.`);
  }
  // A team server the starter has not signed in to comes with the organization's sign-in, when
  // an owner or admin connected it for everyone's tasks; with neither it cannot sign in in a task.
  for (const [name, config] of Object.entries(team)) {
    if (Object.hasOwn(out.servers, name) || !needsSignIn(config)) continue;
    const key = teamServerKey(name, config.url);
    const [org, connection] = [await readOrgServer(ctx, key), await readOrgConnection(ctx, key)];
    let credential: string | null = null;
    try {
      credential = connection ? await sealedAccess(ctx, orgSecretName(key), send) : null;
    } catch (err) {
      out.notes.push(`MCP server ${name} has no sign-in for this task: ${(err as Error).message}.`);
      continue;
    }
    if (!credential) {
      out.notes.push(`MCP server ${name} needs a sign-in, and nobody connected it for this task; connect it under Integrations.`);
      continue;
    }
    const variable = credentialVariable(name);
    out.servers[name] = { ...(config as { type: "http"; url: string }), headers: { Authorization: `Bearer \${${variable}}` } };
    out.secrets[variable] = credential;
    out.tools.push(...(org?.tools ?? []).map((tool) => ({ server: name, tool })));
    out.notes.push(`MCP server ${name}, as the team declares it, comes with the organization's sign-in, connected by ${connection!.by}.`);
  }
  return out;
}

function refused(c: Context, err: unknown) {
  const said = oauthRefusal(err) ?? (err instanceof McpCallFailed ? err.message : null);
  if (said !== null) return c.json({ error: said }, 400);
  throw err;
}

/**
 * The person's own MCP servers on the Integrations page: `signedIn` behind the orchestrator's
 * sign-in, and `open` for the one address a server's sign-in sends the browser back to. That
 * return carries no session - the orchestrator's cookie is kept to its own pages - so it finishes a
 * sign-in only for the browser that began it, by a cookie set when it began: a sign-in link
 * someone else opens and approves would otherwise store their access as the starter's server.
 */
/**
 * Starts a server's sign-in in this browser: for the person, or, with `org` set, for the
 * organization's tasks. Answers with the sign-in page to send the browser to.
 */
/**
 * Where a sign-in returns: the orchestrator's public address, or on one person's own machine,
 * where none is set, the address their browser reached it at.
 */
/** Whether a sign-in has an address to return to, so a page offers one only where it finishes. */
export const signsIn = (ctx: Pick<OrchestratorContext, "publicUrl">): boolean => Boolean(ctx.publicUrl) || localMode();

function callbackFor(ctx: Pick<OrchestratorContext, "publicUrl">, c: Context): string | null {
  const base = ctx.publicUrl ?? (localMode() ? new URL(c.req.url).origin : null);
  return base ? `${base.replace(/\/+$/, "")}${OAUTH_CALLBACK}` : null;
}

/**
 * The clients the orchestrator registered with servers' sign-ins, kept to be used again: GitLab
 * takes ten registrations an hour from one address and keeps each as an application on a
 * self-managed instance, so a client per press runs out and piles up. One is used again only
 * while the last sign-in begun with it came back, since a server that forgot a client shows its
 * own error page and never returns; it is dropped when the server calls it unknown. A client
 * given a secret is not kept, so no secret sits in settings.
 */
const KEPT_CLIENTS = "mcp.oauth.clients";
const MAX_KEPT_CLIENTS = 100;
interface KeptClient {
  clientId: string;
  begun: string;
  returned: string | null;
}

async function keptClients(ctx: Pick<OrchestratorContext, "store" | "tenant">): Promise<Record<string, KeptClient>> {
  const raw = await ctx.store.getSetting(ctx.tenant, KEPT_CLIENTS);
  try {
    return raw ? (JSON.parse(raw) as Record<string, KeptClient>) : {};
  } catch {
    return {};
  }
}

async function keepClient(ctx: Pick<OrchestratorContext, "store" | "tenant">, key: string, change: (kept: KeptClient | undefined) => KeptClient | null): Promise<void> {
  const all = await keptClients(ctx);
  const next = change(all[key]);
  if (next) all[key] = next;
  else delete all[key];
  const newest = Object.entries(all).sort(([, a], [, b]) => b.begun.localeCompare(a.begun)).slice(0, MAX_KEPT_CLIENTS);
  await ctx.store.setSetting(ctx.tenant, KEPT_CLIENTS, JSON.stringify(Object.fromEntries(newest)));
}

/** The client a sign-in begins with: the kept one while it has proven itself, else one registered now. */
async function clientFor(ctx: Pick<OrchestratorContext, "store" | "tenant">, found: OAuthServer, redirectUri: string, send: typeof fetch): Promise<{ clientId: string; clientSecret: string | null; kept: string | null }> {
  const key = found.registrationEndpoint ? `${found.registrationEndpoint} ${redirectUri}` : null;
  const begun = new Date().toISOString();
  const kept = key ? (await keptClients(ctx))[key] : undefined;
  if (key && kept && kept.returned !== null && kept.returned >= kept.begun) {
    await keepClient(ctx, key, (k) => (k ? { ...k, begun } : null));
    return { clientId: kept.clientId, clientSecret: null, kept: key };
  }
  const client = await register(found, redirectUri, send);
  if (!key || client.clientSecret) return { ...client, kept: null };
  await keepClient(ctx, key, () => ({ clientId: client.clientId, begun, returned: null }));
  return { ...client, kept: key };
}

/**
 * Starts "Add to Slack" in this browser: Slack's approval screen, where the person picks the
 * channel, and back to the one callback address every sign-in uses. Only a Slack app that whoever
 * runs the orchestrator registered can ask; without one the answer says so.
 */
export async function beginSlackAdd(ctx: OrchestratorContext, c: Context, user: Principal, events: string[]): Promise<Response> {
  const app = slackApp();
  if (!app) return c.json({ error: "Add to Slack needs a Slack app: whoever runs this orchestrator sets ORCHESTRATOR_SLACK_CLIENT_ID and ORCHESTRATOR_SLACK_CLIENT_SECRET. Paste a channel's webhook address under Other ways to connect instead." }, 409);
  const redirectUri = callbackFor(ctx, c);
  if (!redirectUri) return c.json({ error: "set ORCHESTRATOR_PUBLIC_URL to the address this orchestrator is reached at; a sign-in returns there" }, 409);
  if (!ctx.vault) return c.json({ error: NO_VAULT }, 409);
  try {
    const browser = browserMark();
    const state = PENDING_SIGN_INS.add({ tenant: ctx.tenant, user: { id: user.id, name: user.name, email: user.email }, server: "slack", verifier: "", tokenEndpoint: "", clientId: app.clientId, clientSecret: null, redirectUri, resource: "", browser: browser.hash, slack: { events } });
    const cookie = signInCookie(secureOrchestrator(ctx.publicUrl));
    setCookie(c, cookie.name, browser.value, { httpOnly: true, sameSite: "Lax", secure: secureOrchestrator(ctx.publicUrl), path: cookie.path, maxAge: PENDING_MS / 1000 });
    return c.json({ authorizeUrl: slackAuthorizeUrl(slackBase(process.env, Boolean(ctx.localMcp)), app.clientId, redirectUri, state) });
  } catch (err) {
    return refused(c, err);
  }
}

export async function beginSignIn(ctx: OrchestratorContext, c: Context, user: Principal, server: { name: string; url: string }, org: string | null, send: typeof fetch = fetch): Promise<Response> {
  const redirectUri = callbackFor(ctx, c);
  if (!redirectUri) return c.json({ error: "set ORCHESTRATOR_PUBLIC_URL to the address this orchestrator is reached at; a sign-in returns there" }, 409);
  if (!ctx.vault) return c.json({ error: NO_VAULT }, 409);
  try {
    const found = await discover(server.url, Boolean(ctx.localMcp), send);
    const client = await clientFor(ctx, found, redirectUri, send);
    const { verifier, challenge } = pkce();
    const browser = browserMark();
    const state = PENDING_SIGN_INS.add({ tenant: ctx.tenant, user: { id: user.id, name: user.name, email: user.email }, server: server.name, verifier, tokenEndpoint: found.tokenEndpoint, clientId: client.clientId, clientSecret: client.clientSecret, redirectUri, resource: server.url, browser: browser.hash, ...(org ? { org } : {}), ...(client.kept ? { kept: client.kept } : {}) });
    const cookie = signInCookie(secureOrchestrator(ctx.publicUrl));
    setCookie(c, cookie.name, browser.value, { httpOnly: true, sameSite: "Lax", secure: secureOrchestrator(ctx.publicUrl), path: cookie.path, maxAge: PENDING_MS / 1000 });
    return c.json({ authorizeUrl: authorizeUrl(found, client.clientId, redirectUri, state, challenge, server.url) });
  } catch (err) {
    return refused(c, err);
  }
}

/**
 * The cookie that ties a sign-in to the browser that began it: one for the whole orchestrator, since
 * every org's sign-ins return to the one callback address. Over https it is a `__Host-` cookie,
 * which a browser takes only for the whole host, so it lives at "/" there.
 */
export function signInCookie(secure: boolean): { name: string; path: string } {
  return { name: `${secure ? "__Host-" : ""}th_mcp_signin`, path: secure ? "/" : OAUTH_CALLBACK };
}

/**
 * Every org's sign-ins in one place, since a server sends each back to the one callback address
 * whichever org began it; each carries its org, and the callback finishes only its own org's.
 */
export const PENDING_SIGN_INS = new PendingSignIns();

/** Atlassian's own remote MCP server; ORCHESTRATOR_ATLASSIAN_MCP_URL names another, such as a stand-in on this machine. */
export const atlassianMcpUrl = () => process.env.ORCHESTRATOR_ATLASSIAN_MCP_URL ?? "https://mcp.atlassian.com/v1/mcp";
const ATLASSIAN = "atlassian";
/** What Work reads Jira with and a task reads its issue with: no tool that changes anything in Jira. */
const ATLASSIAN_READS = [...READ_TOOLS, "getJiraIssue"];

/** The person's own server at this address, and whether it is signed in; null when they have none. */
async function serverAt(ctx: OrchestratorContext, userId: string, url: string): Promise<{ name: string; connected: boolean } | null> {
  const server = (await personalServers(ctx, userId)).find((s) => s.url === url);
  if (!server) return null;
  return { name: server.name, connected: Boolean(await readTokens(ctx, userId, server.name).catch(() => null)) };
}

/** The person's own server that is Atlassian's, and whether it is signed in; null when they have none. */
export const atlassianServer = (ctx: OrchestratorContext, userId: string) => serverAt(ctx, userId, atlassianMcpUrl());

/**
 * GitLab's own MCP server at the organization's GitLab, by the forge's own setting and never by a
 * request: the org's GitLab application's address, else GitLab.com. Its sign-in gives a token for
 * MCP alone, so it reads GitLab as the person in their tasks; requests still open through the
 * forge's connection.
 */
export async function gitlabMcpUrl(ctx: OrchestratorContext): Promise<string> {
  const web = (await forgeApp(ctx, "gitlab").catch(() => null))?.webUrl ?? `https://${FORGES.gitlab.homeHosts[0]}`;
  return `${web.replace(/\/+$/, "")}/api/v4/mcp`;
}

/** The person's own server that is GitLab's, and whether it is signed in; null when they have none. */
export const gitlabServer = async (ctx: OrchestratorContext, userId: string) => serverAt(ctx, userId, await gitlabMcpUrl(ctx));

/** Each catalogue service with the person's own server for it, when they added one, and whether it is signed in. */
export async function catalogFor(ctx: OrchestratorContext, userId: string): Promise<{ id: string; name: string; about: string; server: { name: string; connected: boolean; tools: number } | null }[]> {
  const servers = await personalServers(ctx, userId);
  return Promise.all(
    CATALOG.map(async (entry) => {
      const server = servers.find((s) => s.url === catalogUrl(entry));
      return { id: entry.id, name: entry.name, about: entry.about, server: server ? { name: server.name, connected: Boolean(await readTokens(ctx, userId, server.name).catch(() => null)), tools: server.tools.length } : null };
    }),
  );
}

export function personalMcpRoutes(ctx: OrchestratorContext, send: typeof fetch = fetch): { open: Hono; signedIn: Hono<OrchestratorEnv> } {
  const pending = PENDING_SIGN_INS;
  const local = Boolean(ctx.localMcp);
  const open = new Hono();
  const signedIn = new Hono<OrchestratorEnv>();

  const view = async (user: Principal, server: PersonalServer) => {
    const token = server.auth === "token" ? await ctx.store.secretSetAt(ctx.tenant, secretName(user.id, server.name, "token")) : null;
    const tokens = server.auth === "oauth" ? await readTokens(ctx, user.id, server.name).catch(() => null) : null;
    return {
      ...server,
      writing: server.tools.filter((t) => pickedWrites(server, t)),
      credential:
        server.auth === "none" ? null
        : server.auth === "token" ? { set: Boolean(token), setAt: token?.updatedAt ?? null }
        : { set: Boolean(tokens), expiresAt: tokens?.expiresAt ?? null, refreshable: Boolean(tokens?.refreshToken) },
    };
  };
  // A catalogue server signed in for the first time gets its reading tools, and only those both the
  // server and the name say read: a tool it marks as writing, or whose name starts with no reading
  // verb, is left off even when marked read-only, as a person picks it by hand or not at all. A
  // failed read leaves the list empty for the person to load on the page.
  const allowReading = async (userId: string, name: string, access: string) => {
    const server = (await personalServers(ctx, userId)).find((s) => s.name === name);
    if (!server?.catalog || server.tools.length || !server.url) return;
    const tools = await listTools(server.url, { authorization: `Bearer ${access}` }, send).catch(() => null);
    if (!tools) return;
    const known = Object.fromEntries(tools.map((t) => [t.name, { writes: toolWrites(t.name, t.annotations) }]));
    const reading = tools.filter((t) => surelyReads(t.name, t.annotations, server.catalog)).map((t) => t.name);
    const servers = await personalServers(ctx, userId);
    await saveServers(ctx, userId, servers.map((s) => (s.name === name ? { ...s, tools: reading, known } : s)));
  };

  const find = async (c: Context<OrchestratorEnv>) => {
    const user = c.get("user");
    const servers = await personalServers(ctx, user.id);
    const server = servers.find((s) => s.name === c.req.param("name"));
    return { user, servers, server };
  };

  signedIn.get("/api/me/mcp-servers", async (c) => {
    const user = c.get("user");
    return c.json({ servers: await Promise.all((await personalServers(ctx, user.id)).map((s) => view(user, s))), signIn: signsIn(ctx), vault: Boolean(ctx.vault) });
  });

  signedIn.post("/api/me/mcp-servers", async (c) => {
    const user = c.get("user");
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    try {
      const server = cleanServer(body, local);
      const servers = await personalServers(ctx, user.id);
      if (servers.some((s) => s.name === server.name)) throw new ChangeRefused(`you already have a server named ${server.name}`);
      if (servers.length >= MAX_PERSONAL_SERVERS) throw new ChangeRefused(`a person keeps at most ${MAX_PERSONAL_SERVERS} servers of their own`);
      if (server.auth === "token") {
        const token = body.token;
        if (typeof token !== "string" || token.length < 8 || token.length > 4096 || /\s/.test(token)) throw new ChangeRefused("paste the server's token");
        if (!ctx.vault) throw new ChangeRefused(NO_VAULT);
        await storeSecret(ctx.store, ctx.vault, ctx.tenant, secretName(user.id, server.name, "token"), token, user.email);
      }
      await saveServers(ctx, user.id, [...servers, server]);
      await auditChange(ctx, user, "mcp.personal.added", { subject: `mcp:${server.name}`, detail: `added their own MCP server ${server.name} (${server.transport}${server.url ? ` ${new URL(server.url).host}` : ""})` });
      return c.json({ server: await view(user, server) }, 201);
    } catch (err) {
      if (err instanceof ChangeRefused) return c.json({ error: err.message }, 400);
      throw err;
    }
  });

  signedIn.patch("/api/me/mcp-servers/:name", async (c) => {
    const { user, servers, server } = await find(c);
    if (!server) return c.json({ error: "unknown server" }, 404);
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    try {
      const tools = body.tools === undefined ? server.tools : cleanTools(body.tools);
      if (body.token !== undefined) {
        if (server.auth !== "token") throw new ChangeRefused("this server takes no token");
        if (typeof body.token !== "string" || body.token.length < 8 || body.token.length > 4096 || /\s/.test(body.token)) throw new ChangeRefused("paste the server's token");
        if (!ctx.vault) throw new ChangeRefused(NO_VAULT);
        await storeSecret(ctx.store, ctx.vault, ctx.tenant, secretName(user.id, server.name, "token"), body.token, user.email);
      }
      const updated = { ...server, tools };
      await saveServers(ctx, user.id, servers.map((s) => (s.name === server.name ? updated : s)));
      const writing = tools.filter((t) => pickedWrites(server, t));
      await auditChange(ctx, user, "mcp.personal.changed", {
        subject: `mcp:${server.name}`,
        detail: `allowed ${tools.length} tool(s) of their MCP server ${server.name}${writing.length ? `, ${writing.length} of them able to change things (${writing.join(", ").slice(0, 200)})` : ""}${body.token !== undefined ? ", with a new token" : ""}`,
      });
      return c.json({ server: await view(user, updated) });
    } catch (err) {
      if (err instanceof ChangeRefused) return c.json({ error: err.message }, 400);
      throw err;
    }
  });

  signedIn.delete("/api/me/mcp-servers/:name", async (c) => {
    const { user, servers, server } = await find(c);
    if (!server) return c.json({ error: "unknown server" }, 404);
    await ctx.store.deleteSecret(ctx.tenant, secretName(user.id, server.name, "token"));
    await ctx.store.deleteSecret(ctx.tenant, secretName(user.id, server.name, "oauth"));
    await saveServers(ctx, user.id, servers.filter((s) => s.name !== server.name));
    await auditChange(ctx, user, "mcp.personal.removed", { subject: `mcp:${server.name}`, detail: `removed their own MCP server ${server.name} and its credential` });
    return c.json({ ok: true });
  });

  // Jira in one step from Integrations: Atlassian's own MCP server becomes the person's, allowed its
  // reading tools alone, and its sign-in begins at once; a second press signs the same server in again.
  /**
   * A service's own server added as the person's and its sign-in begun, in one press; a second
   * press signs the same server in again. A name already used for another address is refused with
   * what to do, and nothing changes.
   */
  const oneStep = async (c: Context<OrchestratorEnv>, wanted: { name: string; label: string; description: string; url: string; tools: string[]; catalog?: string }) => {
    const user = c.get("user");
    const servers = await personalServers(ctx, user.id);
    let server = servers.find((s) => s.url === wanted.url);
    if (!server) {
      if (servers.some((s) => s.name === wanted.name)) return c.json({ error: `You already have a server named ${wanted.name} at another address. Remove it under Your MCP servers, then sign in with ${wanted.label} again.` }, 409);
      if (servers.length >= MAX_PERSONAL_SERVERS) return c.json({ error: `You keep at most ${MAX_PERSONAL_SERVERS} servers of your own. Remove one under Your MCP servers, then sign in with ${wanted.label} again.` }, 409);
      server = { ...cleanServer({ name: wanted.name, description: wanted.description, transport: "http", url: wanted.url, auth: "oauth" }, local), tools: wanted.tools, ...(wanted.catalog ? { catalog: wanted.catalog } : {}) };
      await saveServers(ctx, user.id, [...servers, server]);
      await auditChange(ctx, user, "mcp.personal.added", { subject: `mcp:${wanted.name}`, detail: `added ${wanted.label}'s MCP server (${new URL(wanted.url).host}) to read it as themselves, its reading tools alone` });
    }
    return beginSignIn(ctx, c, user, { name: server.name, url: wanted.url }, null, send);
  };

  signedIn.post("/api/integrations/jira/sign-in", (c) => oneStep(c, { name: ATLASSIAN, label: "Atlassian", description: "Jira, read through Atlassian as you", url: atlassianMcpUrl(), tools: [...ATLASSIAN_READS] }));

  signedIn.post("/api/integrations/gitlab/sign-in", async (c) => oneStep(c, { name: "gitlab", label: "GitLab", description: "GitLab, read as you", url: await gitlabMcpUrl(ctx), tools: [], catalog: "gitlab" }));

  signedIn.post("/api/integrations/catalog/:id/sign-in", (c) => {
    const entry = CATALOG.find((e) => e.id === c.req.param("id"));
    if (!entry) return c.json({ error: "unknown service" }, 404);
    return oneStep(c, { name: entry.id, label: entry.name, description: `${entry.name}, read as you`, url: catalogUrl(entry), tools: [], catalog: entry.id });
  });

  signedIn.post("/api/me/mcp-servers/:name/connect", async (c) => {
    const { user, server } = await find(c);
    if (!server) return c.json({ error: "unknown server" }, 404);
    if (server.auth !== "oauth" || !server.url) return c.json({ error: "this server has no sign-in to connect" }, 400);
    return beginSignIn(ctx, c, user, { name: server.name, url: server.url }, null, send);
  });

  signedIn.post("/api/me/mcp-servers/:name/disconnect", async (c) => {
    const { user, server } = await find(c);
    if (!server) return c.json({ error: "unknown server" }, 404);
    await ctx.store.deleteSecret(ctx.tenant, secretName(user.id, server.name, "oauth"));
    await auditChange(ctx, user, "mcp.personal.disconnected", { subject: `mcp:${server.name}`, detail: `disconnected their MCP server ${server.name}` });
    return c.json({ ok: true });
  });

  signedIn.get("/api/me/mcp-servers/:name/tools", async (c) => {
    const { user, server } = await find(c);
    if (!server) return c.json({ error: "unknown server" }, 404);
    if (server.transport !== "http") return c.json({ error: "a server run as a command is not started by the orchestrator; name its tools" }, 409);
    try {
      const credential = await credentialFor(ctx, user.id, server, send);
      if (credential === null) return c.json({ error: server.auth === "oauth" ? "connect the server first" : "no token is stored for this server" }, 409);
      const tools = await listTools(server.url!, credential ? { authorization: `Bearer ${credential}` } : {}, send);
      const known = Object.fromEntries(tools.map((t) => [t.name, { writes: toolWrites(t.name, t.annotations) }]));
      // Remembered with the server, so the page marks the writing tools by what the server said, not by a guess at their names.
      const servers = await personalServers(ctx, user.id);
      await saveServers(ctx, user.id, servers.map((s) => (s.name === server.name ? { ...s, known } : s)));
      return c.json({ tools: tools.map((t) => ({ name: t.name, description: maskSecrets(t.description, [credential]), writes: known[t.name]!.writes, reads: surelyReads(t.name, t.annotations, server.catalog) })) });
    } catch (err) {
      return refused(c, err);
    }
  });

  open.get(OAUTH_CALLBACK, async (c) => {
    // The Integrations page of the org the sign-in was begun in, at the path the web app names it by.
    const back = (query: string) => c.redirect(`/${encodeURIComponent(ctx.tenant)}/integrations?${query}`, 302);
    const cookie = signInCookie(secureOrchestrator(ctx.publicUrl));
    const presented = getCookie(c, cookie.name);
    deleteCookie(c, cookie.name, { path: cookie.path, secure: secureOrchestrator(ctx.publicUrl) });
    const signIn = pending.take(c.req.query("state") ?? "");
    if (!signIn || signIn.tenant !== ctx.tenant) return back(`problem=${encodeURIComponent("That sign-in is unknown or expired; connect the server again.")}`);
    if (!sameBrowser(signIn, presented)) return back(`problem=${encodeURIComponent("That sign-in was begun in another browser; connect the server again from this one.")}`);
    // Back from the server at all, its client is known there; unless the server says it is not.
    const unknownClient = (code: string | null | undefined) => code === "invalid_client" || code === "unauthorized_client";
    const kept = signIn.kept;
    if (kept) await keepClient(ctx, kept, (k) => (!k || unknownClient(c.req.query("error")) ? null : { ...k, returned: new Date().toISOString() }));
    const code = c.req.query("code");
    // Slack's add comes back to the Slack card, not to the MCP servers'.
    const problem = (said: string) => back(`${signIn.slack ? "slackProblem" : "problem"}=${encodeURIComponent(said)}`);
    if (!code) return problem(signIn.slack ? "Slack was not completed; nothing was added." : `The sign-in to ${signIn.server} was not completed.`);
    try {
      if (signIn.slack) {
        await finishSlackAdd(ctx, { ...signIn, slack: signIn.slack }, code, send);
        return back("slack=added");
      }
      const tokens = await exchangeCode(signIn, code, send);
      const actor = { ...signIn.user, role: "member" as const, ownedTeams: [] };
      if (signIn.org) {
        await storeSecret(ctx.store, ctx.vault ?? null, ctx.tenant, orgSecretName(signIn.org), JSON.stringify(tokens), signIn.user.email);
        await ctx.store.setSetting(ctx.tenant, `mcp.org.${signIn.org}.connection`, JSON.stringify({ by: signIn.user.name, email: signIn.user.email, at: new Date().toISOString() }));
        await auditChange(ctx, actor, "mcp.org.connected", { subject: `mcp:${signIn.server}`, detail: `connected the team's MCP server ${signIn.server} for everyone's tasks, as the account they signed in with` });
      } else {
        await storeSecret(ctx.store, ctx.vault ?? null, ctx.tenant, secretName(signIn.user.id, signIn.server, "oauth"), JSON.stringify(tokens), signIn.user.email);
        await auditChange(ctx, actor, "mcp.personal.connected", { subject: `mcp:${signIn.server}`, detail: `connected their MCP server ${signIn.server}` });
        await allowReading(signIn.user.id, signIn.server, tokens.accessToken);
      }
      return back(`connected=${encodeURIComponent(signIn.server)}`);
    } catch (err) {
      if (kept && err instanceof OAuthFailed && unknownClient(err.code)) await keepClient(ctx, kept, () => null);
      const said = oauthRefusal(err);
      if (said === null) throw err;
      return problem(said);
    }
  });

  return { open, signedIn };
}
