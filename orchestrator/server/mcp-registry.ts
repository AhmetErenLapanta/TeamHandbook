import { Hono } from "hono";
import type { OrchestratorContext } from "./app.js";
import type { OrchestratorEnv } from "./auth.js";
import { OrchestratorError } from "./errors.js";
import { recordEvent } from "./events.js";
import { detectSecret } from "./plugin.js";

/**
 * An MCP Registry the orchestrator reads servers from, at the address its operator gives; with none
 * given the orchestrator reads no registry at all. The registry is only read: approving a server is
 * the orchestrator's own record, and a server reaches teammates only through a request someone opens
 * and the team merges, as every other change does.
 */
export interface RegistryServer {
  name: string;
  description: string;
  version: string | null;
  repository: string | null;
  /** How the orchestrator would declare it in a team's .mcp.json, pinned to this version; null when neither a remote nor an npm or PyPI package gives one. */
  config: Record<string, unknown> | null;
  /** Whether the name's namespace belongs to who publishes it: the GitHub owner of its repository, or the domain its remotes are served from. */
  namespace: { verified: true } | { verified: false; reason: string };
}

export interface ApprovedServer {
  name: string;
  version: string | null;
  config: Record<string, unknown>;
  approvedBy: string;
  approvedAt: string;
}

export const APPROVED_SETTING = "mcp.registry.approved";
export const REGISTRY_TIMEOUT_MS = 10_000;
const CACHE_MS = 5 * 60_000;
const CACHE_KEPT = 100;
const MAX_BYTES = 1024 * 1024;
const MAX_APPROVED = 200;
const NAME = /^[a-zA-Z0-9.-]+\/[a-zA-Z0-9._-]+$/;
// One release and nothing else: a tag such as latest or next, a range, or a wildcard takes whatever
// is published when a teammate's session starts, which is what approving a version rules out.
const NPM_EXACT = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;
const PYPI_EXACT = /^\d+(\.\d+)*((a|b|rc)\d+)?(\.post\d+)?(\.dev\d+)?$/;
const LOOPBACK = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/|$)/;

/** The registry's address from the environment, or null when none is set. Anything but https, or plain http to this machine, is refused at start. */
export function registryUrl(value: string | undefined = process.env.ORCHESTRATOR_MCP_REGISTRY_URL): string | null {
  if (!value) return null;
  if (!value.startsWith("https://") && !LOOPBACK.test(value)) throw new Error("ORCHESTRATOR_MCP_REGISTRY_URL must be an https address");
  if (!URL.canParse(value) || detectSecret(value) || /\/\/[^/]*@/.test(value)) throw new Error("ORCHESTRATOR_MCP_REGISTRY_URL must be an address with no credential in it");
  return value.replace(/\/+$/, "");
}

const text = (value: unknown, max = 300): string => (typeof value === "string" ? value.replace(/\p{C}/gu, " ").trim().slice(0, max) : "");

/**
 * Whether a server's name is in a namespace its publisher holds, as the registry's own rule
 * reads it: `io.github.<owner>/...` belongs to that GitHub owner, so its repository has to be
 * theirs; any other reversed domain, `com.example/...`, to that domain, so its remotes have to be
 * served from it. One that cannot be checked is not verified.
 */
export function namespaceCheck(name: string, repository: string | null, remotes: string[]): RegistryServer["namespace"] {
  if (!NAME.test(name)) return { verified: false, reason: "the name is not a reversed domain and a server name" };
  const namespace = name.split("/")[0]!.toLowerCase();
  if (namespace.startsWith("io.github.")) {
    const owner = namespace.slice("io.github.".length);
    const repoOwner = /^https:\/\/github\.com\/([^/]+)\//i.exec(repository ?? "")?.[1]?.toLowerCase();
    return repoOwner === owner ? { verified: true } : { verified: false, reason: `its repository is not under the GitHub owner ${owner}` };
  }
  const labels = namespace.split(".");
  // A single label is a whole top-level domain, and github.io is GitHub's shared host: a remote on
  // any of their subdomains says nothing about who holds the name.
  if (labels.length < 2 || !labels.every(Boolean)) return { verified: false, reason: "its namespace is not a domain of at least two labels" };
  if (namespace === "io.github") return { verified: false, reason: "io.github is GitHub's shared host; a GitHub namespace names its owner, io.github.<owner>" };
  const domain = labels.reverse().join(".");
  if (!remotes.length) return { verified: false, reason: `nothing it serves is on ${domain}, so the namespace is not checked` };
  const off = remotes.filter((u) => {
    const host = URL.canParse(u) ? new URL(u).hostname.toLowerCase() : "";
    return host !== domain && !host.endsWith(`.${domain}`);
  });
  return off.length ? { verified: false, reason: `it is served from outside ${domain}` } : { verified: true };
}

/** One registry entry as the orchestrator keeps it, or null when it is not one: the registry's current shape wraps it in `server`, an older one did not. */
export function readServer(raw: unknown): RegistryServer | null {
  const item = (raw as { server?: unknown } | null)?.server ?? raw;
  if (!item || typeof item !== "object") return null;
  const s = item as { name?: unknown; description?: unknown; version?: unknown; repository?: { url?: unknown }; remotes?: unknown; packages?: unknown };
  const name = text(s.name, 200);
  if (!NAME.test(name)) return null;
  const version = text(s.version, 50) || null;
  const repository = text(s.repository?.url, 300) || null;
  const remotes = (Array.isArray(s.remotes) ? s.remotes : []).flatMap((r) => {
    const url = text((r as { url?: unknown }).url, 500);
    return url.startsWith("https://") && URL.canParse(url) && !detectSecret(url) ? [url] : [];
  });
  const packages = (Array.isArray(s.packages) ? s.packages : []) as { registryType?: unknown; registry_type?: unknown; identifier?: unknown; name?: unknown; version?: unknown }[];
  let config: Record<string, unknown> | null = remotes[0] ? { type: "http", url: remotes[0] } : null;
  for (const p of packages) {
    if (config) break;
    const kind = text(p.registryType ?? p.registry_type, 20);
    const id = text(p.identifier ?? p.name, 200);
    const pinned = text(p.version, 50) || version;
    if (!id || !pinned || !/^[@a-zA-Z0-9][\w@./-]*$/.test(id)) continue;
    if (kind === "npm" && NPM_EXACT.test(pinned)) config = { command: "npx", args: ["-y", `${id}@${pinned}`] };
    else if (kind === "pypi" && PYPI_EXACT.test(pinned)) config = { command: "uvx", args: [`${id}==${pinned}`] };
  }
  const description = text(s.description);
  return {
    name,
    description: detectSecret(description) ? "" : description,
    version,
    repository: repository && !detectSecret(repository) ? repository : null,
    config,
    namespace: namespaceCheck(name, repository, remotes),
  };
}

const cache = new Map<string, { at: number; value: unknown }>();

/** A GET to the registry: no redirect followed, a time limit, a size limit, kept a few minutes. */
export async function registryGet(url: string, send: typeof fetch = fetch, now = Date.now()): Promise<unknown> {
  const kept = cache.get(url);
  if (kept && now - kept.at < CACHE_MS) return kept.value;
  let res: Response;
  try {
    res = await send(url, { headers: { accept: "application/json" }, redirect: "error", signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS) });
  } catch {
    throw new OrchestratorError("registry-unreachable", "the MCP registry did not answer; try again in a moment", 502);
  }
  if (res.status === 404) return null;
  const body = await res.text();
  if (!res.ok || body.length > MAX_BYTES) throw new OrchestratorError("registry-refused", `the MCP registry answered ${res.status}`, 502);
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    throw new OrchestratorError("registry-refused", "the MCP registry's answer is not JSON", 502);
  }
  if (cache.size >= CACHE_KEPT) cache.delete(cache.keys().next().value!);
  cache.set(url, { at: now, value });
  return value;
}

export async function approvedServers(ctx: Pick<OrchestratorContext, "store" | "tenant">): Promise<ApprovedServer[]> {
  try {
    const list = JSON.parse((await ctx.store.getSetting(ctx.tenant, APPROVED_SETTING)) ?? "[]") as unknown;
    return Array.isArray(list) ? (list as ApprovedServer[]) : [];
  } catch {
    return [];
  }
}

export function registryRoutes(ctx: OrchestratorContext): Hono<OrchestratorEnv> {
  const app = new Hono<OrchestratorEnv>();
  const configured = (): string => {
    if (!ctx.mcpRegistry) throw new OrchestratorError("registry-off", "no MCP registry is set for this orchestrator; its operator sets ORCHESTRATOR_MCP_REGISTRY_URL", 404);
    return ctx.mcpRegistry;
  };

  // Servers matching a search, approved ones first: what the team is offered before anything else.
  app.get("/api/mcp-registry", async (c) => {
    if (!ctx.mcpRegistry) return c.json({ configured: false, servers: [], approved: await approvedServers(ctx) });
    const search = text(c.req.query("search"), 100);
    const cursor = text(c.req.query("cursor"), 200);
    const query = new URLSearchParams({ limit: "30", ...(search ? { search } : {}), ...(cursor ? { cursor } : {}) });
    const body = (await registryGet(`${configured()}/v0/servers?${query}`)) as { servers?: unknown; metadata?: { nextCursor?: unknown; next_cursor?: unknown } } | null;
    if (!body || !Array.isArray(body.servers)) throw new OrchestratorError("registry-refused", "the MCP registry's answer has no list of servers", 502);
    const approved = await approvedServers(ctx);
    const names = new Set(approved.map((a) => a.name));
    const servers = body.servers.flatMap((s) => {
      const read = readServer(s);
      return read ? [{ ...read, approved: names.has(read.name) }] : [];
    });
    servers.sort((a, b) => Number(b.approved) - Number(a.approved));
    const next = text(body.metadata?.nextCursor ?? body.metadata?.next_cursor, 200) || null;
    return c.json({ configured: true, servers, approved, nextCursor: next });
  });

  // Approving reads the server from the registry again rather than taking what the page sent,
  // and keeps only a server whose namespace checks out and whose declaration the orchestrator can pin.
  app.put("/api/mcp-registry/approved", async (c) => {
    const user = c.get("user");
    if (user.role !== "owner") throw new OrchestratorError("forbidden", "only an owner approves registry servers", 403);
    const name = text(((await c.req.json().catch(() => ({}))) as { name?: unknown }).name, 200);
    if (!NAME.test(name)) throw new OrchestratorError("invalid", "name a registry server as namespace/name");
    const raw = await registryGet(`${configured()}/v0/servers/${encodeURIComponent(name)}/versions/latest`);
    const server = raw === null ? null : readServer(raw);
    if (!server || server.name !== name) throw new OrchestratorError("not-found", `the MCP registry has no server ${name}`, 404);
    if (!server.namespace.verified) throw new OrchestratorError("registry-namespace", `${name} is not approved: ${server.namespace.reason}`, 409);
    if (!server.config) throw new OrchestratorError("registry-unpinnable", `${name} is not approved: it offers no https remote and no npm or PyPI package at a fixed version`, 409);
    const approved = (await approvedServers(ctx)).filter((a) => a.name !== name);
    if (approved.length >= MAX_APPROVED) throw new OrchestratorError("invalid", `at most ${MAX_APPROVED} servers are approved at once`);
    const entry: ApprovedServer = { name, version: server.version, config: server.config, approvedBy: user.email, approvedAt: new Date().toISOString() };
    await ctx.store.setSetting(ctx.tenant, APPROVED_SETTING, JSON.stringify([...approved, entry]));
    await recordEvent(ctx, user, "mcp.registry.approved", { subject: `mcp:${name}`, detail: `approved the registry server ${name}${server.version ? ` at ${server.version}` : ""}` });
    return c.json({ approved: entry });
  });

  app.delete("/api/mcp-registry/approved/:name{.+}", async (c) => {
    const user = c.get("user");
    if (user.role !== "owner") throw new OrchestratorError("forbidden", "only an owner approves registry servers", 403);
    const name = decodeURIComponent(c.req.param("name"));
    const approved = await approvedServers(ctx);
    if (!approved.some((a) => a.name === name)) throw new OrchestratorError("not-found", `${name} is not approved`, 404);
    await ctx.store.setSetting(ctx.tenant, APPROVED_SETTING, JSON.stringify(approved.filter((a) => a.name !== name)));
    await recordEvent(ctx, user, "mcp.registry.unapproved", { subject: `mcp:${name}`, detail: `took back the approval of the registry server ${name}` });
    return c.json({ removed: name });
  });

  return app;
}
