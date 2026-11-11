import type { WorkCategory, WorkColumn } from "../../shared/work.js";
import { MAX_BOARDS, MAX_ITEMS, SourceFailed, trackerJson } from "./provider.js";
import type { BoardRead, ItemRead, ItemScope, Memo, Provider, SprintRead } from "./provider.js";

const MOVES_LATER = "The orchestrator does not move Linear issues yet";
const PAGE = 100;
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Linear answers its API at api.linear.app whatever the workspace; a stand-in on this machine answers at its own address. */
export function linearEndpoint(workspace: string): string {
  const url = new URL(workspace);
  return url.hostname === "linear.app" ? "https://api.linear.app/graphql" : `${url.origin}/graphql`;
}

/** Linear's workflow state types in the order its boards draw them. */
const TYPE_ORDER = ["triage", "backlog", "unstarted", "started", "completed", "canceled"];
const CATEGORY: Record<string, WorkCategory> = { triage: "todo", backlog: "todo", unstarted: "todo", started: "doing", completed: "done", canceled: "done" };

interface LinearIssue {
  identifier?: string;
  title?: string;
  url?: string;
  priorityLabel?: string | null;
  priority?: number | null;
  estimate?: number | null;
  assignee?: { name?: string; email?: string } | null;
  labels?: { nodes?: { name?: string }[] };
  state?: { name?: string; type?: string } | null;
  parent?: { identifier?: string; title?: string } | null;
}

const ISSUE = "identifier title url priority priorityLabel estimate assignee { name email } labels { nodes { name } } state { name type } parent { identifier title }";
const PAGE_INFO = "pageInfo { hasNextPage endCursor }";
/** What Linear's own boards hold of done work: what is still open, and what was done in the last two weeks. */
const ON_BOARD = '{ or: [{ state: { type: { nin: ["completed", "canceled"] } } }, { completedAt: { gt: "-P2W" } }] }';

/**
 * Linear read with a person's API key over its GraphQL API, queries alone, never a mutation: a
 * team is a board, its active and upcoming cycles are sprints, and the columns are the team's
 * workflow states in Linear's own order. A team with cycles off is drawn as Kanban, every issue on
 * it with the done ones from the last two weeks. Issues are read, never moved.
 */
export function linearProvider(endpoint: string, apiKey: string, memo: Memo, send: typeof fetch = fetch): Provider {
  const query = async <T>(text: string, variables: Record<string, unknown> = {}): Promise<T> => {
    const body = (await trackerJson(endpoint, { authorization: apiKey }, send, { query: text, variables })) as { data?: T; errors?: { message?: string }[] } | null;
    if (body?.errors?.length) throw new SourceFailed(`Linear refused the read: ${body.errors[0]?.message ?? "no reason given"}`);
    if (!body?.data) throw new SourceFailed("Linear's answer is not GraphQL data");
    return body.data;
  };
  // A team's or a cycle's issues, a page at a time; each query declares only the variables it uses, as GraphQL requires.
  const issues = async (root: "team" | "cycle", id: string, filter: string): Promise<{ items: ItemRead[]; truncated: boolean }> => {
    const read: LinearIssue[] = [];
    let after: string | null = null;
    for (;;) {
      const data: { node?: { issues?: { nodes?: LinearIssue[]; pageInfo?: { hasNextPage?: boolean; endCursor?: string } } } } = await query(
        `query ($id: String!, $after: String) { node: ${root}(id: $id) { issues(first: ${PAGE}, after: $after, filter: ${filter}) { nodes { ${ISSUE} } ${PAGE_INFO} } } }`,
        { id, after },
      );
      const page = data.node?.issues;
      read.push(...(page?.nodes ?? []));
      if (read.length >= MAX_ITEMS) return { items: read.slice(0, MAX_ITEMS).map(item).filter((i): i is ItemRead => i !== null), truncated: true };
      if (!page?.pageInfo?.hasNextPage || !page.pageInfo.endCursor) return { items: read.map(item).filter((i): i is ItemRead => i !== null), truncated: false };
      after = page.pageInfo.endCursor;
    }
  };

  return {
    boardPattern: ID,
    sprintPattern: ID,

    async writable() {
      return MOVES_LATER;
    },
    async transitions() {
      throw new SourceFailed(MOVES_LATER);
    },
    async transition() {
      throw new SourceFailed(MOVES_LATER);
    },

    async boards(): Promise<BoardRead[]> {
      const data = await query<{ teams?: { nodes?: { id?: string; key?: string; name?: string; cyclesEnabled?: boolean }[] }; organization?: { urlKey?: string } }>(`query { organization { urlKey } teams(first: ${MAX_BOARDS}) { nodes { id key name cyclesEnabled } } }`);
      const site = `https://linear.app/${data.organization?.urlKey ?? ""}`;
      return (data.teams?.nodes ?? [])
        .filter((t) => t.id && ID.test(t.id) && t.key && t.name)
        .map((t) => ({ native: t.id!, name: t.name!, type: t.cyclesEnabled ? "scrum" : "kanban", project: t.key!, url: `${site}/team/${t.key}` }));
    },

    async sprints(board: string): Promise<SprintRead[]> {
      const data = await query<{ team?: { cycles?: { nodes?: { id?: string; number?: number; name?: string | null; startsAt?: string; endsAt?: string; isActive?: boolean; isFuture?: boolean; description?: string | null }[] } } }>(
        `query ($team: String!) { team(id: $team) { cycles(first: 10, filter: { or: [{ isActive: { eq: true } }, { isFuture: { eq: true } }] }) { nodes { id number name startsAt endsAt isActive isFuture description } } } }`,
        { team: board },
      );
      return (data.team?.cycles?.nodes ?? [])
        .filter((c) => c.id && ID.test(c.id))
        .map((c) => ({ native: c.id!, name: c.name || `Cycle ${c.number ?? ""}`.trim(), state: (c.isActive ? "active" : "future") as SprintRead["state"], startsAt: c.startsAt ?? null, endsAt: c.endsAt ?? null, goal: c.description || null }))
        .sort((a, b) => (a.state === b.state ? (a.startsAt ?? "").localeCompare(b.startsAt ?? "") : a.state === "active" ? -1 : 1));
    },

    async columns(board: string): Promise<WorkColumn[]> {
      return memo(`board:${board}:states`, async () => {
        const data = await query<{ team?: { states?: { nodes?: { name?: string; type?: string; position?: number }[] } } }>(`query ($team: String!) { team(id: $team) { states { nodes { name type position } } } }`, { team: board });
        return (data.team?.states?.nodes ?? [])
          .filter((s): s is { name: string; type: string; position?: number } => Boolean(s.name && s.type))
          .sort((a, b) => TYPE_ORDER.indexOf(a.type) - TYPE_ORDER.indexOf(b.type) || (a.position ?? 0) - (b.position ?? 0))
          .map((s) => ({ name: s.name, statuses: [s.name] }));
      });
    },

    async items(board: string, scope: ItemScope): Promise<{ items: ItemRead[]; truncated: boolean }> {
      if ("sprint" in scope) return issues("cycle", scope.sprint, "{}");
      if ("board" in scope) return issues("team", board, ON_BOARD);
      return issues("team", board, '{ cycle: { null: true }, state: { type: { nin: ["completed", "canceled"] } } }');
    },
  };
}

function item(issue: LinearIssue): ItemRead | null {
  if (!issue.identifier || !issue.url) return null;
  const labels = (issue.labels?.nodes ?? []).map((l) => l.name ?? "").filter(Boolean);
  const type = issue.state?.type ?? "";
  return {
    key: issue.identifier,
    url: issue.url,
    summary: issue.title ?? "",
    type: null,
    status: { name: issue.state?.name ?? "", category: CATEGORY[type] ?? "todo" },
    assignee: issue.assignee?.name ? { name: issue.assignee.name, email: issue.assignee.email ?? null } : null,
    priority: issue.priority ? (issue.priorityLabel ?? null) : null,
    epic: issue.parent?.title ? { key: issue.parent.identifier ?? null, summary: issue.parent.title } : null,
    labels,
    storyPoints: typeof issue.estimate === "number" ? issue.estimate : null,
    blocked: labels.some((l) => l.toLowerCase() === "blocked"),
  };
}
