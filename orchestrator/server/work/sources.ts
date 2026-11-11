import type { OrchestratorContext } from "../app.js";
import type { Principal } from "../auth.js";
import type { WorkKind, WorkSource } from "../../shared/work.js";
import { issueTool } from "../integrations/issue-read.js";
import { credentialFor, personalServers } from "../integrations/personal-mcp.js";
import type { PersonalServer } from "../integrations/personal-mcp.js";
import { readTracker, TRACKER_TOKEN_SECRET } from "../integrations/tracker.js";
import type { TrackerConfig } from "../integrations/tracker.js";
import { readConnection, readOrgGitLabApp } from "../forge/oauth.js";
import type { AppForge, ConnectionRecord } from "../forge/oauth.js";
import { readSecret } from "../vault.js";
import { OWN_GITHUB } from "./ids.js";
import { githubOrigins } from "./own-github.js";
import { ownCliHere } from "../forge/own-cli-here.js";

/** A tracker this person reads work from, with what it takes to ask it; the screen gets `sourceView` of it. */
export type Source =
  | { id: "tracker"; kind: WorkKind; config: TrackerConfig; token: () => Promise<string | null>; tokenSetAt: string }
  | { id: "forge:gitlab" | "forge:github"; kind: AppForge; connection: ConnectionRecord; webUrl: string }
  | { id: string; kind: "jira"; server: PersonalServer & { url: string }; credential: () => Promise<string | null | undefined> }
  | { id: typeof OWN_GITHUB; kind: "github"; host: "github.com"; repos: { name: string; url: string }[] };

const KIND_NAME: Record<WorkKind, string> = { jira: "Jira", gitlab: "GitLab", github: "GitHub", linear: "Linear" };

/**
 * The organization's tracker when its token is stored, its GitLab and GitHub connections, then each of the person's own MCP servers
 * allowed a tool that reads Jira issues. An organization's MCP connection is for its tasks and
 * is not a source here: it reads as the organization, past what the person themselves sees.
 */
export async function workSources(ctx: Pick<OrchestratorContext, "store" | "tenant" | "vault" | "forgeApps"> & Partial<Pick<OrchestratorContext, "ownForgeCli" | "dataDir">>, user: Principal): Promise<Source[]> {
  const sources: Source[] = [];
  const tracker = await readTracker(ctx);
  const tokenSet = tracker ? await ctx.store.secretSetAt(ctx.tenant, TRACKER_TOKEN_SECRET) : null;
  if (tracker && tokenSet) {
    sources.push({ id: "tracker", kind: tracker.kind, config: tracker, token: () => readSecret(ctx.store, ctx.vault ?? null, ctx.tenant, TRACKER_TOKEN_SECRET), tokenSetAt: tokenSet.updatedAt });
  }
  for (const kind of ["gitlab", "github"] as const) {
    // An organization's own GitLab application counts as the operator's does; where it is reached is judged when it is read.
    const webUrl = (kind === "gitlab" ? (await readOrgGitLabApp(ctx))?.webUrl : undefined) ?? ctx.forgeApps?.[kind]?.webUrl;
    const connection = webUrl ? await readConnection(ctx, kind) : null;
    if (webUrl && connection) sources.push({ id: kind === "gitlab" ? "forge:gitlab" : "forge:github", kind, connection, webUrl });
  }
  for (const server of await personalServers(ctx, user.id)) {
    if (server.transport !== "http" || !server.url || !issueTool("jira", server.tools.map((tool) => ({ server: server.name, tool })))) continue;
    const reached = { ...server, url: server.url };
    sources.push({ id: `mcp:${server.name}`, kind: "jira", server: reached, credential: () => credentialFor(ctx, user.id, reached) });
  }
  const repos = ctx.dataDir && (await ownCliHere(ctx)) ? await githubOrigins(ctx as typeof ctx & { dataDir: string }) : [];
  if (repos.length) sources.push({ id: OWN_GITHUB, kind: "github", host: "github.com", repos });
  return sources;
}

/** A source as the screen shows it, with why it does not move issues and why it does not read, when either holds. */
export function sourceView(source: Source, writeProblem: string | null, problem: string | null): WorkSource {
  if (source.id === "tracker" && "config" in source) {
    const host = new URL(source.config.url).host;
    return {
      id: source.id,
      kind: source.kind,
      name: `${KIND_NAME[source.kind]} (${host})`,
      url: source.config.url,
      via: "token",
      as: "organization",
      can: { boards: true, sprints: true, backlog: true, storyPoints: source.kind !== "github", write: writeProblem === null },
      writeProblem,
      problem,
    };
  }
  if ("connection" in source) {
    return {
      id: source.id,
      kind: source.kind,
      name: `${KIND_NAME[source.kind]} (${source.connection.account})`,
      url: source.webUrl,
      via: "app",
      as: "organization",
      can: { boards: true, sprints: true, backlog: true, storyPoints: source.kind === "gitlab", write: writeProblem === null },
      writeProblem,
      problem,
    };
  }
  if ("repos" in source) {
    return {
      id: source.id,
      kind: "github",
      name: "GitHub (your gh)",
      url: `https://${source.host}`,
      via: "cli",
      as: "you",
      can: { boards: true, sprints: true, backlog: true, storyPoints: false, write: false },
      writeProblem,
      problem,
    };
  }
  const { server } = source as Extract<Source, { server: PersonalServer }>;
  return {
    id: source.id,
    kind: "jira",
    name: server.name,
    url: server.url,
    via: "mcp",
    as: "you",
    can: { boards: true, sprints: true, backlog: true, storyPoints: false, write: writeProblem === null },
    writeProblem,
    problem,
  };
}
