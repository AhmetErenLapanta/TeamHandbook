import { Hono } from "hono";
import type { OrchestratorContext } from "../app.js";
import type { OrchestratorEnv, Principal } from "../auth.js";
import { ChangeRefused } from "../changes.js";
import { detectSecret } from "../plugin.js";
import { parseIssueLink } from "../tasks/issue.js";
import type { IssueLink } from "../tasks/issue.js";
import { maskSecrets, readSecret } from "../vault.js";
import { trackerReadsFor } from "../work/gate.js";
import { issueTool, offTracker, readIssue, TOKEN_READS } from "./issue-read.js";
import { McpCallFailed, readWithTools } from "./mcp-client.js";
import { credentialFor, orgSecretName, personalServers, readOrgConnection, readOrgServer, sealedAccess } from "./personal-mcp.js";
import { teamServers } from "./team-mcp.js";
import { issueAddress, readTracker, TRACKER_TOKEN_SECRET } from "./tracker.js";
import { githubOrigins } from "../work/own-github.js";
import { runOwnCli } from "../forge/own-cli.js";
import type { CliRun } from "../forge/own-cli.js";
import { ownCliHere } from "../forge/own-cli-here.js";

/** How a task this person starts reads the issue: the tracker's token, an MCP server with their sign-in or the organization's, or the link alone. */
export type IssueReach =
  | { via: "tracker" }
  /** One person's own machine: a GitHub issue of a repository their project names as origin, read with their own gh. */
  | { via: "gh" }
  | { via: "mcp"; server: string; tool: string; url: string; as: "you" | "organization"; credential: () => Promise<string | null | undefined> }
  | { via: "link"; unmapped?: boolean };

/**
 * The way the issue reaches a task, in the order the task itself uses: the tracker's own token
 * when the link is on the connected site, else a server of the person's own, else a team server
 * connected for everyone's tasks, that is allowed a tool reading this kind of issue.
 */
export async function issueReach(ctx: OrchestratorContext, user: Principal, issue: IssueLink): Promise<IssueReach> {
  const tracker = await readTracker(ctx);
  const tokenSet = Boolean(await ctx.store.secretSetAt(ctx.tenant, TRACKER_TOKEN_SECRET));
  const onTracker = tracker && tokenSet && TOKEN_READS.includes(tracker.kind) && offTracker(tracker, issue) === null;
  const unmapped = Boolean(onTracker) && !(await trackerReadsFor(ctx, user, issue));
  if (onTracker && !unmapped) return { via: "tracker" };
  if (issue.kind === "github" && (await ownCliHere(ctx)) && issue.key && new URL(issue.url).host === "github.com") {
    const repo = issue.key.slice(0, issue.key.lastIndexOf("#"));
    if ((await githubOrigins(ctx)).some((r) => r.name === repo)) return { via: "gh" };
  }
  for (const server of await personalServers(ctx, user.id)) {
    const tool = server.transport === "http" ? issueTool(issue.kind, server.tools.map((t) => ({ server: server.name, tool: t }))) : null;
    if (tool) return { via: "mcp", server: server.name, tool: tool.tool, url: server.url!, as: "you", credential: () => credentialFor(ctx, user.id, server) };
  }
  for (const team of await teamServers(ctx)) {
    const org = await readOrgServer(ctx, team.key);
    const tool = org && (await readOrgConnection(ctx, team.key)) ? issueTool(issue.kind, org.tools.map((t) => ({ server: team.name, tool: t }))) : null;
    if (tool) return { via: "mcp", server: team.name, tool: tool.tool, url: team.url, as: "organization", credential: () => sealedAccess(ctx, orgSecretName(team.key)) };
  }
  return { via: "link", unmapped };
}

export function reachText(reach: IssueReach, kind: string): string {
  if (reach.via === "tracker") return "The agent reads the issue's text and latest comments from the tracker before it starts.";
  if (reach.via === "gh") return "The agent reads the issue's text and latest comments with your gh before it starts.";
  if (reach.via === "mcp") return reach.as === "you" ? `The agent reads the issue through ${reach.server} as you.` : `The agent reads the issue through ${reach.server}, with the organization's sign-in.`;
  const which = kind === "jira" ? "Jira" : kind === "gitlab" ? "GitLab" : kind === "github" ? "GitHub" : kind === "linear" ? "Linear" : "this tracker's";
  if (reach.unmapped) return `The agent sees only the link: the issue's board is not mapped to a team of yours, so an owner or an admin maps it under Work, or connect an MCP server of your own that reads ${which} issues.`;
  return `The agent sees only the link; connect the issue tracker, or an MCP server that reads ${which} issues, in Integrations.`;
}

/** A text the form shows as written, unless it reads like a secret. */
export function shown(text: string, secrets: (string | null | undefined)[]): string {
  const flat = maskSecrets(text.replace(/\p{C}+/gu, " ").trim().slice(0, 200), secrets);
  return detectSecret(flat) ? "[withheld]" : flat;
}

/**
 * The issue's title and status through Atlassian's remote MCP server: the site's cloud id first,
 * by the issue's own address, then the issue. Other servers are not read for a preview.
 */
async function mcpPreview(reach: Extract<IssueReach, { via: "mcp" }>, issue: IssueLink, send: typeof fetch): Promise<{ title: string; status: string } | null> {
  if (reach.tool !== "getJiraIssue" || !issue.key) return null;
  const credential = await reach.credential();
  if (credential === null) return null;
  const headers: Record<string, string> = credential ? { authorization: `Bearer ${credential}` } : {};
  const origin = new URL(issue.url).origin;
  const [, answer] = await readWithTools(reach.url, headers, (previous) => {
    if (previous.length === 0) return { name: "getAccessibleAtlassianResources", arguments: {} };
    if (previous.length === 1) {
      const sites = JSON.parse(previous[0]!) as { id?: string; url?: string }[];
      const site = sites.find((s) => typeof s.url === "string" && new URL(s.url).origin === origin) ?? sites[0];
      return site?.id ? { name: "getJiraIssue", arguments: { cloudId: site.id, issueIdOrKey: issue.key, fields: ["summary", "status"] } } : null;
    }
    return null;
  }, send);
  if (!answer) return null;
  const fields = (JSON.parse(answer) as { fields?: { summary?: unknown; status?: { name?: unknown } } }).fields ?? {};
  return { title: shown(String(fields.summary ?? ""), [credential]), status: shown(String(fields.status?.name ?? ""), [credential]) };
}

/** The one-step sign-in that would let a task read this kind of issue, which the form offers when the agent would see the link alone. */
export interface IssueConnect {
  /** jira, linear or gitlab: signed in from Integrations with the Atlassian, catalogue or GitLab sign-in. */
  id: "jira" | "linear" | "gitlab";
  name: string;
}

const CONNECTS: Record<string, IssueConnect> = {
  jira: { id: "jira", name: "Atlassian" },
  linear: { id: "linear", name: "Linear" },
  gitlab: { id: "gitlab", name: "GitLab" },
};

export interface IssuePreview {
  url: string;
  key: string | null;
  title: string | null;
  status: string | null;
  reach: string;
  /** Set only when nothing reads the issue yet and its tracker has a one-step sign-in. */
  connect: IssueConnect | null;
}

/**
 * What the task form shows for an issue link: how the agent will read it, and its key, title and
 * status, read the way the task will. A read that fails or takes too long leaves the key alone;
 * the form never waits on it to start a task.
 */
export async function issuePreview(ctx: OrchestratorContext, user: Principal, given: string, send: typeof fetch = fetch, run: CliRun = runOwnCli): Promise<IssuePreview> {
  const tracker = await readTracker(ctx);
  const parsed = parseIssueLink(issueAddress(given, tracker), tracker);
  if ("error" in parsed) throw new ChangeRefused(parsed.error);
  const reach = await issueReach(ctx, user, parsed);
  const base: IssuePreview = { url: parsed.url, key: parsed.key, title: null, status: null, reach: reachText(reach, parsed.kind), connect: reach.via === "link" ? (CONNECTS[parsed.kind] ?? null) : null };
  try {
    if (reach.via === "gh") {
      const read = await readIssue(ctx, parsed, user, send, run);
      return read && "text" in read ? { ...base, title: shown(read.title, []), status: shown(read.status, []) } : base;
    }
    if (reach.via === "tracker") {
      const read = await readIssue(ctx, parsed, user, send);
      const token = await readSecret(ctx.store, ctx.vault ?? null, ctx.tenant, TRACKER_TOKEN_SECRET).catch(() => null);
      return read && "text" in read ? { ...base, title: shown(read.title, [token]), status: shown(read.status, [token]) } : base;
    }
    if (reach.via === "mcp") {
      const read = await mcpPreview(reach, parsed, send);
      return read ? { ...base, ...read } : base;
    }
  } catch (err) {
    if (!(err instanceof McpCallFailed) && !(err instanceof SyntaxError)) console.error(`issue preview: ${(err as Error).message}`);
  }
  return base;
}

export function issuePreviewRoutes(ctx: OrchestratorContext): Hono<OrchestratorEnv> {
  const app = new Hono<OrchestratorEnv>();
  app.get("/api/issues/preview", async (c) => {
    const url = c.req.query("url") ?? "";
    if (!url.trim()) return c.json({ error: "give the issue's link or key" }, 400);
    try {
      return c.json(await issuePreview(ctx, c.get("user"), url));
    } catch (err) {
      if (err instanceof ChangeRefused) return c.json({ error: err.message }, 400);
      throw err;
    }
  });
  return app;
}
