import type { WorkCategory, WorkColumn, WorkItem, WorkSprint } from "../../shared/work.js";

// Here, in a module that imports nothing at run time: read from issue-read.ts it closed an import
// cycle through the task runner, and a module of that cycle found Work's constants undefined.
export const READ_TIMEOUT_MS = 10_000;

/** A board as its tracker names it, before the orchestrator gives it an id and a team. */
export interface BoardRead {
  native: string;
  name: string;
  type: "scrum" | "kanban" | "project" | "repository";
  project: string | null;
  url: string;
}

export type SprintRead = Omit<WorkSprint, "id"> & { native: string };

/** An issue as the tracker gave it; its assignee keeps what tells whether it is the reader, which no screen gets. */
export type ItemRead = Omit<WorkItem, "tasks" | "column" | "assignee"> & { assignee: { name: string; email?: string | null; login?: string | null; you?: boolean } | null };

/** A sprint's issues, a backlog, or a board with no sprints (Kanban): every issue on it but its epics, the done ones from the last two weeks. */
export type ItemScope = { sprint: string } | { backlog: true } | { board: true };

/** What a board holds of done work and of epics, as Jira's own boards show it. */
export const BOARD_JQL = "issuetype != Epic AND (statusCategory != Done OR statusCategoryChangedDate >= -14d)";

/** Keeps what a provider reads about a board that changes rarely, such as its configuration, with the tracker's other answers. */
export type Memo = <T>(key: string, load: () => Promise<T>) => Promise<T>;

/** Reads one tracker's boards, sprints, columns and issues, each through that tracker's own API. */
export interface Provider {
  /** The shape a board's and a sprint's own id has on this tracker; anything else never reaches a request. */
  boardPattern: RegExp;
  sprintPattern: RegExp;
  boards(): Promise<BoardRead[]>;
  sprints(board: string): Promise<SprintRead[]>;
  columns(board: string): Promise<WorkColumn[]>;
  items(board: string, scope: ItemScope): Promise<{ items: ItemRead[]; truncated: boolean }>;
  /** Why this source does not move issues, in one sentence; null when it does. */
  writable(): Promise<string | null>;
  /** An issue's status now, and the moves its workflow offers from there. */
  transitions(issue: IssueRef): Promise<{ status: string; transitions: { id: string; to: string; category: WorkCategory }[] }>;
  transition(issue: IssueRef, id: string): Promise<void>;
}

/** An issue a move is for: its key, and the address it was linked by, which names its site. */
export interface IssueRef {
  key: string;
  url: string;
}

export const JIRA_KEY = /^[A-Z][A-Z0-9_]{0,19}-\d{1,9}$/;

/** Where a forge's API is and what to send it: the tracker token's, or the organization's forge connection's. */
export interface ApiAccess {
  baseUrl: string;
  headers: Record<string, string>;
  /** What every call to this API goes through: for an organization's own GitLab, held to the address judged for it. */
  send?: typeof fetch;
}

export const PAGE = 50;
export const MAX_ITEMS = 500;
export const MAX_BOARDS = 200;

/** A tracker that did not answer as asked; its message names no credential and is shown as it is. */
export class SourceFailed extends Error {
  constructor(message: string, readonly status: number | null = null) {
    super(message);
  }
}

export async function trackerJson(url: string, headers: Record<string, string>, send: typeof fetch, post?: unknown): Promise<unknown> {
  let res: Response;
  try {
    const body = post === undefined ? {} : { method: "POST", body: JSON.stringify(post) };
    res = await send(url, { headers: { accept: "application/json", ...(post === undefined ? {} : { "content-type": "application/json" }), ...headers }, ...body, redirect: "error", signal: AbortSignal.timeout(READ_TIMEOUT_MS) });
  } catch (err) {
    throw new SourceFailed((err as Error).name === "TimeoutError" ? `the tracker did not answer within ${READ_TIMEOUT_MS / 1000} seconds` : "the tracker was not reached");
  }
  if (res.status === 401 || res.status === 403) throw new SourceFailed(`the tracker refused the token (${res.status})`);
  if (res.status === 404) throw new SourceFailed("the tracker has no such board, or the token cannot see it");
  if (!res.ok) throw new SourceFailed(`the tracker answered ${res.status}`, res.status);
  if (res.status === 204) return null;
  try {
    return await res.json();
  } catch {
    throw new SourceFailed("the tracker's answer is not JSON");
  }
}

/** The column a status sits in on this board, by its name; null when no column lists it. */
export function columnOf(columns: readonly WorkColumn[], status: string): string | null {
  return columns.find((c) => c.statuses.includes(status))?.name ?? null;
}
