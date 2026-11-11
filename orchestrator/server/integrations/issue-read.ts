import type { OrchestratorContext } from "../app.js";
import type { Principal } from "../auth.js";
import { trackerReadsFor } from "../work/gate.js";
import { Redactor } from "../tasks/redact.js";
import type { McpTool } from "../tasks/agents.js";
import type { IssueLink } from "../tasks/issue.js";
import { maskSecrets, readSecret } from "../vault.js";
import { ownCliReader, runOwnCli } from "../forge/own-cli.js";
import type { CliRun } from "../forge/own-cli.js";
import { githubOrigins } from "../work/own-github.js";
import { linearEndpoint } from "../work/linear.js";
import { READ_TIMEOUT_MS } from "../work/provider.js";
import { readEnabled } from "./records.js";
import { TRACKER, TRACKER_TOKEN_SECRET } from "./tracker.js";
import type { TrackerConfig } from "./tracker.js";
import { ownCliHere } from "../forge/own-cli-here.js";
import { readWithTools } from "./mcp-client.js";
import { credentialFor, personalServers } from "./personal-mcp.js";

export const COMMENTS_READ = 5;
const MAX_ISSUE_CHARS = 30_000;
const MAX_PART_CHARS = 15_000;
const MAX_COMMENT_CHARS = 2_000;
const MAX_SUBTASKS = 50;

/** An issue as the orchestrator read it, for the agent's prompt, and a line for the task's log. */
export interface IssueRead {
  text: string;
  summary: string;
  /** The issue's title and status, redacted as the text is, for the task form's preview. */
  title: string;
  status: string;
}

type Json = Record<string, unknown>;

function cut(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n[cut at ${max} characters]` : text;
}

/** Jira's document format (ADF) as plain text: paragraphs and list items on their own lines, nothing rendered. */
export function adfText(node: unknown): string {
  if (typeof node === "string") return node;
  if (!node || typeof node !== "object") return "";
  const n = node as { type?: string; text?: string; content?: unknown[]; attrs?: { text?: string } };
  const inner = (n.content ?? []).map(adfText).join("");
  switch (n.type) {
    case "text":
      return n.text ?? "";
    case "hardBreak":
      return "\n";
    case "mention":
    case "emoji":
      return n.attrs?.text ?? "";
    case "listItem":
      return `- ${inner.trim()}\n`;
    case "paragraph":
    case "heading":
    case "codeBlock":
    case "blockquote":
    case "rule":
      return `${inner}\n`;
    default:
      return inner;
  }
}

class ReadFailed extends Error {}

// A body makes it a POST, as a GraphQL query is sent; nothing else is.
async function getJson(url: string, headers: Record<string, string>, send: typeof fetch, body?: unknown): Promise<Json> {
  let res: Response;
  try {
    const post = body === undefined ? {} : { method: "POST", body: JSON.stringify(body) };
    res = await send(url, { ...post, headers: { accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers }, redirect: "error", signal: AbortSignal.timeout(READ_TIMEOUT_MS) });
  } catch (err) {
    throw new ReadFailed((err as Error).name === "TimeoutError" ? `the tracker did not answer within ${READ_TIMEOUT_MS / 1000} seconds` : `the tracker was not reached (${(err as Error).message})`);
  }
  if (res.status === 401 || res.status === 403) throw new ReadFailed(`the tracker refused the token (${res.status})`);
  if (res.status === 404) throw new ReadFailed("the tracker has no such issue, or the token cannot see it");
  if (!res.ok) throw new ReadFailed(`the tracker answered ${res.status}`);
  try {
    return (await res.json()) as Json;
  } catch {
    throw new ReadFailed("the tracker's answer is not JSON");
  }
}

type JiraComment = { author?: { displayName?: string }; created?: string; body?: unknown };

async function readJira(tracker: TrackerConfig, key: string, token: string, send: typeof fetch): Promise<{ lines: string[]; summary: string; title: string; status: string }> {
  const auth = { authorization: `Basic ${Buffer.from(`${tracker.email}:${token}`).toString("base64")}` };
  const issue = await getJson(`${tracker.url}/rest/api/3/issue/${encodeURIComponent(key)}?expand=names`, auth, send);
  const comments = await getJson(`${tracker.url}/rest/api/3/issue/${encodeURIComponent(key)}/comment?orderBy=-created&maxResults=${COMMENTS_READ}`, auth, send);
  return jiraLines(key, (issue.fields ?? {}) as Json, (issue.names ?? {}) as Record<string, string>, ((comments.comments ?? []) as JiraComment[]).slice(0, COMMENTS_READ));
}

/** A Jira issue's fields as the agent reads them, whether the REST API or Atlassian's MCP server gave them; `listed` newest first. */
function jiraLines(key: string, fields: Json, names: Record<string, string>, listed: JiraComment[]): { lines: string[]; summary: string; title: string; status: string } {
  const name = (field: unknown) => ((field as { name?: string } | null)?.name ?? "");
  // Teams keep acceptance criteria in a field of their own, whose id differs on every site; it is found by its name.
  const criteria = Object.entries(names)
    .filter(([id, label]) => /acceptance/i.test(label) && fields[id] !== null && fields[id] !== undefined)
    .map(([id]) => adfText(fields[id]).trim())
    .filter(Boolean);
  const subtasks = ((fields.subtasks ?? []) as { key?: string; fields?: Json }[]).slice(0, MAX_SUBTASKS);
  const lines = [
    `${key}: ${String(fields.summary ?? "")}`,
    `Status: ${name(fields.status)}${name(fields.issuetype) ? ` · Type: ${name(fields.issuetype)}` : ""}`,
    "",
    "Description:",
    cut(adfText(fields.description).trim() || "(none)", MAX_PART_CHARS),
  ];
  if (criteria.length) lines.push("", "Acceptance criteria:", cut(criteria.join("\n"), MAX_PART_CHARS));
  if (subtasks.length) lines.push("", "Sub-tasks:", ...subtasks.map((s) => `- ${s.key ?? ""} ${String(s.fields?.summary ?? "")} (${name(s.fields?.status)})`));
  if (listed.length) {
    lines.push("", "Latest comments, newest first:");
    for (const c of listed) lines.push(`- ${c.author?.displayName ?? "someone"}, ${String(c.created ?? "").slice(0, 10)}:`, cut(adfText(c.body).trim(), MAX_COMMENT_CHARS));
  }
  return { lines, summary: `${criteria.length ? "acceptance criteria, " : ""}${subtasks.length} sub-task(s), ${listed.length} comment(s)`, title: String(fields.summary ?? ""), status: name(fields.status) };
}

async function readGitLab(tracker: TrackerConfig, key: string, token: string, send: typeof fetch): Promise<{ lines: string[]; summary: string; title: string; status: string }> {
  const match = /^(.+)#(\d+)$/.exec(key);
  if (!match) throw new ReadFailed("the issue's key is not group/project#number");
  const base = `${tracker.url}/api/v4/projects/${encodeURIComponent(match[1]!)}/issues/${match[2]}`;
  const auth = { "private-token": token };
  const issue = await getJson(base, auth, send);
  const notes = (await getJson(`${base}/notes?sort=desc&order_by=created_at&per_page=20`, auth, send)) as unknown as { system?: boolean; author?: { name?: string }; created_at?: string; body?: string }[];
  const listed = (Array.isArray(notes) ? notes : []).filter((n) => !n.system).slice(0, COMMENTS_READ);
  const labels = Array.isArray(issue.labels) ? (issue.labels as string[]) : [];
  const lines = [
    `${key}: ${String(issue.title ?? "")}`,
    `State: ${String(issue.state ?? "")}${labels.length ? ` · Labels: ${labels.join(", ")}` : ""}`,
    "",
    "Description:",
    cut(String(issue.description ?? "").trim() || "(none)", MAX_PART_CHARS),
  ];
  if (listed.length) {
    lines.push("", "Latest comments, newest first:");
    for (const n of listed) lines.push(`- ${n.author?.name ?? "someone"}, ${String(n.created_at ?? "").slice(0, 10)}:`, cut(String(n.body ?? "").trim(), MAX_COMMENT_CHARS));
  }
  return { lines, summary: `${listed.length} comment(s)`, title: String(issue.title ?? ""), status: String(issue.state ?? "") };
}

const LINEAR_ISSUE = "query ($id: String!) { issue(id: $id) { identifier title description priority priorityLabel state { name } labels { nodes { name } } children(first: 50) { nodes { identifier title state { name } } } comments(first: 50) { nodes { body createdAt user { name } } } } }";

interface LinearIssue {
  title?: string;
  description?: string | null;
  priority?: number | null;
  priorityLabel?: string | null;
  state?: { name?: string } | null;
  labels?: { nodes?: { name?: string }[] };
  children?: { nodes?: { identifier?: string; title?: string; state?: { name?: string } | null }[] };
  comments?: { nodes?: { body?: string; createdAt?: string; user?: { name?: string } | null }[] };
}

/** A Linear issue by its identifier, one GraphQL query with the workspace's API key, never a mutation. */
async function readLinear(tracker: TrackerConfig, key: string, token: string, send: typeof fetch): Promise<{ lines: string[]; summary: string; title: string; status: string }> {
  const answer = await getJson(linearEndpoint(tracker.url), { authorization: token }, send, { query: LINEAR_ISSUE, variables: { id: key } });
  const errors = answer.errors as { message?: string }[] | undefined;
  if (errors?.length) throw new ReadFailed(`Linear refused the read: ${errors[0]?.message ?? "no reason given"}`);
  const issue = (answer.data as { issue?: LinearIssue | null } | undefined)?.issue;
  if (!issue) throw new ReadFailed("the tracker has no such issue, or the token cannot see it");
  const labels = (issue.labels?.nodes ?? []).map((l) => l.name ?? "").filter(Boolean);
  const children = (issue.children?.nodes ?? []).slice(0, MAX_SUBTASKS);
  // Linear's own order of a connection is not by date, so the latest are picked here, newest first as the other trackers give them.
  const listed = [...(issue.comments?.nodes ?? [])].sort((a, b) => String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? ""))).slice(0, COMMENTS_READ);
  const status = issue.state?.name ?? "";
  const lines = [
    `${key}: ${String(issue.title ?? "")}`,
    `State: ${status}${issue.priority ? ` · Priority: ${issue.priorityLabel ?? ""}` : ""}${labels.length ? ` · Labels: ${labels.join(", ")}` : ""}`,
    "",
    "Description:",
    cut(String(issue.description ?? "").trim() || "(none)", MAX_PART_CHARS),
  ];
  if (children.length) lines.push("", "Sub-issues:", ...children.map((c) => `- ${c.identifier ?? ""} ${String(c.title ?? "")} (${c.state?.name ?? ""})`));
  if (listed.length) {
    lines.push("", "Latest comments, newest first:");
    for (const c of listed) lines.push(`- ${c.user?.name ?? "someone"}, ${String(c.createdAt ?? "").slice(0, 10)}:`, cut(String(c.body ?? "").trim(), MAX_COMMENT_CHARS));
  }
  return { lines, summary: `${children.length} sub-issue(s), ${listed.length} comment(s)`, title: String(issue.title ?? ""), status };
}

/**
 * On one person's own machine, a GitHub issue of a repository one of their projects names as
 * origin, read with their own gh as Work reads its board: the orchestrator holds no token. An
 * issue of any other repository gets its link alone.
 */
async function readOwnGitHub(ctx: Pick<OrchestratorContext, "store" | "tenant" | "dataDir">, issue: IssueLink, run: CliRun): Promise<IssueRead | { problem: string } | null> {
  const match = issue.key ? /^(.+)#(\d+)$/.exec(issue.key) : null;
  if (!match || new URL(issue.url).host !== "github.com" || !(await githubOrigins(ctx)).some((r) => r.name === match[1])) return null;
  const gh = ownCliReader("github", "github.com", run);
  const path = `repos/${match[1]}/issues/${match[2]}`;
  try {
    const found = await gh.request<{ title?: string; state?: string; body?: string | null; labels?: (string | { name?: string })[] }>("GET", path);
    const comments = await gh.request<{ user?: { login?: string }; created_at?: string; body?: string }[]>("GET", `${path}/comments?per_page=100`);
    // GitHub lists comments oldest first; the latest are kept, newest first as the other trackers give them.
    const listed = (Array.isArray(comments) ? comments : []).slice(-COMMENTS_READ).reverse();
    const labels = (found.labels ?? []).map((l) => (typeof l === "string" ? l : (l.name ?? ""))).filter(Boolean);
    const lines = [
      `${issue.key}: ${String(found.title ?? "")}`,
      `State: ${String(found.state ?? "")}${labels.length ? ` · Labels: ${labels.join(", ")}` : ""}`,
      "",
      "Description:",
      cut(String(found.body ?? "").trim() || "(none)", MAX_PART_CHARS),
    ];
    if (listed.length) {
      lines.push("", "Latest comments, newest first:");
      for (const c of listed) lines.push(`- ${c.user?.login ?? "someone"}, ${String(c.created_at ?? "").slice(0, 10)}:`, cut(String(c.body ?? "").trim(), MAX_COMMENT_CHARS));
    }
    const redactor = new Redactor();
    const text = cut(lines.join("\n").split("\n").map((l) => redactor.line(l)).join("\n"), MAX_ISSUE_CHARS);
    return { text, summary: `${listed.length} comment(s)`, title: redactor.line(String(found.title ?? "")), status: redactor.line(String(found.state ?? "")) };
  } catch (err) {
    return { problem: (err as Error).message };
  }
}

/** The tools an MCP server reads one issue with, by tracker: Atlassian's, GitLab's and GitHub's own servers and the common community ones. */
export const ISSUE_READ_TOOLS: Record<"jira" | "gitlab" | "github", string[]> = {
  jira: ["getJiraIssue", "jira_get_issue"],
  gitlab: ["get_issue", "gitlab_get_issue"],
  github: ["get_issue", "issue_read"],
};

/** The tool, of those a task is allowed, that reads an issue of this kind; null when none does. */
export function issueTool(kind: string, tools: readonly McpTool[]): McpTool | null {
  const names = ISSUE_READ_TOOLS[kind as keyof typeof ISSUE_READ_TOOLS] ?? [];
  return tools.find((t) => names.includes(t.tool)) ?? null;
}

/** The trackers whose sealed token reads an issue's text for a task. */
export const TOKEN_READS: readonly TrackerConfig["kind"][] = ["jira", "gitlab", "linear"];

/** Why the connected tracker's token does not read this issue, or null when it does. */
export function offTracker(tracker: TrackerConfig, issue: IssueLink): string | null {
  if (issue.kind !== tracker.kind || new URL(issue.url).origin !== new URL(tracker.url).origin) return `the issue is not on the connected tracker (${new URL(tracker.url).host})`;
  // Every Linear workspace shares linear.app, and an identifier such as ENG-12 names an issue in each of them.
  if (issue.kind === "linear" && !new URL(issue.url).pathname.startsWith(`${new URL(tracker.url).pathname.replace(/\/$/, "")}/`)) {
    return `the issue is not in the connected Linear workspace (${new URL(tracker.url).pathname.slice(1)})`;
  }
  return null;
}

/**
 * Reads the issue a task works on from the connected tracker, with the token sealed for it,
 * so the agent gets its text without a tracker MCP server of its own. Read only, and only from
 * the tracker's own address, or for Linear its API at api.linear.app and only for an issue of
 * the connected workspace: an issue link anywhere else gets its link alone, and the token goes
 * nowhere else. The text is redacted line by line, as a task log is, before it reaches a
 * prompt. Null when the tracker is not connected for reading; a reason when the read failed,
 * which the task logs and runs on with the link.
 */
export async function readIssue(ctx: Pick<OrchestratorContext, "store" | "tenant" | "vault"> & Partial<Pick<OrchestratorContext, "ownForgeCli" | "dataDir">>, issue: IssueLink, forUser: Principal, send: typeof fetch = fetch, run: CliRun = runOwnCli): Promise<IssueRead | { problem: string } | null> {
  if (issue.kind === "github" && ctx.dataDir && (await ownCliHere(ctx))) return readOwnGitHub({ ...ctx, dataDir: ctx.dataDir }, issue, run);
  const read = await readWithToken(ctx, issue, forUser, send);
  if (read && "text" in read) return read;
  // Jira's one-step sign-in leaves no tracker token: the person's own Atlassian server reads the issue as them.
  if (issue.kind === "jira") return (await readJiraAsPerson(ctx, issue, forUser, send)) ?? read;
  return read;
}

/**
 * A Jira issue read through the person's own Atlassian MCP server, as themselves, as Work reads
 * their boards: the Jira site whose address is the issue's own, then the issue with its
 * description, sub-tasks and latest comments. Only that site: an issue on a site their sign-in
 * does not reach is not read from another one. Null when no server of theirs reads Jira issues;
 * a reason when the read failed, and the task runs on with the link.
 */
async function readJiraAsPerson(ctx: Pick<OrchestratorContext, "store" | "tenant" | "vault">, issue: IssueLink, forUser: Principal, send: typeof fetch): Promise<IssueRead | { problem: string } | null> {
  const server = (await personalServers(ctx, forUser.id)).find((s) => s.transport === "http" && s.url && s.tools.includes("getJiraIssue"));
  const key = issue.key;
  if (!server || !key) return null;
  const credential = await credentialFor(ctx, forUser.id, server, send).catch(() => null);
  if (credential === null) return { problem: `${server.name} is not signed in` };
  const origin = new URL(issue.url).origin;
  try {
    const [, answer] = await readWithTools(server.url!, credential ? { authorization: `Bearer ${credential}` } : {}, (previous) => {
      if (previous.length === 0) return { name: "getAccessibleAtlassianResources", arguments: {} };
      if (previous.length === 1) {
        const sites = JSON.parse(previous[0]!) as { id?: string; url?: string }[];
        const site = sites.find((s) => typeof s.url === "string" && new URL(s.url).origin === origin);
        return site?.id ? { name: "getJiraIssue", arguments: { cloudId: site.id, issueIdOrKey: key, fields: ["summary", "status", "issuetype", "description", "subtasks", "comment"] } } : null;
      }
      return null;
    }, send);
    if (!answer) return { problem: `${server.name} reaches no Jira site at ${new URL(issue.url).host}` };
    const fields = ((JSON.parse(answer) as { fields?: Json }).fields ?? {}) as Json;
    // Jira gives an issue's comments oldest first; the latest are kept, newest first as the REST read gives them.
    const listed = (((fields.comment as { comments?: JiraComment[] } | undefined)?.comments ?? []) as JiraComment[]).slice(-COMMENTS_READ).reverse();
    const read = jiraLines(key, fields, {}, listed);
    const redactor = new Redactor(credential ? [credential] : []);
    const text = cut(read.lines.join("\n").split("\n").map((l) => redactor.line(l)).join("\n"), MAX_ISSUE_CHARS);
    return { text, summary: read.summary, title: redactor.line(read.title), status: redactor.line(read.status) };
  } catch (err) {
    // A remote server's answer, however it fails, leaves the task its link; the reason is logged without the credential.
    return { problem: maskSecrets(`${server.name} did not read it: ${(err as Error).message}`, credential ? [credential] : []) };
  }
}

/** The issue read with the connected tracker's sealed token, behind its gates. */
async function readWithToken(ctx: Pick<OrchestratorContext, "store" | "tenant" | "vault">, issue: IssueLink, forUser: Principal, send: typeof fetch): Promise<IssueRead | { problem: string } | null> {
  const tracker = (await readEnabled<TrackerConfig>(ctx, TRACKER))?.config;
  if (!tracker || !issue.key || !TOKEN_READS.includes(tracker.kind)) return null;
  let token: string | null;
  try {
    token = await readSecret(ctx.store, ctx.vault ?? null, ctx.tenant, TRACKER_TOKEN_SECRET);
  } catch (err) {
    return { problem: (err as Error).message };
  }
  if (!token) return null;
  const off = offTracker(tracker, issue);
  if (off) return { problem: off };
  if (!(await trackerReadsFor(ctx, forUser, issue))) return { problem: "the issue's project is not on a board shown to this person" };
  try {
    const read = tracker.kind === "jira" ? await readJira(tracker, issue.key, token, send) : tracker.kind === "linear" ? await readLinear(tracker, issue.key, token, send) : await readGitLab(tracker, issue.key, token, send);
    const redactor = new Redactor([token]);
    const text = cut(read.lines.join("\n").split("\n").map((l) => redactor.line(l)).join("\n"), MAX_ISSUE_CHARS);
    return { text, summary: read.summary, title: redactor.line(read.title), status: redactor.line(read.status) };
  } catch (err) {
    if (err instanceof ReadFailed) return { problem: maskSecrets(err.message, [token]) };
    throw err;
  }
}
