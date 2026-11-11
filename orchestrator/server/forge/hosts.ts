import { Hono } from "hono";
import { FORGES } from "../../shared/forge-def.js";
import type { HostedForge } from "../../shared/forge-def.js";
import type { OrchestratorContext } from "../app.js";
import { manages } from "../auth.js";
import type { OrchestratorEnv } from "../auth.js";
import { APP_FORGES, forgeConnectionView, readOrgGitLabApp } from "./oauth.js";
import type { ForgeConnection } from "./oauth.js";
import { route } from "../route-scopes.js";

/**
 * Each forge host the org reaches, in one record: GitLab.com, a self-managed GitLab or GitHub,
 * with how it is reached - the org's one-click connection, tokens pasted for single repositories,
 * or both - the repositories on it, and where a person makes a token for it and what the token
 * has to allow. Read from what the org already keeps (its connections, its own GitLab
 * application, each repository's forge settings), so it can never say something those do not.
 */
export interface ForgeHost {
  kind: HostedForge;
  webUrl: string;
  apiUrl: string;
  connection: ForgeConnection | null;
  /** Set when the org entered its own GitLab application for this host. */
  ownApplication: boolean;
  repos: { id: string; via: "connection" | "token" }[];
  credentials: { tokenPage: string; scopes: readonly string[] };
}

/** The forge's web address for an API root: GitHub's API host stands for github.com, every other API sits on its web host. */
function webUrlOf(kind: HostedForge, apiUrl: string): string {
  const api = new URL(apiUrl);
  return kind === "github" && api.hostname === "api.github.com" ? `https://${FORGES.github.homeHosts[0]}` : api.origin;
}

export async function orgForgeHosts(ctx: OrchestratorContext): Promise<ForgeHost[]> {
  const hosts = new Map<string, ForgeHost>();
  const hostFor = (kind: HostedForge, apiUrl: string): ForgeHost => {
    const key = `${kind} ${new URL(apiUrl).origin}`;
    let host = hosts.get(key);
    if (!host) {
      const webUrl = webUrlOf(kind, apiUrl);
      host = { kind, webUrl, apiUrl, connection: null, ownApplication: false, repos: [], credentials: { tokenPage: FORGES[kind].credentials.tokenPage(webUrl), scopes: FORGES[kind].credentials.scopes } };
      hosts.set(key, host);
    }
    return host;
  };

  // Read from the records alone: listing hosts makes no call to any of them.
  for (const kind of APP_FORGES) {
    const own = kind === "gitlab" ? await readOrgGitLabApp(ctx) : null;
    const apiUrl = own ? `${own.webUrl}/api/v4` : ctx.forgeApps?.[kind]?.apiUrl;
    const connection = await forgeConnectionView(ctx, kind);
    if (!apiUrl || (!connection && !own)) continue;
    const host = hostFor(kind, apiUrl);
    host.connection = connection;
    host.ownApplication = Boolean(own);
  }
  for (const repo of await ctx.store.listRepos(ctx.tenant)) {
    const config = await ctx.store.getForgeConfig(ctx.tenant, repo.id);
    if (!config) continue;
    hostFor(config.kind, config.apiUrl).repos.push({ id: repo.id, via: ctx.addedRepos?.get(repo.id)?.connection ? "connection" : "token" });
  }
  return [...hosts.values()];
}

/** The org's forge hosts for its owners and admins, who read forge addresses and who set them up, as the forge settings show them. */
export function forgeHostRoutes(ctx: OrchestratorContext): Hono<OrchestratorEnv> {
  const app = new Hono<OrchestratorEnv>();
  route(app, "GET /api/forge/hosts", async (c) => {
    if (!manages(c.get("user"))) return c.json({ error: "only an owner or an admin reads the organization's forge hosts" }, 403);
    return c.json({ hosts: await orgForgeHosts(ctx) });
  });
  return app;
}
