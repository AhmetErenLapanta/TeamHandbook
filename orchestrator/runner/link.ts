import type { AgentAnswers, AgentChoices, AgentRequest, Decision } from "../server/tasks/adapters/contract.js";
import type { McpTool } from "../server/tasks/agents.js";
import type { PermissionMode } from "../shared/permission-mode.js";
import type { FolderList, FolderRefusal } from "../shared/projects.js";
import type { ChangedFile } from "../server/forge/request-diff.js";
import type { FollowUpRecord } from "../server/task-followups.js";
import type { PolicyRule } from "../server/plugin.js";
import type { MachineMcpServer } from "./machine-mcp.js";
import type { MachineAgentStatus, RunnerEvent } from "../server/runner-store.js";
import type { TaskCost, TestOutcome } from "../server/tasks/types.js";
import type { VerifyPlan } from "../server/tasks/verify.js";
import type { DetectedVerification, TaskVerification } from "../shared/verification.js";

/** What a runner is told of a task it leased: enough to run it, nothing of anyone else's. */
export interface RunnerTask {
  id: string;
  title: string;
  agent: string;
  /** The agent's own session id from an earlier run, when Continue resumes it. */
  nativeSession: string | null;
  /** What a machine away from the orchestrator needs to run the task with nothing of the orchestrator's but this; absent for the runner inside a local orchestrator, which reads the task itself. */
  work?: RemoteWork;
}

/**
 * A task as the orchestrator hands it to a machine of its person's: everything decided on the
 * orchestrator, so two machines never decide it differently, and no credential of the
 * organization's in it. The prompt is the one the orchestrator built, fenced and masked there.
 */
interface WorkCommon {
  prompt: string;
  mode: PermissionMode;
  choices: AgentChoices | null;
  /** The agent plans first and changes nothing until its starter approves the plan. */
  planFirst?: boolean;
  /** The task's attachments by id, which the machine fetches into the task's own folder for the agent to read; never their bytes. */
  attachments?: { id: string; name: string; kind: "image" | "pdf" | "text" }[];
  /**
   * The team's skills come from the person's installed team plugin; MCP tools are named, server
   * definitions do not travel; the tools the team's policies take away are taken away there too.
   * What the run made is checked again on the orchestrator before any request opens: the machine
   * is the person's, so it is not trusted to have held the team's rules. `ownSetup` is the
   * orchestrator's policy decision on whether the run loads the person's own Claude Code setup or
   * their sign-in alone; a machine that reads none takes the sign-in alone.
   */
  setup: {
    plugin: { name: string; version: string } | null;
    mcpTools: McpTool[];
    deniedTools: string[];
    ownSetup?: boolean;
    folderSettings?: boolean;
    /** The project's servers by template: each value names variables of the person's own environment, never one of the organization's. */
    mcpServers?: Record<string, MachineMcpServer>;
  };
  limits: {
    timeoutMs: number;
    /** The one command the orchestrator's configuration sets, for a machine that does not read `verification` yet. */
    testCommand: string | null;
    /**
     * The checks the run holds the change to, before the agent and after it, with at most `maxRepairs`
     * repair rounds, the commands masked by the task's secrets; null when none runs, the reason already
     * kept on the orchestrator as the task's evidence.
     */
    verification?: { plan: VerifyPlan; maxRepairs: number } | null;
  };
  /**
   * The team's policies. A run as the person loads no plugin, so the team's policy hook does not
   * run there: the machine's guard denies the paths they keep from Edit and Read, and in place,
   * where the edit is already made when the run ends, the machine takes back one they refuse.
   */
  rules: PolicyRule[];
}

/** A task on a repository the machine clones, its change pushed to a branch for review. */
export interface CheckoutWork extends WorkCommon {
  /** The address the person's own git clones from, never with a credential in it, and the head the run starts from. */
  repo: { url: string; baseBranch: string; baseSha: string };
  /** The branch the run pushes to, named on the orchestrator by the team's rule. */
  branch: string;
  /**
   * Present when the task goes on from its open request: the request's branch (the run's own) and
   * its head as the orchestrator read it when it handed the task out. The run starts from that head
   * and pushes onto it, never forced; `repo.baseSha` stays the task's first base.
   */
  continues?: { branch: string; head: string };
}

/**
 * A task in a folder without git on the machine itself: the agent edits it in place, and what it
 * changed stays there, recorded by the machine's own shadow, for its person to keep or undo.
 * `path` is from the machine's home; the machine reads it against its own folder rule.
 */
export interface FolderWork extends WorkCommon {
  folder: { machineId: string; projectId: string; path: string };
}

/**
 * A task in its person's one work folder on their machine, named from its home: the machine finds the
 * working copies in it, the agent works on a copy of each on the task's branch, and only the ones it
 * changed reach the person's repositories, pushed with their own git.
 */
export interface WorkspaceWork extends WorkCommon {
  workspace: { machineId: string; projectId: string; path: string };
  branch: string;
}

export type RemoteWork = CheckoutWork | FolderWork | WorkspaceWork;

export interface Lease {
  leaseId: string;
  task: RunnerTask;
  /** The number the task's next runner event takes, so a resumed task never reuses one. */
  nextEvent: number;
}

/**
 * A folder list the machine's person asked for: `under` is a hint, `~` and what follows it, or null
 * for the home folder's own suggestions; the machine reads it against its own rule.
 */
export interface FolderAsk {
  nonce: string;
  under: string | null;
  q: string | null;
}

/** The machine's list, every path as `~` and what follows it, or why the folder asked for was refused. */
export type FolderAnswer = FolderList | { refused: FolderRefusal; message: string };

/** A task's change in a folder of this machine its person asked to undo on the orchestrator's screen. */
export interface UndoAsk {
  nonce: string;
  projectId: string;
  path: string;
  before: string;
  after: string;
}

/** The files put back and the ones kept because the person changed them since, or why nothing was undone. */
export type UndoAnswer = { undone: string[]; kept: string[] } | { refused: string };

/** A folder project's checks, read off the folder on this machine for the screen that approves them. */
export interface ChecksAsk {
  nonce: string;
  projectId: string;
  path: string;
}

/** What the folder's files say it installs and checks with, or why the folder was not read. */
export type ChecksAnswer = { detected: DetectedVerification } | { refused: string };

export interface PushAsk {
  nonce: string;
  projectId: string;
  path: string;
  repo: string;
  branch: string;
  head: string;
}

export type PushAnswer = { pushed: true } | { refused: string };

/** A lesson from a task of this machine's person, for their own review queue: its makings, which the machine reads, builds and screens itself. */
export interface LessonAsk {
  nonce: string;
  lesson: unknown;
}

/** The name the lesson was queued under, why the plugin's own rules left it out, or why nothing was written. */
export type LessonAnswer = { slug: string } | { dropped: "secret" | "muted" | "duplicate" } | { refused: string };

/** Its person, on the task's page, reading or deciding a lesson this machine holds from that task. */
export interface LessonOpAsk {
  nonce: string;
  taskId: string;
  slug: string;
  op: "read" | "keep" | "reject";
  never?: boolean;
}

export type LessonOpAnswer =
  | { read: { status: string; description: string; skillMd: string; quote: string | null } }
  | { decided: "approved" | "rejected"; muted: boolean }
  | { refused: string };

/** A follow-up the person sent a running task, as the agent is given it. */
export type RelayedFollowUp = Pick<FollowUpRecord, "id" | "source" | "text" | "quotes" | "createdBy">;

/** What the orchestrator hands a runner between leases: a person's answer, a follow-up, or a Stop. */
export type RunnerCommand =
  | { type: "answer"; taskId: string; requestId: string; decision: Decision; note?: string; answers?: AgentAnswers; plan?: string }
  | { type: "follow_up"; taskId: string; followUp: RelayedFollowUp }
  | { type: "stop"; taskId: string };


export type { RunnerEvent };

/** An event as the runner sends it: numbered per task, so a batch sent twice is stored once. */
export interface NumberedEvent {
  n: number;
  event: RunnerEvent;
}

/** Where a running task is, as the executor records it; `cost` is one part's addition, a null part unknown. */
export interface TaskProgress {
  stage?: "tests" | "request";
  baseSha?: string;
  branch?: string;
  tests?: TestOutcome;
  cost?: TaskCost;
  /** The agent's own session id as soon as the executor knows it, so Continue resumes it even after a crash. */
  nativeSession?: string;
  /** The checks' runs once they end; the orchestrator works out the verdicts again, masks the runs and keeps them as the task's evidence. */
  verification?: TaskVerification;
}

export interface TaskOutcome {
  status: "needs-review" | "failed" | "interrupted";
  error: string | null;
  nativeSessionId: string | null;
  /** The branch the runner pushed; the request is opened from it, never by the executor. */
  branch: string | null;
  /** Which repository of a task over several this outcome is for; null for a task over one. */
  position: number | null;
  /** The request's title and description the run wrote, for the orchestrator to open it from the branch; null unless it ended for review with a branch. */
  request: { title: string; body: string } | null;
  /**
   * A run in a folder holding several repositories (the person's one working folder): each
   * repository the agent changed, by its path under that folder, with the task's branch, the commit
   * it pushed and the base it started from, the remote it went to (null when the repository has none,
   * and the branch stays in it), the branch the remote's HEAD names, which the request targets (null
   * when it names none), and the request's title and description. The top-level `branch` and
   * `request` stay null for such a run.
   */
  /** `pushed` false: the branch is in the person's repository alone, the request's words kept for when they push it; absent reads as pushed. */
  repos?: { path: string; branch: string; head: string; baseSha: string; origin: string | null; target?: string | null; request: { title: string; body: string } | null; pushed?: boolean }[];
  /** What a run in a folder changed there, as the machine's shadow recorded it: paths and counts, never the files' content. */
  changes?: { before: string; after: string; files: ChangedFile[]; undone?: { kept: string[] } | null } | null;
}

/**
 * How a runner talks to its orchestrator. A local orchestrator hands its embedded runner one
 * that calls the same functions its runner routes call, in the same process and with no token;
 * a team's or the cloud's is reached over HTTP. Every call on a task carries the lease, and a
 * call whose lease is no longer the task's is refused, so a runner that lost its task cannot
 * write to it.
 */
export interface RunnerLink {
  /**
   * Waits up to `waitMs` for a task to lease or a command, and returns as soon as either is
   * there. A runner already running a task says so with `canTake` false and gets commands only.
   * An aborted poll gives up its wait and takes no lease.
   */
  poll(waitMs: number, canTake: boolean, signal: AbortSignal): Promise<{ lease: Lease | null; commands: RunnerCommand[]; folders?: FolderAsk[]; undos?: UndoAsk[]; lessons?: LessonAsk[]; checks?: ChecksAsk[]; lessonOps?: LessonOpAsk[]; pushes?: PushAsk[] }>;
  /** False once the lease is no longer this runner's. */
  renew(taskId: string, leaseId: string): Promise<boolean>;
  events(taskId: string, leaseId: string, events: NumberedEvent[]): Promise<void>;
  request(taskId: string, leaseId: string, request: AgentRequest): Promise<void>;
  progress(taskId: string, leaseId: string, progress: TaskProgress): Promise<void>;
  finish(taskId: string, leaseId: string, outcome: TaskOutcome): Promise<void>;
  /**
   * A request the machine opened with the person's own gh or glab, for the orchestrator to check on
   * the forge before it counts as the task's; reported before the finish, which gives the lease up.
   * Absent on the runner inside a local orchestrator, which opens the request itself.
   */
  forgeRequest?(taskId: string, leaseId: string, opened: OpenedRequest): Promise<RequestVerdict>;
  /** What the machine's agents are, for its row under Settings; absent on the runner inside a local orchestrator, which checks them itself. */
  status?(agents: MachineAgentStatus[], started?: boolean): Promise<void>;
  /** The answer to one folder list a poll asked for; absent on the runner inside a local orchestrator, whose screen lists its folders itself. */
  folders?(nonce: string, answer: FolderAnswer): Promise<void>;
  /** The answer to one undo a poll asked for; absent on the runner inside a local orchestrator, which undoes in its own folders. */
  undo?(nonce: string, answer: UndoAnswer): Promise<void>;
  /** The answer to one lesson a poll handed; absent on the runner inside a local orchestrator, which writes its person's queue itself. */
  lesson?(nonce: string, answer: LessonAnswer): Promise<void>;
  /** The answer to one folder project's checks a poll asked for; absent on the runner inside a local orchestrator, which reads its folders itself. */
  checks?(nonce: string, answer: ChecksAnswer): Promise<void>;
  /** The answer to one read or decision of a lesson a poll handed; absent on the runner inside a local orchestrator. */
  lessonOp?(nonce: string, answer: LessonOpAnswer): Promise<void>;
  push?(nonce: string, answer: PushAnswer): Promise<void>;
  /** That these follow-ups reached the agent, so none is handed or shown as waiting again. */
  followUpsDelivered?(taskId: string, leaseId: string, ids: string[]): Promise<void>;
  /** One of the task's attachments, its bytes, for a machine away from the orchestrator. */
  attachment?(taskId: string, leaseId: string, attachmentId: string): Promise<Uint8Array>;
}

export interface OpenedRequest {
  number: number;
  url: string;
  headSha: string;
}

/** `ok`: the forge shows the person's request from the task's branch; `unverified`: the orchestrator did not reach the forge; otherwise refused, with why. */
export type RequestVerdict = { ok: true; number: number; url: string } | { ok: false; reason: string; unverified?: true };
