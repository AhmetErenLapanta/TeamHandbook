import type { WorkColumn } from "../../shared/work.js";
import { McpCallFailed, readWithTools } from "../integrations/mcp-client.js";
import { jiraCategory, jiraItem } from "./jira.js";
import type { JiraIssue } from "./jira.js";
import { BOARD_JQL, MAX_BOARDS, MAX_ITEMS, PAGE, SourceFailed } from "./provider.js";
import type { BoardRead, IssueRef, ItemRead, ItemScope, Memo, Provider, SprintRead } from "./provider.js";

/** The Sprint field Jira Cloud creates on every site; the MCP server offers no way to look it up by name. */
const SPRINT_FIELD = "customfield_10020";
const MAX_SITES = 5;
const ISSUE_FIELDS = ["summary", "status", "assignee", "priority", "labels", "issuetype", "parent", "issuelinks"];
const CATEGORY_ORDER = { new: 0, indeterminate: 1, done: 2 } as Record<string, number>;

export const READ_TOOLS = ["getAccessibleAtlassianResources", "getVisibleJiraProjects", "searchJiraIssuesUsingJql"];
export const WRITE_TOOLS = ["getTransitionsForJiraIssue", "transitionJiraIssue"];

export const missing = (server: string, tools: readonly string[]) => `Your ${server} server does not allow ${tools.join(" or ")}`;

/** A board on this source is a project of one site: `<cloud id>.<project key>`. */
const BOARD = /^([0-9a-f-]{36})\.([A-Z][A-Z0-9_]{0,19})$/;

interface Site {
  id: string;
  url: string;
}

/**
 * Jira read through the person's own Atlassian MCP server, as the person: that server has no
 * Agile API, so a board is a project, a sprint is found on the project's issues, and a column is
 * a status the project's open work is in, ordered to do, in progress, done. Only a project key
 * and a sprint id go into a JQL query, each held to its own shape and quoted.
 */
export function mcpJiraProvider(server: { name: string; url: string; tools: readonly string[] }, credential: string | undefined, memo: Memo, send: typeof fetch = fetch): Provider {
  const headers: Record<string, string> = credential ? { authorization: `Bearer ${credential}` } : {};
  const url = server.url;
  const tool = async (name: string, args: Record<string, unknown>): Promise<unknown> => {
    // The orchestrator calls only the tools the person allowed on their server, as a task of theirs would.
    if (!server.tools.includes(name)) throw new SourceFailed(missing(server.name, [name]));
    let answer: string | undefined;
    try {
      [answer] = await readWithTools(url, headers, (previous) => (previous.length ? null : { name, arguments: args }), send);
    } catch (err) {
      if (err instanceof McpCallFailed) throw new SourceFailed(err.message);
      throw err;
    }
    try {
      return JSON.parse(answer ?? "");
    } catch {
      throw new SourceFailed(`the server's answer to ${name} is not JSON`);
    }
  };
  const sites = () =>
    memo("sites", async () => {
      const read = (await tool("getAccessibleAtlassianResources", {})) as { id?: string; url?: string }[];
      return (Array.isArray(read) ? read : []).filter((s): s is Site => typeof s.id === "string" && typeof s.url === "string").slice(0, MAX_SITES);
    });
  const siteOf = async (board: string) => {
    const [, cloudId, key] = BOARD.exec(board)!;
    const site = (await sites()).find((s) => s.id === cloudId);
    if (!site) throw new SourceFailed("the server no longer reaches that Jira site");
    return { site, key: key! };
  };
  // An issue is moved on the site its own address names, among the sites the person's server reaches.
  const siteFor = async (issue: IssueRef) => {
    const site = (await sites()).find((s) => new URL(s.url).origin === new URL(issue.url).origin);
    if (!site) throw new SourceFailed("the server does not reach the issue's Jira site");
    return site;
  };
  const search = async (site: Site, jql: string, fields: string[], max: number): Promise<{ issues: JiraIssue[]; truncated: boolean }> => {
    const issues: JiraIssue[] = [];
    let next: string | undefined;
    for (;;) {
      const page = (await tool("searchJiraIssuesUsingJql", { cloudId: site.id, jql, fields, maxResults: PAGE, ...(next ? { nextPageToken: next } : {}) })) as { issues?: JiraIssue[]; nextPageToken?: string; isLast?: boolean };
      issues.push(...(page.issues ?? []));
      next = page.nextPageToken;
      if (!next || page.isLast || !page.issues?.length) return { issues: issues.slice(0, max), truncated: false };
      if (issues.length >= max) return { issues: issues.slice(0, max), truncated: true };
    }
  };
  const open = (key: string) => `project = "${key}" AND (sprint in openSprints() OR sprint in futureSprints())`;

  return {
    boardPattern: BOARD,

    async writable(): Promise<string | null> {
      const absent = WRITE_TOOLS.filter((t) => !server.tools.includes(t));
      return absent.length ? missing(server.name, absent) : null;
    },
    sprintPattern: /^\d{1,12}$/,

    async transitions(issue: IssueRef) {
      const site = await siteFor(issue);
      const [{ issues }, offered] = await Promise.all([
        search(site, `key = "${issue.key}"`, ["status"], 1),
        tool("getTransitionsForJiraIssue", { cloudId: site.id, issueIdOrKey: issue.key }) as Promise<{ transitions?: { id?: string; to?: { name?: string; statusCategory?: { key?: string } } }[] }>,
      ]);
      return { status: issues[0]?.fields?.status?.name ?? "", transitions: (offered.transitions ?? []).filter((t) => t.id && t.to?.name).map((t) => ({ id: t.id!, to: t.to!.name!, category: jiraCategory(t.to!.statusCategory?.key) })) };
    },

    async transition(issue: IssueRef, id: string) {
      const site = await siteFor(issue);
      await tool("transitionJiraIssue", { cloudId: site.id, issueIdOrKey: issue.key, transition: { id } });
    },

    async boards(): Promise<BoardRead[]> {
      const boards: BoardRead[] = [];
      for (const site of await sites()) {
        const read = (await tool("getVisibleJiraProjects", { cloudId: site.id, maxResults: PAGE })) as { values?: { key?: string; name?: string }[] };
        for (const p of read.values ?? []) {
          if (!p.key || !/^[A-Z][A-Z0-9_]{0,19}$/.test(p.key)) continue;
          boards.push({ native: `${site.id}.${p.key}`, name: p.name ?? p.key, type: "project", project: p.key, url: `${site.url}/browse/${p.key}` });
        }
      }
      return boards.slice(0, MAX_BOARDS);
    },

    async sprints(board: string): Promise<SprintRead[]> {
      const { site, key } = await siteOf(board);
      const { issues } = await search(site, open(key), [SPRINT_FIELD], MAX_ITEMS);
      const sprints = new Map<string, SprintRead>();
      for (const issue of issues) {
        for (const s of (issue.fields?.[SPRINT_FIELD] ?? []) as { id?: number; name?: string; state?: string; startDate?: string; endDate?: string; goal?: string }[]) {
          if (typeof s.id !== "number" || (s.state !== "active" && s.state !== "future")) continue;
          sprints.set(String(s.id), { native: String(s.id), name: s.name ?? String(s.id), state: s.state, startsAt: s.startDate ?? null, endsAt: s.endDate ?? null, goal: s.goal || null });
        }
      }
      return [...sprints.values()].sort((a, b) => (a.state === b.state ? Number(a.native) - Number(b.native) : a.state === "active" ? -1 : 1));
    },

    async columns(board: string): Promise<WorkColumn[]> {
      const { site, key } = await siteOf(board);
      // Every status the project's work was in over three months, done ones too, so a column with
      // nothing in it today still shows; the person's server reads no board configuration.
      const { issues } = await search(site, `project = "${key}" AND issuetype != Epic AND updated >= -90d`, ["status"], MAX_ITEMS);
      const seen = new Map<string, number>();
      for (const issue of issues) {
        const status = issue.fields?.status;
        if (status?.name && !seen.has(status.name)) seen.set(status.name, CATEGORY_ORDER[status.statusCategory?.key ?? ""] ?? 0);
      }
      return [...seen.entries()].sort((a, b) => a[1] - b[1]).map(([name]) => ({ name, statuses: [name] }));
    },

    async items(board: string, scope: ItemScope): Promise<{ items: ItemRead[]; truncated: boolean }> {
      const { site, key } = await siteOf(board);
      // A board's epics are not its cards, as on Jira's own boards; a project with no sprints is read as a Kanban board.
      const where =
        "sprint" in scope ? `project = "${key}" AND issuetype != Epic AND sprint = ${Number(scope.sprint)}`
        : "board" in scope ? `project = "${key}" AND ${BOARD_JQL}`
        : `project = "${key}" AND issuetype != Epic AND sprint is EMPTY AND statusCategory != Done`;
      const [{ issues, truncated }, mine] = await Promise.all([
        search(site, `${where} ORDER BY rank`, ISSUE_FIELDS, MAX_ITEMS),
        // Read as the person, Jira itself says which issues are theirs; their email is often hidden from the read.
        search(site, `${where} AND assignee = currentUser()`, ["summary"], MAX_ITEMS),
      ]);
      const theirs = new Set(mine.issues.map((i) => i.key));
      return {
        items: issues.filter((i) => i.key).map((i) => {
          const item = jiraItem(site.url, i, null, null);
          return item.assignee ? { ...item, assignee: { ...item.assignee, you: theirs.has(i.key) } } : item;
        }),
        truncated,
      };
    },
  };
}
