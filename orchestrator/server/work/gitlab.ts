import type { WorkCategory, WorkColumn } from "../../shared/work.js";
import { MAX_BOARDS, MAX_ITEMS, PAGE, SourceFailed, trackerJson } from "./provider.js";
import type { ApiAccess, BoardRead, ItemRead, ItemScope, Memo, Provider, SprintRead } from "./provider.js";

interface GitLabIssue {
  iid?: number;
  title?: string;
  state?: string;
  labels?: string[];
  assignees?: { name?: string; username?: string }[];
  weight?: number | null;
  epic?: { iid?: number; title?: string } | null;
  web_url?: string;
  issue_type?: string;
}

const OPEN = "Open";
const CLOSED = "Closed";
const MOVES_LATER = "The orchestrator does not move GitLab issues yet";

/**
 * GitLab issues with the organization's tracker token or its GitLab connection: a project is a board, an active milestone or a
 * current or upcoming iteration is a sprint, and the columns are the project's issue board lists
 * between Open and Closed, as GitLab draws them. An issue sits in the first list one of its
 * labels names; a `blocked` label marks it blocked and a `priority::` label names its priority.
 */
export function gitlabProvider(api: ApiAccess, memo: Memo, send: typeof fetch = fetch): Provider {
  const get = (path: string) => trackerJson(`${api.baseUrl}${path}`, api.headers, send);
  const project = (board: string) => `/projects/${encodeURIComponent(board)}`;

  const lists = (board: string) =>
    memo(`board:${board}:lists`, async () => {
      const boards = (await get(`${project(board)}/boards`)) as { lists?: { position?: number; label?: { name?: string } }[] }[];
      return [...(boards[0]?.lists ?? [])].sort((a, b) => (a.position ?? 0) - (b.position ?? 0)).map((l) => l.label?.name).filter((n): n is string => Boolean(n));
    });
  const milestones = (board: string) =>
    memo(`board:${board}:milestones`, async () => (await get(`${project(board)}/milestones?state=active&per_page=${PAGE}`)) as { id?: number; title?: string; start_date?: string | null; due_date?: string | null; description?: string | null }[]);

  return {
    boardPattern: /^\d{1,12}$/,
    sprintPattern: /^[mi]\d{1,12}$/,

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
      const boards: BoardRead[] = [];
      for (let page = 1; boards.length < MAX_BOARDS; page++) {
        const read = (await get(`/projects?membership=true&with_issues_enabled=true&archived=false&order_by=last_activity_at&per_page=${PAGE}&page=${page}`)) as { id?: number; path_with_namespace?: string; web_url?: string }[];
        for (const p of read) if (typeof p.id === "number" && p.path_with_namespace && p.web_url) boards.push({ native: String(p.id), name: p.path_with_namespace, type: "project", project: p.path_with_namespace, url: p.web_url });
        if (read.length < PAGE) break;
      }
      return boards.slice(0, MAX_BOARDS);
    },

    async sprints(board: string): Promise<SprintRead[]> {
      const today = new Date().toISOString().slice(0, 10);
      const fromMilestones: SprintRead[] = (await milestones(board))
        .filter((m) => typeof m.id === "number")
        .map((m) => ({ native: `m${m.id}`, name: m.title ?? String(m.id), state: m.start_date && m.start_date > today ? "future" : "active", startsAt: m.start_date ?? null, endsAt: m.due_date ?? null, goal: m.description || null }));
      let iterations: { id?: number; title?: string | null; state?: number; start_date?: string; due_date?: string; sequence?: number }[] = [];
      try {
        iterations = (await get(`${project(board)}/iterations?state=opened&per_page=${PAGE}`)) as typeof iterations;
      } catch (err) {
        // Iterations are a paid GitLab feature; a project without them answers 403 or 404, and has milestones alone.
        if (!(err instanceof SourceFailed)) throw err;
      }
      const fromIterations: SprintRead[] = iterations
        .filter((i) => typeof i.id === "number")
        .map((i) => ({ native: `i${i.id}`, name: i.title || `Iteration ${i.sequence ?? i.id}`, state: i.start_date && i.start_date > today ? "future" : "active", startsAt: i.start_date ?? null, endsAt: i.due_date ?? null, goal: null }));
      return [...fromIterations, ...fromMilestones];
    },

    async columns(board: string): Promise<WorkColumn[]> {
      return [{ name: OPEN, statuses: [OPEN] }, ...(await lists(board)).map((name) => ({ name, statuses: [name] })), { name: CLOSED, statuses: [CLOSED] }];
    },

    async items(board: string, scope: ItemScope): Promise<{ items: ItemRead[]; truncated: boolean }> {
      let filter: string;
      if ("sprint" in scope) {
        const id = Number(scope.sprint.slice(1));
        if (scope.sprint.startsWith("i")) {
          filter = `iteration_id=${id}&state=all`;
        } else {
          const milestone = (await milestones(board)).find((m) => m.id === id);
          if (!milestone?.title) return { items: [], truncated: false };
          filter = `milestone=${encodeURIComponent(milestone.title)}&state=all`;
        }
      } else {
        filter = "milestone=None&state=opened";
      }
      const boardLists = await lists(board);
      const issues: GitLabIssue[] = [];
      for (let page = 1; issues.length < MAX_ITEMS; page++) {
        const read = (await get(`${project(board)}/issues?${filter}&per_page=${PAGE}&page=${page}`)) as GitLabIssue[];
        issues.push(...read);
        if (read.length < PAGE) return { items: issues.map((i) => gitlabItem(i, boardLists)).filter((i): i is ItemRead => i !== null), truncated: false };
      }
      return { items: issues.slice(0, MAX_ITEMS).map((i) => gitlabItem(i, boardLists)).filter((i): i is ItemRead => i !== null), truncated: true };
    },
  };
}

function gitlabItem(issue: GitLabIssue, lists: readonly string[]): ItemRead | null {
  if (typeof issue.iid !== "number" || !issue.web_url) return null;
  const path = /^https?:\/\/[^/]+\/(.+)\/-\/(?:issues|work_items)\/\d+/.exec(issue.web_url)?.[1];
  if (!path) return null;
  const labels = Array.isArray(issue.labels) ? issue.labels.filter((l) => typeof l === "string") : [];
  const closed = issue.state === "closed";
  const list = closed ? undefined : lists.find((l) => labels.includes(l));
  const status = closed ? CLOSED : (list ?? OPEN);
  const category: WorkCategory = closed ? "done" : list ? "doing" : "todo";
  return {
    key: `${path}#${issue.iid}`,
    url: issue.web_url,
    summary: issue.title ?? "",
    type: issue.issue_type ?? null,
    status: { name: status, category },
    assignee: issue.assignees?.[0]?.name ? { name: issue.assignees[0].name, login: issue.assignees[0].username ?? null } : null,
    priority: labels.find((l) => /^priority::?/i.test(l))?.replace(/^priority::?/i, "") ?? null,
    epic: issue.epic?.title ? { key: issue.epic.iid ? `&${issue.epic.iid}` : null, summary: issue.epic.title } : null,
    labels,
    storyPoints: typeof issue.weight === "number" ? issue.weight : null,
    blocked: labels.some((l) => l.toLowerCase() === "blocked"),
  };
}
