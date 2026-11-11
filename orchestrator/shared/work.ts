// What /api/work/* answers with and the Work screen reads, imported by both sides. Ids are
// opaque and stable: a screen sends them back as given and never takes them apart. A column is
// the team's own workflow on the tracker; the orchestrator's own phase is a separate badge.

import type { RequestStatus, TaskStatus } from "./activity.js";

export type WorkKind = "jira" | "gitlab" | "github" | "linear";

/** GET /api/work/sources: every tracker this person reads issues from, empty when none is connected. */
export interface WorkSources { sources: WorkSource[] }
export interface WorkSource {
  /** "tracker" for the organization's token, "mcp:<server>" for an MCP server. */
  id: string;
  kind: WorkKind;
  name: string;
  url: string;
  /** The organization's tracker token, a person's own MCP server, the organization's GitLab or GitHub connection, or the person's own gh. */
  via: "token" | "mcp" | "app" | "cli";
  as: "organization" | "you";
  can: { boards: boolean; sprints: boolean; backlog: boolean; storyPoints: boolean; write: boolean };
  /** Why `can.write` is false, in one sentence; null when the source moves issues. */
  writeProblem: string | null;
  /** Why the tracker does not read right now; null when it does. */
  problem: string | null;
}

/** GET /api/work/boards?source= */
export interface WorkBoards { boards: WorkBoard[]; fetchedAt: string; stale: boolean }
export interface WorkBoard {
  id: string;
  name: string;
  type: "scrum" | "kanban" | "project" | "repository";
  project: string | null;
  url: string;
  /** The team an owner or an admin mapped an organization-token board to; null when unmapped or the person's own. */
  team: string | null;
}

/** GET and PUT /api/work/boards/teams: which team sees each organization-token board; PUT by an owner or an admin. */
export interface WorkBoardTeams { boards: { boardId: string; name: string; team: string | null }[] }

/** GET /api/work/boards/:id/columns, the same list WorkItems carries. */
export interface WorkColumns { columns: WorkColumn[] }
/** One column of the board in its order, with the tracker statuses it holds. */
export interface WorkColumn { name: string; statuses: string[] }

/** GET /api/work/sprints?board= */
export interface WorkSprints { sprints: WorkSprint[]; fetchedAt: string; stale: boolean }
export interface WorkSprint {
  id: string;
  name: string;
  state: "active" | "future" | "closed";
  startsAt: string | null;
  endsAt: string | null;
  goal: string | null;
}

export type WorkCategory = "todo" | "doing" | "done";

/** GET /api/work/items?sprint= or ?backlog=<board>, with &fresh=1 to read the tracker again. */
export interface WorkItems {
  columns: WorkColumn[];
  items: WorkItem[];
  fetchedAt: string;
  stale: boolean;
  truncated: boolean;
  progress: { todo: number; doing: number; done: number; points: { total: number; done: number } | null };
}

export interface WorkItem {
  key: string;
  /** What POST /api/tasks takes as issueUrl. */
  url: string;
  summary: string;
  type: string | null;
  status: { name: string; category: WorkCategory };
  /** The board column holding the status; null when no column lists it. */
  column: string | null;
  /** `you` is set when the issue is assigned to the person reading: their email on Jira, their forge login on GitLab and GitHub. */
  assignee: { name: string; you?: boolean } | null;
  priority: string | null;
  epic: { key: string | null; summary: string } | null;
  labels: string[];
  storyPoints: number | null;
  /** Set when the tracker marks the issue blocked or flagged. */
  blocked?: boolean;
  /** The orchestrator tasks started from this issue that this person sees, newest first. */
  tasks: WorkTaskLink[];
}

/** Where an orchestrator task stands, as the server works it out from the task and its requests. */
export type TaskPhase = "planned" | "working" | "tests" | "request" | "review" | "merged" | "failed";

export interface WorkTaskLink {
  taskId: string;
  status: TaskStatus;
  phase?: TaskPhase;
  /** "changes" for a task in a folder with no Git, which edits the files in place and opens no request. */
  result?: "request" | "changes" | null;
  targets: { repoId: string; status: "planned" | "working" | "tests" | "request" | "failed" | "skipped" | "local" }[];
  /** `url` is the forge's page, null for a request kept on this machine, whose review is the task's own page; `name` is how its link reads. */
  requests: { repoId: string; number: number; status: RequestStatus; url: string | null; name: string }[];
  startedBy: string;
  costUsd: number | null;
  /** Why a failed or stopped task ended, in one sentence; absent for any other. */
  reason?: string;
}

/** What an agent's task did, each a moment a board can move its issue on. */
export type WorkMoveTrigger = "started" | "requestOpened" | "merged";

/**
 * GET and PUT /api/work/moves?board=: "Move issues as the agent works". Off until someone turns
 * it on; with no mapping saved the server proposes one guessed from the column names. Each move
 * is written to the event log before it is sent.
 */
export interface WorkMoves {
  enabled: boolean;
  /** The moves are the server's guess from the column names; nothing is saved yet. */
  guessed: boolean;
  /** An owner or an admin on an organization-token board; the person on their own MCP board. */
  canChange: boolean;
  /** `off` when moving issues is turned off for the board's tracker under Integrations, the reason then saying so. */
  write: { allowed: boolean; reason: string | null; off: boolean };
  /** Column names. */
  moves: Partial<Record<WorkMoveTrigger, string>>;
}

/** POST /api/work/items/:key/transition */
export interface WorkTransition { board: string; column: string }
export interface WorkTransitioned { status: WorkItem["status"]; column: string | null }

/**
 * An automation on one of the organization's tracker boards: when an issue moves into a column,
 * or gets a label, a task is drafted for a person to start, or, where an owner or an admin chose
 * so, started in their name under every rule a start from the screen meets.
 * GET /api/work/automations -> { enabled, automations }; POST, PUT /:id and DELETE /:id change
 * one; PUT { enabled } turns them all on or off; GET /:id/deliveries -> { deliveries: { at, detail }[] }.
 * Owners and admins only.
 */
export interface WorkAutomation {
  id: string;
  name: string;
  board: string;
  /** The project the board holds, matched against the project a delivery names. */
  project: string;
  trigger: { kind: "column"; column: string; statuses: string[] } | { kind: "label"; label: string };
  /** An issue passes only with every one of these labels, and only of one of these types when any are named. */
  filter: { labels: string[]; types: string[] };
  repoId: string;
  agent: string;
  action: "draft" | "start";
  enabled: boolean;
  /** How many deliveries a minute it acts on; the rest are logged and dropped. */
  perMinute: number;
  by: { id: string; name: string };
  at: string;
}

/** A task an automation drafted, waiting for someone who may start tasks on its repository. */
export interface WorkDraft {
  id: string;
  automation: string;
  issueKey: string;
  issueUrl: string;
  repoId: string;
  agent: string;
  at: string;
}

/** GET /api/work/drafts; POST /api/work/drafts/:id/start -> { task: { id } }; DELETE /api/work/drafts/:id. */
export interface WorkDrafts { drafts: WorkDraft[] }

/** GET /api/work/starters?project= */
export interface WorkStarters { starters: WorkStarter[] }
/** A task to start a project with, read off its folder: a TODO or FIXME note, or a check its manifest names. */
export interface WorkStarter {
  kind: "todo" | "tests" | "lint";
  title: string;
  description: string;
  /** The file and line of a note, or the manifest that names the check. */
  where: string;
}
