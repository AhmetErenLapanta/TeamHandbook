import type { WorkColumn } from "../../shared/work.js";
import { ForgeHttpError } from "../forge/http.js";
import type { ForgeHttp } from "../forge/http.js";
import { MAX_BOARDS, MAX_ITEMS, PAGE, SourceFailed, trackerJson } from "./provider.js";
import type { ApiAccess, BoardRead, ItemRead, ItemScope, Memo, Provider, SprintRead } from "./provider.js";

interface GitHubIssue {
  number?: number;
  title?: string;
  state?: string;
  labels?: (string | { name?: string })[];
  assignee?: { login?: string } | null;
  html_url?: string;
  pull_request?: unknown;
  type?: { name?: string } | null;
}

const OPEN = "Open";
const CLOSED = "Closed";
const MOVES_LATER = "The orchestrator does not move GitHub issues yet";

/**
 * GitHub issues through the organization's GitHub connection, whose token reads issues and
 * metadata only: a repository the app is installed on is a board, an open milestone is a sprint,
 * and an issue is Open or Closed. Pull requests, which GitHub lists with issues, are left out.
 */
/** GitHub's GraphQL API, read only; on one person's own machine it goes through their gh. */
export type GraphQL = <T>(query: string, variables: Record<string, string | number | boolean>) => Promise<T>;

/** A GitHub Project a repository's issues sit on, by its Status field: its options in order, and each issue's place. */
interface ProjectStatus {
  options: string[];
  of: Map<number, string>;
}

const PROJECTS = `query ($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    projectsV2(first: 20) { nodes { id closed field(name: "Status") { ... on ProjectV2SingleSelectField { options { name } } } } }
  }
}`;

const PROJECT_ITEMS = `query ($id: ID!) {
  node(id: $id) {
    ... on ProjectV2 {
      items(first: 100) { nodes { content { ... on Issue { number repository { nameWithOwner } } } fieldValueByName(name: "Status") { ... on ProjectV2ItemFieldSingleSelectValue { name } } } }
    }
  }
}`;

export function githubProvider(api: ApiAccess, send: typeof fetch = fetch, listed?: readonly { name: string; url: string }[], projects?: { graphql: GraphQL; memo: Memo }): Provider {
  const get = (path: string) => trackerJson(`${api.baseUrl}${path}`, api.headers, send);
  const repo = (board: string) => {
    const [owner, name] = board.split("/");
    return `/repos/${encodeURIComponent(owner!)}/${encodeURIComponent(name!)}`;
  };
  // The repository's first open GitHub Project with a Status field, read once a minute; null
  // when it is on none, GraphQL is not read here or gh cannot read projects (a sign-in without
  // the project scope), and the board is then Open and Closed.
  const status = (board: string): Promise<ProjectStatus | null> =>
    projects
      ? projects.memo(`board:${board}:project`, async () => {
          const [owner, name] = board.split("/");
          const found = await projects.graphql<{ repository?: { projectsV2?: { nodes?: { id?: string; closed?: boolean; field?: { options?: { name?: string }[] } | null }[] } } }>(PROJECTS, { owner: owner!, name: name! });
          const project = found.repository?.projectsV2?.nodes?.find((p) => p.id && !p.closed && p.field?.options?.length);
          if (!project) return null;
          const items = await projects.graphql<{ node?: { items?: { nodes?: { content?: { number?: number; repository?: { nameWithOwner?: string } } | null; fieldValueByName?: { name?: string } | null }[] } } }>(PROJECT_ITEMS, { id: project.id! });
          const of = new Map<number, string>();
          for (const i of items.node?.items?.nodes ?? []) if (i.content?.repository?.nameWithOwner === board && typeof i.content.number === "number" && i.fieldValueByName?.name) of.set(i.content.number, i.fieldValueByName.name);
          return { options: project.field!.options!.map((o) => o.name ?? "").filter(Boolean), of };
        }).catch(() => null)
      : Promise.resolve(null);

  return {
    boardPattern: /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/,
    sprintPattern: /^\d{1,9}$/,

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
      if (listed) return listed.slice(0, MAX_BOARDS).map((r) => ({ native: r.name, name: r.name, type: "repository", project: r.name, url: r.url }));
      const boards: BoardRead[] = [];
      for (let page = 1; boards.length < MAX_BOARDS; page++) {
        const read = (await get(`/installation/repositories?per_page=${PAGE}&page=${page}`)) as { repositories?: { full_name?: string; html_url?: string; has_issues?: boolean }[] };
        const repos = read.repositories ?? [];
        for (const r of repos) if (r.full_name && r.html_url && r.has_issues !== false) boards.push({ native: r.full_name, name: r.full_name, type: "repository", project: r.full_name, url: r.html_url });
        if (repos.length < PAGE) break;
      }
      return boards.slice(0, MAX_BOARDS);
    },

    async sprints(board: string): Promise<SprintRead[]> {
      const read = (await get(`${repo(board)}/milestones?state=open&per_page=${PAGE}`)) as { number?: number; title?: string; due_on?: string | null; description?: string | null }[];
      return read.filter((m) => typeof m.number === "number").map((m) => ({ native: String(m.number), name: m.title ?? String(m.number), state: "active", startsAt: null, endsAt: m.due_on ?? null, goal: m.description || null }));
    },

    async columns(board: string): Promise<WorkColumn[]> {
      const project = await status(board);
      if (project) return project.options.map((o) => ({ name: o, statuses: [o] }));
      return [{ name: OPEN, statuses: [OPEN] }, { name: CLOSED, statuses: [CLOSED] }];
    },

    async items(board: string, scope: ItemScope): Promise<{ items: ItemRead[]; truncated: boolean }> {
      const filter = "sprint" in scope ? `milestone=${Number(scope.sprint)}&state=all` : "milestone=none&state=open";
      const issues: GitHubIssue[] = [];
      const project = await status(board);
      // On a GitHub Project, an issue's status is its Status there: the first option to do, the last done, the rest in progress.
      const placed = (item: ItemRead | null, number: number | undefined): ItemRead | null => {
        const on = project && number !== undefined ? project.of.get(number) : undefined;
        if (!item || !on) return item;
        const at = project!.options.indexOf(on);
        return { ...item, status: { name: on, category: item.status.category === "done" || at === project!.options.length - 1 ? "done" : at === 0 ? "todo" : "doing" } };
      };
      const read = (list: GitHubIssue[]) => list.map((i) => placed(githubItem(board, i), i.number)).filter((i): i is ItemRead => i !== null);
      for (let page = 1; issues.length < MAX_ITEMS; page++) {
        const got = (await get(`${repo(board)}/issues?${filter}&per_page=${PAGE}&page=${page}`)) as GitHubIssue[];
        issues.push(...got.filter((i) => !i.pull_request));
        if (got.length < PAGE) return { items: read(issues), truncated: false };
      }
      return { items: read(issues.slice(0, MAX_ITEMS)), truncated: true };
    },
  };
}

/**
 * `fetch` for reads that go through the person's own gh (`gh api`), so the sign-in stays with gh
 * and the orchestrator holds no token: each GET is the path and query of the URL it is given, and
 * a refusal comes back as the status gh reported.
 */
export function ownCliFetch(reader: ForgeHttp): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    try {
      return Response.json(await reader.request("GET", `${url.pathname}${url.search}`));
    } catch (err) {
      return new Response(null, { status: err instanceof ForgeHttpError ? err.status : 502 });
    }
  }) as typeof fetch;
}

function githubItem(board: string, issue: GitHubIssue): ItemRead | null {
  if (typeof issue.number !== "number" || !issue.html_url) return null;
  const labels = (issue.labels ?? []).map((l) => (typeof l === "string" ? l : (l.name ?? ""))).filter(Boolean);
  const closed = issue.state === "closed";
  return {
    key: `${board}#${issue.number}`,
    url: issue.html_url,
    summary: issue.title ?? "",
    type: issue.type?.name ?? null,
    status: { name: closed ? CLOSED : OPEN, category: closed ? "done" : "todo" },
    assignee: issue.assignee?.login ? { name: issue.assignee.login, login: issue.assignee.login } : null,
    priority: labels.find((l) => /^priority[:/ ]/i.test(l))?.replace(/^priority[:/ ]+/i, "") ?? null,
    epic: null,
    labels,
    storyPoints: null,
    blocked: labels.some((l) => l.toLowerCase() === "blocked"),
  };
}
