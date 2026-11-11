import type { AgentChoices } from "./adapters/contract.js";
import type { ChangedFile } from "../forge/request-diff.js";

/** `interrupted`: a task on a person's machine whose lease ran out; it waits for Continue on that machine and is not finished. */
export type TaskStatus = "queued" | "running" | "interrupted" | "needs-review" | "failed" | "cancelled";

export const FINISHED: readonly TaskStatus[] = ["needs-review", "failed", "cancelled"];

export type TestOutcome = "passed" | "failed" | "skipped";

/**
 * A task cut to one skill: write a new one, or improve one the repository has. The prompt
 * says what the plugin reads in a skill, and the result has to stay inside that skill's folder.
 */
export interface SkillTemplate {
  kind: "skill.write" | "skill.improve";
  skill: string;
}

/**
 * A task the orchestrator does itself, with no agent: the plugin's scaffold refresh, written for
 * the address teammates add the repository by, optionally switching it to versioning by commit.
 */
export interface ScaffoldTemplate {
  kind: "scaffold.refresh";
  commitVersioning: boolean;
}

export type TaskTemplate = SkillTemplate | ScaffoldTemplate;

/** The agent id a task the orchestrator does itself is recorded under. */
export const ORCHESTRATOR_AGENT = "orchestrator";

/** What the agent itself reported spending. Null fields are "unknown": the orchestrator never estimates. */
export interface TaskCost {
  usd: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
}

export const UNKNOWN_COST: TaskCost = { usd: null, inputTokens: null, outputTokens: null };

/**
 * One piece of work handed to an agent: the person who asked, the repository it runs
 * against, and what came of it. The record keeps the outcome and a redacted log; the
 * checkout the agent worked in is deleted when the run ends.
 */
export interface TaskRecord {
  tenant: string;
  id: string;
  repoId: string;
  /** The repository's team when the task was created; who may cancel it is decided by this. */
  team: string;
  title: string;
  description: string;
  /** The issue the task works on, as an https address, and its key when the orchestrator recognises the tracker. */
  issueUrl: string | null;
  issueKey: string | null;
  agent: string;
  status: TaskStatus;
  createdBy: string;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  baseSha: string | null;
  tests: TestOutcome | null;
  cost: TaskCost;
  requestNumber: number | null;
  error: string | null;
  /** The template the task was started from, or null for any change; Run again starts the same. */
  template?: TaskTemplate | null;
  /** How a task over several repositories chose them: the orchestrator planned them, or the person named them; null for a task over one. */
  targetMode?: "orchestrator" | "pinned" | null;
  /** The repositories a task over several works on, in the order it runs them; null for a task over one, [] while they are planned. */
  targets?: TaskTarget[] | null;
  /** Where a running task is on the board: the agent working, its tests, its request; null when it has not started or has ended. */
  stage?: TaskStage | null;
  /** The skills the task was started with, by name; null when none were chosen. */
  skills?: string[] | null;
  /** What the starter picked of the project's own skill sources and MCP servers; absent when nothing. */
  tools?: TaskToolChoice | null;
  /** What the person's own Claude Code loaded into a run as them on this orchestrator's host, by count alone; absent when none of it did. */
  loaded?: TaskLoaded | null;
  /** How many tokens the agent's first request carried, the context its cost starts from; a run that goes on keeps the first. */
  context?: { tokens: number };
  /** When the task's current run on a runner started: a continued task's limit of time counts from here, not from its first start. */
  runStartedAt?: string;
  /** Started to plan first: the agent changes nothing until its starter approves the plan it puts to them. */
  planFirst?: boolean;
  /** Where the orchestrator sent a task started with no project named, and why. */
  routing?: { path: string; reason: string; fallback: boolean };
  /** What a stopped run asked its starter, and their answer once given; the next run takes the answer. */
  question?: { text: string; options: string[]; answer?: string } | null;
  /** The person's own MCP servers the task's agent found waiting for a sign-in it cannot finish without them, by name. */
  mcpNeedsSignIn?: string[];
  /** The members it is shared with to read, by user id; absent when it is shared with none. */
  sharedWith?: string[];
  /** How far the agent goes without asking; absent reads as auto. */
  mode?: TaskMode | null;
  /** The task that delegated this one; absent for a task a person started. */
  parentId?: string | null;
  /** How many delegations down from the task a person started; absent for that task itself. */
  depth?: number;
  /** Present when the task runs on its creator's own machine; absent for one the orchestrator runs. */
  runner?: "local";
  /** What the task chose of its agent's options; absent for the agent's own defaults, and Run again sends the same. */
  choices?: AgentChoices;
  /** What the task left: a request, or changes made in a folder without git; absent until it ends with one. */
  result?: "request" | "changes";
  /** The changes a task made in a folder without git, as its page shows them; the snapshots they are read between stay with the runner. */
  changes?: TaskChanges;
}

/**
 * A task's pick of its project's own skills and MCP servers, by source and server id: a git
 * source at the head it was read at when the task started, so a later refresh changes no task
 * already started.
 */
export interface TaskToolChoice {
  skills: { source: string; name: string; head: string | null }[];
  mcpServers: string[];
}

/** A file a task changed in a folder, `undone` once its person took that one change back. */
export type TaskChangedFile = ChangedFile & { state?: "undone" };

export interface TaskChanges {
  files: TaskChangedFile[];
  /** Set once every file is back as it was; `reason` the person's one line on why, when they gave one. */
  undone: { at: string; by: string; kept: string[]; reason?: string } | null;
  /** Set once its person keeps the change: it is theirs from then on, and no undo takes it back. */
  kept?: { at: string; by: string } | null;
}

export type TaskMode = "approval-required" | "auto-accept-edits" | "auto" | "full-access";

export type TaskStage = "working" | "tests" | "request";

/** `local`: a repository on its person's machine whose change stays on the task's branch there, with no request; `reason` says why. */
export type TaskTargetStatus = "planned" | "working" | "tests" | "request" | "failed" | "skipped" | "local";

/** Why a changed repository on a person's machine has no request: no remote, a push that did not go, or a remote this organization did not connect. */
export type LocalTargetReason = "no-remote" | "unpushed" | "not-connected";

/** One repository of a task over several: its own checkout, tests, request and cost. */
export interface TaskTarget {
  repoId: string;
  status: TaskTargetStatus;
  reason: string;
  /** Where the repository is in the folder the task worked in, "" for the folder itself; absent for a repository the orchestrator named. */
  path?: string;
  /** For a change kept on its person's machine: the branch's head there, the remote and its default branch the machine reported, and the request's words, masked; what a later push and request take. */
  head?: string;
  origin?: string;
  targetBranch?: string;
  description?: { title: string; body: string };
  baseSha: string | null;
  branch: string | null;
  tests: TestOutcome | null;
  requestNumber: number | null;
  error: string | null;
  cost: TaskCost;
}

export type TaskTargetPatch = Partial<Pick<TaskTarget, "repoId" | "status" | "reason" | "baseSha" | "branch" | "tests" | "requestNumber" | "error" | "cost">>;

/** An agent's event for the task's log: the line it reads as, its type and the event itself, all masked. */
export interface TaskLogEvent {
  text: string;
  kind: string;
  data: Record<string, unknown>;
}

export interface TaskLogLine {
  seq: number;
  at: string;
  text: string;
  /** Present on a runner's event: the agent event's type and the masked event itself. */
  kind?: string;
  data?: Record<string, unknown>;
}

export type TaskPatch = Partial<Pick<TaskRecord, "status" | "startedAt" | "finishedAt" | "baseSha" | "tests" | "cost" | "requestNumber" | "error" | "stage" | "result" | "loaded" | "routing" | "question" | "mcpNeedsSignIn" | "planFirst">>;

/** The person's own skills or commands, enabled plugins and MCP servers a run loaded, and whether their CLAUDE.md was among them. */
export interface TaskLoaded {
  commands: number;
  plugins: number;
  mcpServers: number;
  claudeMd: boolean;
}

/**
 * Which tasks a read takes, every field narrowing it. Lists of names match any of them, and an
 * empty one matches no task: a filter built from an audience nobody is in reads nothing.
 */
export interface TaskFilter {
  repoId?: string;
  /** The tasks one person sees: their teams', the ones they started, and those shared with them. */
  visibleTo?: { teams: readonly string[]; creators: readonly string[]; sharedWith?: string };
  createdBy?: readonly string[];
  statuses?: readonly TaskStatus[];
  /** Started at or after this time (ISO). */
  since?: string;
  /** Finished at or after this time (ISO); a task not finished is not taken. */
  finishedSince?: string;
  /** Text the title holds, matched as the description is. */
  titleHas?: string;
  requestNumber?: number;
  /** Opened a request the store records as opened at or after this time (ISO), whenever the task itself started. */
  requestOpenedSince?: string;
  /** Text the description holds, matched loosely: a caller that needs it exactly checks the tasks it gets. */
  descriptionHas?: string;
  /** Names one of these issues by key, as the task form recorded it. */
  issueKeys?: readonly string[];
}

/** Where a page of tasks ends: newest first by creation, then id, so a task started between two pages neither repeats nor skips a row. */
export interface TaskCursor {
  createdAt: string;
  id: string;
}

/**
 * What one person's tasks on one repository cost as their agents reported it, and how many
 * reported nothing, summed by the store. A budget counts these rather than the tasks: there are
 * as many as people times repositories, however many tasks a month holds.
 */
export interface TaskSpendRow {
  repoId: string;
  team: string;
  createdBy: string;
  usd: number;
  tasks: number;
  unknownCost: number;
  /** The most one of these tasks reported, 0 when none reported a cost. */
  largestUsd: number;
}

/** Model spend that is not a task's, a skill suggestion's for one, counted against the same budgets. */
export interface ExtraSpendRecord {
  tenant: string;
  id: string;
  createdBy: string;
  repoId: string;
  team: string;
  at: string;
  /** What spent it, such as "skill-suggestion". */
  kind: string;
  usd: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
}

/** A task shared with a member of its organization to read. */
export interface TaskShare {
  tenant: string;
  taskId: string;
  userId: string;
  sharedBy: string;
  at: string;
}

export interface TaskStore {
  createTask(task: TaskRecord): Promise<void>;
  getTask(tenant: string, id: string): Promise<TaskRecord | null>;
  listTasks(tenant: string, repoId?: string): Promise<TaskRecord[]>;
  /** A page of the tasks a filter takes, newest first, and where the next page starts; null on the last. */
  taskPage(tenant: string, filter: TaskFilter, after: TaskCursor | null, limit: number): Promise<{ tasks: TaskRecord[]; next: TaskCursor | null }>;
  /** The cost of the tasks a filter takes, summed by the store rather than read row by row. */
  taskSpendRows(tenant: string, filter: TaskFilter): Promise<TaskSpendRow[]>;
  /** The tasks a task delegated itself, oldest first. */
  taskChildren(tenant: string, parentId: string): Promise<TaskRecord[]>;
  /** Every task below a task, at any depth and without the task itself, oldest first. */
  taskDescendants(tenant: string, taskId: string): Promise<TaskRecord[]>;
  /** Saves spend outside a task once; the same id again adds nothing. */
  recordExtraSpend(spend: ExtraSpendRecord): Promise<void>;
  /** Spend outside tasks in the shape tasks' spend is read in, tasks always 0, since `since` and by any of `createdBy`. */
  extraSpendRows(tenant: string, filter: { since?: string; createdBy?: string[] }): Promise<TaskSpendRow[]>;
  updateTask(tenant: string, id: string, patch: TaskPatch): Promise<void>;
  /** Lines for the task's log, already masked: a line as it reads, or an agent's event with the line it reads as. */
  appendTaskLog(tenant: string, id: string, lines: readonly (string | TaskLogEvent)[]): Promise<void>;
  taskLog(tenant: string, id: string, afterSeq: number): Promise<TaskLogLine[]>;
  /** Marks every task of the tenant a previous process left queued or running as failed, and says how many. */
  interruptTasks(tenant: string, reason: string): Promise<number>;
  /** The process group a running task's current process leads, so a later start can end what a crash left. */
  setTaskProcess(tenant: string, id: string, pgid: number | null): Promise<void>;
  /** The branch a task's request is to go on, recorded before its agent runs. */
  setTaskBranch(tenant: string, id: string, branch: string): Promise<void>;
  /** Keeps a task's changes in a folder without git with the two snapshots they are read between, and marks its result as changes. */
  setTaskChanges(tenant: string, id: string, changes: TaskChanges & { before: string; after: string }): Promise<void>;
  /** The snapshots a task's changes are read between, for the runner and the undo alone; null when it has none. */
  taskChangeSnapshots(tenant: string, id: string): Promise<{ before: string; after: string } | null>;
  /** Records an undo once: false when the changes were undone or kept already, or there are none. */
  markTaskChangesUndone(tenant: string, id: string, undone: NonNullable<TaskChanges["undone"]>): Promise<boolean>;
  /** Marks these files of the task's change undone, and the change itself once none is left; false once it was kept or undone. */
  markTaskFilesUndone(tenant: string, id: string, paths: readonly string[], undone: NonNullable<TaskChanges["undone"]>): Promise<boolean>;
  /** Keeps how many tokens the task's first agent request carried, once: a later run's leaves the first as it is. */
  noteTaskContext(tenant: string, id: string, tokens: number): Promise<void>;
  /** Records that its person keeps the change, once: false when it was kept or undone already, or there is none. */
  markTaskChangesKept(tenant: string, id: string, kept: NonNullable<TaskChanges["kept"]>): Promise<boolean>;
  /** Shares a task with a member to read; false when it is shared with them already. */
  addTaskShare(share: TaskShare): Promise<boolean>;
  /** False when it was not shared with them. */
  removeTaskShare(tenant: string, taskId: string, userId: string): Promise<boolean>;
  /** Who a task is shared with, the first shared first. */
  listTaskShares(tenant: string, taskId: string): Promise<TaskShare[]>;
  /** One task works in a project's folder in place at a time: true when this task took the folder or holds it already, false when another holds it. */
  takeProjectLock(tenant: string, projectId: string, taskId: string, at: string): Promise<boolean>;
  /** Lets the folder go, only when this task holds it. */
  releaseProjectLock(tenant: string, projectId: string, taskId: string): Promise<void>;
  /** Lets go every folder held by a task that is no longer queued, running or interrupted; says how many. */
  releaseStaleProjectLocks(tenant: string): Promise<number>;
  /**
   * The tasks left queued or running, with the process group each last recorded, the branch it
   * named, and each of its repositories' branches; only the ones `runner` runs when it is given,
   * as a restart here ends only its own and leaves a machine's to their lease.
   */
  unfinishedTasks(tenant: string, runner?: "server" | "local"): Promise<{ id: string; repoId: string; pgid: number | null; branch: string | null; targets: { repoId: string; branch: string | null }[] }[]>;
  /** Puts a task's repositories in place of the ones it had, all at once. */
  setTaskTargets(tenant: string, taskId: string, targets: readonly TaskTarget[]): Promise<void>;
  updateTaskTarget(tenant: string, taskId: string, position: number, patch: TaskTargetPatch): Promise<void>;
}
