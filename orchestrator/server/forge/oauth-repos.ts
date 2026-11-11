import { FORGES } from "../../shared/forge-def.js";
import { forgeHttp } from "./http.js";
import { LISTED_MAX } from "./admin.js";
import { DRIVERS } from "./registry.js";
import type { ForgeHttp } from "./http.js";
import { connectionToken } from "./oauth-access.js";
import { forgeApp } from "./oauth.js";
import type { AppForge, ForgeAppContext } from "./oauth.js";
import { shownText, shownUrl } from "./types.js";


export interface ListedRepo {
  /** group/name on GitLab, owner/name on GitHub. */
  fullName: string;
  /** The https clone address, which carries no credential. */
  url: string;
  /** The orchestrator's id for it when it is connected already, in this org. */
  connected: string | null;
  /** As the forge reports it; creating the team's scaffold reads it again rather than trusting this. */
  empty: boolean;
}

type ConnectionContext = ForgeAppContext;

/** The org's connection as an API client, with the token it has right now. */
export async function connectionHttp(ctx: ConnectionContext, kind: AppForge, permissions?: Record<string, "read" | "write">): Promise<{ http: ForgeHttp; token: string }> {
  const token = await connectionToken(ctx, kind, permissions);
  const app = (await forgeApp(ctx, kind))!;
  // A connection's token is OAuth on GitLab and an installation's on GitHub: each driver sends it as its forge takes one.
  return { http: forgeHttp(FORGES[kind].label, app.apiUrl, token, DRIVERS[kind].authHeaders(token, true), (app.kind === "gitlab" && app.send) || fetch), token };
}

/** A clone address as two addresses for the same repository compare: no `.git`, no trailing slash, the host in lower case. */
export function sameRepoAddress(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host.toLowerCase()}${u.pathname.replace(/\/+$/, "").replace(/\.git$/, "")}`;
  } catch {
    return url;
  }
}

/**
 * The repositories the connection reaches and can write to: on GitLab the projects the person
 * who connected is at least a developer of, on GitHub the ones the app was installed on.
 */
export async function listConnectionRepos(ctx: ConnectionContext, kind: AppForge): Promise<ListedRepo[]> {
  // Listing reads the installation's repositories and their size alone, so on GitHub its token holds metadata and nothing to write with.
  const { http } = await connectionHttp(ctx, kind, { metadata: "read" });
  const raw = await DRIVERS[kind].admin.list(http);
  const connected = new Map((await ctx.store.listRepos(ctx.tenant)).map((r) => [sameRepoAddress(r.url), r.id]));
  const out: ListedRepo[] = [];
  for (const r of raw.slice(0, LISTED_MAX)) {
    const fullName = shownText(r.fullName);
    const url = shownUrl(r.url);
    if (!fullName.includes("/") || !url) continue;
    out.push({ fullName, url, connected: connected.get(sameRepoAddress(url)) ?? null, empty: r.empty });
  }
  return out;
}
