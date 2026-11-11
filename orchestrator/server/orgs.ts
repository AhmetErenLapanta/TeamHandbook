import { createHash, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import type { Context } from "hono";
import { getCookie } from "hono/cookie";
import { oidcStateCookie } from "./accounts.js";
import type { OrchestratorContext } from "./app.js";
import { hashToken, hostGuard, sessionOf } from "./auth.js";
import { MCP_PATH } from "./integrations/orchestrator-mcp.js";
import { OAUTH_CALLBACK, PENDING_SIGN_INS } from "./integrations/personal-mcp.js";
import { FORGE_CALLBACK, PENDING_CONNECTS } from "./forge/oauth.js";
import { APP_HOOK, appDelivery } from "./forge/oauth-github.js";
import { oauthRoutes, oauthTenant } from "./integrations/oauth-server.js";
import type { OAuthShared } from "./integrations/oauth-server.js";
import { bearerOf, keyTenant } from "./keys.js";
import type { AuthMode } from "./auth.js";
import { OrchestratorError, errorAnswer } from "./errors.js";
import { orgName } from "./organization.js";
import { cloudMemberOf, identitySessionOf } from "./cloud-identity.js";
import type { Store } from "./store.js";
import { ingestTenant } from "./usage.js";
import { accessLog } from "./log.js";
import type { LogFormat } from "./log.js";
import { metrics, renderMetrics } from "./metrics.js";
import { ORCHESTRATOR_RELEASE } from "./setup.js";
import { SCHEMA_VERSION } from "./store.js";
import type { VaultSource } from "./vault.js";
import { heapSnapshot } from "./diagnostics.js";

const sameToken = (a: string, b: string) => timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());

/** One organization an orchestrator serves: its context, keyed to its tenant, and the app built on it. */
export interface ServedOrg {
  ctx: OrchestratorContext;
  app: { fetch: (request: Request, env?: unknown) => Response | Promise<Response> };
}

export interface OrgRoutesOptions {
  mode: AuthMode;
  secure: boolean;
  allowedHosts: string[] | null;
  /** How the orchestrator logs; in JSON every request is written with its id. Left out, text. */
  logFormat?: LogFormat;
  /** The token a metrics scraper sends; left out or null, the orchestrator serves no metrics. */
  metricsToken?: string | null;
  /** Where an operator's heap snapshot is written; left out, none is taken. */
  dataDir?: string;
  /** Routes of a local orchestrator itself, answered before any organization's. */
  local?: Hono;
  /** Where the key that seals sign-ins, tokens and secrets came from; "none" keeps none of them. */
  secrets?: VaultSource;
  /** On a cloud orchestrator: its organizations, found as they are asked for, and the sign-in every one of them shares. */
  cloud?: CloudOrgs;
}

/** A cloud orchestrator's organizations: served already, or read from the store and served when first asked for. */
export interface OrgRegistry {
  list(): ServedOrg[];
  get(tenant: string): Promise<ServedOrg | undefined>;
}

export interface CloudOrgs {
  registry: OrgRegistry;
  store: Store;
  secure: boolean;
  /** What every organization shares, for the MCP authorization server, which answers before any one of them; left out, it is not served. */
  shared?: OAuthShared;
  /** The organizations this browser's cloud identity belongs to. */
  memberships?: (c: Context) => Promise<string[]>;
  /** Provider sign-in, signup and the person's own pages, answered before any organization. */
  identity: Hono;
}

/** How long a tenant no node serves is answered 404 without asking the store again. */
const UNKNOWN_FOR_MS = 30_000;

/**
 * The registry a cloud orchestrator's nodes share through the store: an organization signup created on
 * another node is served here the first time it is asked for, and a tenant nobody created is
 * looked up at most once a while, so guessing slugs does not reach the database on every request.
 */
export function cloudRegistry(served: readonly ServedOrg[], store: Pick<Store, "getOrg">, serve: (tenant: string) => Promise<ServedOrg>, now: () => number = Date.now): OrgRegistry & { add(org: ServedOrg): void } {
  const byTenant = new Map(served.map((org) => [org.ctx.tenant, org]));
  const unknown = new Map<string, number>();
  const opening = new Map<string, Promise<ServedOrg | undefined>>();
  return {
    list: () => [...byTenant.values()],
    add: (org) => void byTenant.set(org.ctx.tenant, org),
    async get(tenant) {
      const known = byTenant.get(tenant);
      if (known) return known;
      if ((unknown.get(tenant) ?? 0) > now()) return undefined;
      // Two requests for an organization not served yet serve it once.
      const pending =
        opening.get(tenant) ??
        (async () => {
          const org = await store.getOrg(tenant);
          if (!org || org.deletedAt) {
            unknown.set(tenant, now() + UNKNOWN_FOR_MS);
            if (unknown.size > 10_000) unknown.delete(unknown.keys().next().value!);
            return undefined;
          }
          const fresh = byTenant.get(tenant) ?? (await serve(tenant));
          byTenant.set(tenant, fresh);
          return fresh;
        })().finally(() => opening.delete(tenant));
      opening.set(tenant, pending);
      return pending;
    },
  };
}

const UNKNOWN_ORG = new OrchestratorError("unknown-org", "this orchestrator does not serve that organization", 404);

/**
 * The organizations of one orchestrator behind one address. `/api/orgs/<tenant>/...` reaches that
 * org's app as `/api/...`, and the unprefixed `/api/...` reaches the first org, so a page or a
 * script written before organizations keeps working. Only the orgs given here are reached: a
 * tenant this orchestrator does not serve is refused, never opened, since a database shared with
 * another orchestrator holds tenants that are that orchestrator's to serve.
 *
 * Each org signs people in on its own, with a session cookie named for its tenant, so a browser
 * holds a session per org side by side. An account is an org's: the same address in two orgs is
 * two accounts, because an admin of one org adds whatever address they like, and an account
 * shared by address would let them into the other org as its owner.
 */
export function orgRoutes(orgs: readonly ServedOrg[], options: OrgRoutesOptions): Hono {
  const cloud = options.cloud;
  // A cloud orchestrator has no first organization: every request names its own, and one it does not serve is a 404.
  const first = cloud ? undefined : orgs[0];
  if (!cloud && !first) throw new Error("an orchestrator serves at least one organization");
  const byTenant = new Map(orgs.map((org) => [org.ctx.tenant, org]));
  const served = () => (cloud ? cloud.registry.list() : orgs);
  const lookup = async (tenant: string | null | undefined): Promise<ServedOrg | undefined> => (tenant ? (cloud ? cloud.registry.get(tenant) : byTenant.get(tenant)) : undefined);
  const store = cloud ? cloud.store : first!.ctx.store;
  const app = new Hono();
  app.use("*", accessLog(options.logFormat ?? "text", (method, status, seconds) => metrics.observe(method, status, seconds)));
  if (options.allowedHosts) app.use("*", hostGuard(options.allowedHosts));
  const operator = (c: Context) => Boolean(options.metricsToken) && sameToken(c.req.header("authorization")?.replace(/^Bearer /, "") ?? "", options.metricsToken!);

  // Readiness: each org's store answers. A repository that fails to sync does not make the orchestrator
  // unready, since everything already read is still served. Without the metrics token the answer
  // is ready or not and nothing else: which orgs an orchestrator serves, how many repositories each
  // holds and which release it runs are for its operator, as /api/orgs keeps the org list.
  app.get("/api/health/ready", async (c) => {
    const states = [];
    if (cloud) {
      try {
        await cloud.store.listOrgs();
      } catch {
        return c.json({ ready: false }, 503);
      }
    }
    for (const { ctx } of served()) {
      try {
        const repos = await ctx.store.listRepos(ctx.tenant);
        states.push({ org: ctx.tenant, ready: true, repos: repos.length, failing: repos.filter((r) => r.error).length });
      } catch {
        states.push({ org: ctx.tenant, ready: false });
      }
    }
    const ready = states.every((o) => o.ready);
    const status = ready ? 200 : 503;
    return operator(c) ? c.json({ ready, version: ORCHESTRATOR_RELEASE, schema: SCHEMA_VERSION, secrets: options.secrets ?? "none", orgs: states }, status) : c.json({ ready }, status);
  });

  // A heap snapshot for the operator, behind the metrics token: it is written into the data
  // directory for the operator to copy, and only its path is answered, since it holds tokens.
  app.post("/api/operator/heap-snapshot", (c) => {
    if (!options.metricsToken || !options.dataDir) return c.json({ error: "this orchestrator takes no heap snapshots; its operator sets ORCHESTRATOR_METRICS_TOKEN" }, 404);
    if (!operator(c)) return c.json({ error: "the metrics token does not hold" }, 401);
    return c.json({ path: heapSnapshot(options.dataDir) });
  });

  // Behind a token of its own: a scraper holds no session, and the counts say how the orchestrator is used.
  app.get("/metrics", async (c) => {
    if (!options.metricsToken) return c.json({ error: "this orchestrator serves no metrics; its operator sets ORCHESTRATOR_METRICS_TOKEN" }, 404);
    if (!operator(c)) return c.json({ error: "the metrics token does not hold" }, 401);
    return c.text(await renderMetrics(served().map((o) => o.ctx)), 200, { "content-type": "text/plain; version=0.0.4; charset=utf-8" });
  });

  /** The org a request belongs to, or, on a self-hosted orchestrator, the first one; on a cloud orchestrator none is a 404. */
  const toOrg = (org: ServedOrg | undefined, c: Context) => {
    const target = org ?? first;
    return target ? forward(target, c) : errorAnswer(c, UNKNOWN_ORG);
  };

  const forward = (org: ServedOrg, c: Context, path = c.req.path) => {
    if (path === c.req.path) return org.app.fetch(c.req.raw, c.env);
    const url = new URL(c.req.url);
    url.pathname = path;
    const raw = c.req.raw;
    const body = raw.method === "GET" || raw.method === "HEAD" ? null : raw.body;
    return org.app.fetch(new Request(url, { method: raw.method, headers: raw.headers, body, signal: raw.signal, ...(body ? { duplex: "half" } : {}) } as RequestInit), c.env);
  };

  // The orgs this browser is signed in to, for the org picker. Others are not named: the list
  // of organizations on an orchestrator is nobody's business before they sign in to one of them.
  app.get("/api/orgs", async (c) => {
    if (cloud) {
      // A cloud person's organizations are their memberships, whichever node serves them.
      const session = await identitySessionOf(c, cloud.store, cloud.secure);
      const orgsOf = [];
      for (const user of session ? await cloud.store.listMemberships(session.identityId) : []) {
        const org = await cloud.store.getOrg(user.tenant);
        if (!org || org.deletedAt || !(await cloudMemberOf(cloud.store, user.tenant, session!))) continue;
        orgsOf.push({ tenant: user.tenant, orgName: org.name, name: user.name, role: user.role });
      }
      return c.json({ default: null, orgs: orgsOf });
    }
    const signedIn = [];
    for (const { ctx } of orgs) {
      if (options.mode === "dev-admin") {
        signedIn.push({ tenant: ctx.tenant, orgName: await orgName(ctx.store, ctx.tenant), name: "Orchestrator Admin", role: "owner" });
        continue;
      }
      const session = await sessionOf(c, ctx.store, ctx.tenant, options.secure);
      if (session) signedIn.push({ tenant: ctx.tenant, orgName: await orgName(ctx.store, ctx.tenant), name: session.user.name, role: session.user.role });
    }
    return c.json({ default: first!.ctx.tenant, orgs: signedIn });
  });

  app.all("/api/orgs/:org/*", async (c) => {
    const tenant = c.req.param("org");
    const org = await lookup(tenant);
    if (!org) return errorAnswer(c, UNKNOWN_ORG);
    return forward(org, c, `/api${c.req.path.slice(`/api/orgs/${tenant}`.length)}`);
  });

  // The provider sends every org's sign-in back to the one address registered with it; the
  // state cookie the start set is named for the org the sign-in began in.
  app.get("/api/auth/oidc/callback", (c) => {
    const state = c.req.query("state");
    const org = state ? served().find(({ ctx }) => getCookie(c, oidcStateCookie(ctx.tenant, options.secure).name) === state) : undefined;
    return toOrg(org, c);
  });

  // A team file carries the address its usage is counted at, without an org in it; the id in
  // the address says whose it is.
  app.post("/ingest/usage/:ingest/*", async (c) => {
    const tenant = await ingestTenant(store, c.req.param("ingest"));
    return toOrg(await lookup(tenant), c);
  });

  // An invitation's link carries only its token, so a link sent before orgs, or by any org,
  // reaches the org that issued it. The join page sends the token in a JSON body, read here from
  // a copy so the org's app reads the body as it came.
  const joinOrg = async (c: Context) => {
    const body = (await c.req.raw.clone().json().catch(() => null)) as { token?: unknown } | null;
    const token = typeof body?.token === "string" && body.token ? body.token : null;
    const invite = token ? await store.getInviteByToken(hashToken(token)) : null;
    return toOrg(await lookup(invite?.tenant), c);
  };
  app.post("/api/join", joinOrg);
  app.post("/api/join/read", joinOrg);

  // A team's MCP entry names the orchestrator's one MCP address; the key it is called with says whose.
  app.all(MCP_PATH, async (c) => {
    const bearer = bearerOf(c);
    const tenant = bearer ? (oauthTenant(bearer) ?? (await keyTenant(store, bearer))) : null;
    return toOrg(await lookup(tenant), c);
  });

  // An MCP server's sign-in comes back to one address for every org, with the state it was sent.
  app.get(OAUTH_CALLBACK, async (c) => {
    const tenant = PENDING_SIGN_INS.tenantOf(c.req.query("state") ?? "");
    return toOrg(await lookup(tenant), c);
  });

  // So does a forge's sign-in, GitLab's or GitHub's.
  app.get(FORGE_CALLBACK, async (c) => {
    const tenant = PENDING_CONNECTS.tenantOf(c.req.query("state") ?? "");
    return toOrg(await lookup(tenant), c);
  });

  // The orchestrator's own authorization server for its MCP server, one for every org: a token names its
  // org, read as it is asked for, so a cloud orchestrator's organizations created since the start are reached too.
  const shared = first?.ctx ?? cloud?.shared;
  if (shared) app.route("/", oauthRoutes({ list: served, get: lookup, ...(cloud?.memberships ? { memberships: cloud.memberships } : {}) }, shared, options.mode, options.secure));

  if (cloud) {
    // Liveness, which on a self-hosted orchestrator the first organization answers.
    app.get("/api/health", (c) => c.json({ ok: true }));
    app.route("/", cloud.identity);
  }
  // The GitHub App's own deliveries come to one address for every org; each connected through the
  // installation hears of it. In the cloud that is every org the store holds, also those created
  // since this node started and not yet served here: the delivery only reads and marks a setting.
  app.post(APP_HOOK, async (c) => {
    const base = served()[0]!.ctx;
    const tenants = new Set(served().map((o) => o.ctx.tenant));
    if (cloud) for (const org of await base.store.listOrgs()) tenants.add(org.tenant);
    const contexts = [...tenants].map((tenant) => ({ store: base.store, tenant, forgeApps: base.forgeApps }));
    const changed = await appDelivery(contexts, c.req.header("x-hub-signature-256"), c.req.header("x-github-event"), await c.req.text());
    return changed === null ? c.json({ error: "the delivery's signature does not hold" }, 401) : c.json({ changed });
  });

  if (options.local) app.route("/", options.local);
  app.all("/api/*", (c) => toOrg(undefined, c));
  app.all("/ingest/*", (c) => toOrg(undefined, c));
  return app;
}
