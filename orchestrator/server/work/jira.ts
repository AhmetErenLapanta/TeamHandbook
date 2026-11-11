import type { WorkCategory, WorkColumn } from "../../shared/work.js";
import type { TrackerConfig } from "../integrations/tracker.js";
import { BOARD_JQL, MAX_BOARDS, MAX_ITEMS, PAGE, SourceFailed, trackerJson } from "./provider.js";
import type { BoardRead, IssueRef, ItemRead, ItemScope, Memo, Provider, SprintRead } from "./provider.js";

type Json = Record<string, unknown>;

export interface JiraIssue {
  key?: string;
  fields?: {
    summary?: string;
    status?: { name?: string; statusCategory?: { key?: string } };
    assignee?: { displayName?: string; emailAddress?: string } | null;
    priority?: { name?: string } | null;
    labels?: string[];
    issuetype?: { name?: string };
    parent?: { key?: string; fields?: { summary?: string; issuetype?: { name?: string; hierarchyLevel?: number } } };
    issuelinks?: { type?: { inward?: string }; inwardIssue?: { fields?: { status?: { statusCategory?: { key?: string } } } } }[];
    [field: string]: unknown;
  };
}

const CATEGORY: Record<string, WorkCategory> = { new: "todo", indeterminate: "doing", done: "done" };

export function jiraCategory(key: string | undefined): WorkCategory {
  return CATEGORY[key ?? ""] ?? "todo";
}

/**
 * Jira through its Agile API with the organization's token: boards, their active and future
 * sprints, the backlog, and the board's own columns, so a board on the orchestrator has the team's
 * workflow. Story points come from the field the board estimates with; an issue is blocked when
 * it is flagged, or an unresolved issue blocks it.
 */
export function jiraProvider(config: TrackerConfig, token: string, memo: Memo, send: typeof fetch = fetch): Provider {
  if (!config.email) throw new SourceFailed("the Jira connection names no account email; add it under Integrations");
  const auth = { authorization: `Basic ${Buffer.from(`${config.email}:${token}`).toString("base64")}` };
  const get = (path: string) => trackerJson(`${config.url}${path}`, auth, send) as Promise<Json>;

  const configuration = (board: string) =>
    memo(`board:${board}:configuration`, async () => {
      const read = (await get(`/rest/agile/1.0/board/${encodeURIComponent(board)}/configuration`)) as { columnConfig?: { columns?: { name?: string; statuses?: { id?: string }[] }[] }; estimation?: { field?: { fieldId?: string } } };
      return { columns: read.columnConfig?.columns ?? [], points: read.estimation?.field?.fieldId ?? null };
    });
  const statusNames = () =>
    memo("statuses", async () => {
      const read = (await trackerJson(`${config.url}/rest/api/3/status`, auth, send)) as { id?: string; name?: string }[];
      return Object.fromEntries(read.filter((s) => s.id && s.name).map((s) => [s.id!, s.name!]));
    });
  // The Flagged field is a custom field whose id differs on every site; it is found by its name.
  const flaggedField = () =>
    memo("flagged-field", async () => {
      const read = (await trackerJson(`${config.url}/rest/api/3/field`, auth, send)) as { id?: string; name?: string }[];
      return read.find((f) => f.name === "Flagged")?.id ?? null;
    });

  return {
    boardPattern: /^\d{1,12}$/,
    sprintPattern: /^\d{1,12}$/,

    async writable(): Promise<string | null> {
      const read = (await memo("permission:transition", () => trackerJson(`${config.url}/rest/api/3/mypermissions?permissions=TRANSITION_ISSUES`, auth, send))) as { permissions?: { TRANSITION_ISSUES?: { havePermission?: boolean } } };
      return read.permissions?.TRANSITION_ISSUES?.havePermission ? null : "The organization's Jira token has no permission to move issues";
    },

    async transitions(issue: IssueRef) {
      const key = encodeURIComponent(issue.key);
      const [read, offered] = await Promise.all([
        get(`/rest/api/3/issue/${key}?fields=status`) as Promise<JiraIssue>,
        get(`/rest/api/3/issue/${key}/transitions`) as Promise<{ transitions?: { id?: string; to?: { name?: string; statusCategory?: { key?: string } } }[] }>,
      ]);
      return { status: read.fields?.status?.name ?? "", transitions: (offered.transitions ?? []).filter((t) => t.id && t.to?.name).map((t) => ({ id: t.id!, to: t.to!.name!, category: jiraCategory(t.to!.statusCategory?.key) })) };
    },

    async transition(issue: IssueRef, id: string) {
      await trackerJson(`${config.url}/rest/api/3/issue/${encodeURIComponent(issue.key)}/transitions`, auth, send, { transition: { id } });
    },

    async boards(): Promise<BoardRead[]> {
      const boards: BoardRead[] = [];
      for (let startAt = 0; boards.length < MAX_BOARDS; startAt += PAGE) {
        const page = (await get(`/rest/agile/1.0/board?startAt=${startAt}&maxResults=${PAGE}`)) as { values?: { id?: number; name?: string; type?: string; location?: { projectKey?: string } }[]; isLast?: boolean };
        for (const b of page.values ?? []) {
          if (typeof b.id !== "number") continue;
          boards.push({ native: String(b.id), name: b.name ?? String(b.id), type: b.type === "kanban" ? "kanban" : "scrum", project: b.location?.projectKey ?? null, url: `${config.url}/secure/RapidBoard.jspa?rapidView=${b.id}` });
        }
        if (page.isLast !== false || !page.values?.length) break;
      }
      return boards.slice(0, MAX_BOARDS);
    },

    async sprints(board: string): Promise<SprintRead[]> {
      let page: { values?: { id?: number; name?: string; state?: string; startDate?: string; endDate?: string; goal?: string }[] };
      try {
        page = (await get(`/rest/agile/1.0/board/${encodeURIComponent(board)}/sprint?state=active,future&maxResults=${PAGE}`)) as typeof page;
      } catch (err) {
        // A Kanban board has no sprints, and Jira answers 400 when it is asked for them.
        if (err instanceof SourceFailed && err.status === 400) return [];
        throw err;
      }
      return (page.values ?? [])
        .filter((s) => typeof s.id === "number")
        .map((s) => ({ native: String(s.id), name: s.name ?? String(s.id), state: s.state === "active" ? "active" : s.state === "closed" ? "closed" : "future", startsAt: s.startDate ?? null, endsAt: s.endDate ?? null, goal: s.goal || null }));
    },

    async columns(board: string): Promise<WorkColumn[]> {
      const [{ columns }, names] = await Promise.all([configuration(board), statusNames()]);
      return columns.map((c) => ({ name: c.name ?? "", statuses: (c.statuses ?? []).map((s) => names[s.id ?? ""]).filter((n): n is string => Boolean(n)) })).filter((c) => c.name);
    },

    async items(board: string, scope: ItemScope): Promise<{ items: ItemRead[]; truncated: boolean }> {
      const [{ points }, flagged] = await Promise.all([configuration(board), flaggedField()]);
      const fields = ["summary", "status", "assignee", "priority", "labels", "issuetype", "parent", "issuelinks", ...(flagged ? [flagged] : []), ...(points ? [points] : [])].join(",");
      const base = `/rest/agile/1.0/board/${encodeURIComponent(board)}`;
      // A board's epics are not its cards, as on Jira's own boards; a Kanban board's done work is the last two weeks'.
      const [path, jql] = "sprint" in scope ? [`${base}/sprint/${encodeURIComponent(scope.sprint)}/issue`, "issuetype != Epic"] : "board" in scope ? [`${base}/issue`, BOARD_JQL] : [`${base}/backlog`, "issuetype != Epic"];
      const issues: JiraIssue[] = [];
      let total = 0;
      for (let startAt = 0; issues.length < MAX_ITEMS; startAt += PAGE) {
        const page = (await get(`${path}?startAt=${startAt}&maxResults=${PAGE}&fields=${fields}&jql=${encodeURIComponent(jql)}`)) as { issues?: JiraIssue[]; total?: number };
        issues.push(...(page.issues ?? []));
        total = page.total ?? issues.length;
        if (!page.issues?.length || issues.length >= total) break;
      }
      return { items: issues.slice(0, MAX_ITEMS).filter((i) => i.key).map((i) => jiraItem(config.url, i, flagged, points)), truncated: total > MAX_ITEMS };
    },
  };
}

export function jiraItem(site: string, issue: JiraIssue, flagged: string | null, points: string | null): ItemRead {
  const f = issue.fields ?? {};
  const parent = f.parent;
  const isEpic = parent && (parent.fields?.issuetype?.name === "Epic" || parent.fields?.issuetype?.hierarchyLevel === 1);
  const blockedBy = (f.issuelinks ?? []).some((l) => /blocked by/i.test(l.type?.inward ?? "") && l.inwardIssue && l.inwardIssue.fields?.status?.statusCategory?.key !== "done");
  const estimate = points ? f[points] : null;
  return {
    key: issue.key!,
    url: `${site}/browse/${issue.key}`,
    summary: f.summary ?? "",
    type: f.issuetype?.name ?? null,
    status: { name: f.status?.name ?? "", category: jiraCategory(f.status?.statusCategory?.key) },
    assignee: f.assignee?.displayName ? { name: f.assignee.displayName, email: f.assignee.emailAddress ?? null } : null,
    priority: f.priority?.name ?? null,
    epic: isEpic ? { key: parent!.key ?? null, summary: parent!.fields?.summary ?? "" } : null,
    labels: Array.isArray(f.labels) ? f.labels.filter((l) => typeof l === "string") : [],
    storyPoints: typeof estimate === "number" ? estimate : null,
    blocked: Boolean(flagged && Array.isArray(f[flagged]) && (f[flagged] as unknown[]).length) || blockedBy,
  };
}
