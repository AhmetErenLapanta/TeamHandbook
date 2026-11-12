import type { AgentRequest } from "../server/tasks/adapters/contract.js";
import type { ChecksAnswer, ChecksAsk, FolderAnswer, FolderAsk, LessonAnswer, LessonAsk, LessonOpAnswer, LessonOpAsk, PushAnswer, PushAsk, UndoAnswer, UndoAsk, Lease, NumberedEvent, RunnerCommand, TaskOutcome, TaskProgress } from "../runner/link.js";
import type { MachineAgentStatus } from "../server/runner-store.js";

export { RUNNER_PROTOCOL, SIGNATURE_HEADER } from "../server/runner-auth.js";

/**
 * How a machine's runner reaches a team's or the cloud's orchestrator over HTTP: the paths, the
 * bodies and the limits, read by the routes and by the runner's client alike, so the two ends
 * cannot drift. Every call but hello and claim is signed and carries the protocol header; a call
 * on a task names its lease, and one whose lease is no longer the task's answers 404. A request
 * the runner opened is reported before the finish: the finish gives the lease up, and a report
 * after it is refused as from a runner that no longer holds the task.
 */

/** The protocol this end speaks, on every signed call; a mismatch answers 426 with which side to update. */
export const PROTOCOL_HEADER = "x-runner-protocol";

/** The longest a poll waits for a lease or a command before it answers with neither. */
export const POLL_WAIT_MAX_MS = 25_000;

/** A batch of events at most, by count and by size, inside the 1 MB a proxy in front takes, with room for escaping. */
export const EVENTS_PER_BATCH = 500;
export const BATCH_BYTES = 512 * 1024;

/** The live task's limits (CANLI-GOREV-sozlesme.md): a command, an output's last lines, a patch's first lines, a to-do list. */
export const COMMAND_MAX = 300;
/** The most of a plan an agent puts to its person, or that they send back changed: a plan, not a document. */
export const PLAN_TEXT_MAX = 20_000;
/** The call id a run's own test command reports its output under, apart from the agent's calls. */
export const TESTS_OUTPUT = "tests";
export const OUTPUT_LINES_MAX = 200;
export const OUTPUT_LINE_MAX = 2_000;
export const PATCH_LINES_MAX = 40;
export const TODOS_MAX = 30;
export const TODO_TEXT_MAX = 200;

/** The most any one call carries, refused before its signature is read, as a proxy in front refuses at the same size. */
export const CALL_BYTES = 1024 * 1024;

export const RUNNER_PATHS = {
  hello: "/api/runner/hello",
  claim: "/api/runner/claim",
  /** The machine disconnects itself: the orchestrator revokes it, so its token works nowhere after. */
  disconnect: "/api/runner/disconnect",
  poll: "/api/runner/poll",
  /** What the machine says of its agents, at start and every few minutes: words only, never an account. */
  status: "/api/runner/status",
  renew: (taskId: string) => `/api/runner/tasks/${taskId}/renew`,
  events: (taskId: string) => `/api/runner/tasks/${taskId}/events`,
  agentRequest: (taskId: string) => `/api/runner/tasks/${taskId}/requests`,
  progress: (taskId: string) => `/api/runner/tasks/${taskId}/progress`,
  forgeRequest: (taskId: string) => `/api/runner/tasks/${taskId}/request`,
  finish: (taskId: string) => `/api/runner/tasks/${taskId}/finish`,
  /** The follow-ups that reached the task's agent. */
  followUpsDelivered: (taskId: string) => `/api/runner/tasks/${taskId}/follow-ups`,
  /** One of the task's attachments, its bytes, for the machine to put in the task's own folder. */
  attachment: (taskId: string, attachmentId: string) => `/api/runner/tasks/${taskId}/attachments/${attachmentId}`,
  /** The machine's answer to one folder list its person's screen asked it for. */
  folders: (nonce: string) => `/api/runner/folders/${nonce}`,
  /** The machine's answer to one undo of a task's change in one of its folders. */
  undo: (nonce: string) => `/api/runner/undos/${nonce}`,
  /** The machine's answer to one lesson it was handed for its person's review queue. */
  lessons: (nonce: string) => `/api/runner/lessons/${nonce}`,
  /** The machine's reading of one folder project's checks. */
  checks: (nonce: string) => `/api/runner/checks/${nonce}`,
  /** The machine's answer to one read or decision of a lesson its person asked for on a task's page. */
  lessonOps: (nonce: string) => `/api/runner/lesson-ops/${nonce}`,
  pushes: (nonce: string) => `/api/runner/pushes/${nonce}`,
} as const;

export interface HelloAnswer {
  protocol: number;
  org: string;
}

export interface ClaimBody {
  code: string;
  name: string;
  platform: string;
  /** The machine's Ed25519 public key, its 32 raw bytes in base64url. */
  publicKey: string;
}

export interface ClaimAnswer {
  machineId: string;
  token: string;
}

/** The answer to a call from the other side's protocol: which side is older and has to be updated. */
export interface ProtocolRefusal {
  error: string;
  update: "runner" | "orchestrator";
}

export interface StatusBody {
  agents: MachineAgentStatus[];
  started?: true;
  features?: string[];
}

/** The most agents one machine reports. */
export const AGENTS_MAX = 8;

export interface PollBody {
  waitMs: number;
  /** False while the runner runs a task: it is handed commands only. */
  canTake: boolean;
}

export interface PollAnswer {
  lease: Lease | null;
  commands: RunnerCommand[];
  /** Folder lists the machine's person asked for on the orchestrator's screen; absent from an orchestrator that asks none. */
  folders?: FolderAsk[];
  /** Undos of a task's change in a folder of the machine its person asked for; absent from an orchestrator that asks none. */
  undos?: UndoAsk[];
  /** Lessons from its person's tasks, for their own review queue; absent from an orchestrator that sends none. */
  lessons?: LessonAsk[];
  /** Folder projects whose checks the orchestrator's screen asks this machine to read. */
  checks?: ChecksAsk[];
  /** Reads and decisions of its person's lessons they asked for on a task's page. */
  lessonOps?: LessonOpAsk[];
  pushes?: PushAsk[];
}

export interface LeaseBody {
  leaseId: string;
}

export interface RenewAnswer {
  held: boolean;
}

export interface EventsBody extends LeaseBody {
  events: NumberedEvent[];
}

export interface AgentRequestBody extends LeaseBody {
  request: AgentRequest;
}

export interface ProgressBody extends LeaseBody {
  progress: TaskProgress;
}

/** A request the runner opened with the person's own gh or glab, for the orchestrator to check on the forge. */
export interface ForgeRequestBody extends LeaseBody {
  number: number;
  /** Shown as opened but not verified when the orchestrator does not reach the forge. */
  url: string;
  headSha: string;
}

/** `ok`: the forge shows the person's request from the task's branch. `unverified`: the orchestrator did not reach the forge, so it is shown as the runner reported it. Otherwise refused, with why. */
export type ForgeRequestAnswer = { ok: true; number: number; url: string } | { ok: false; reason: string; unverified?: true };

/**
 * A machine's folder list crosses the wire with every path from its home as `~`: the operator
 * reads no account name off it. The machine checks each folder by its own rule, with its own home
 * and data folder, and never by what the orchestrator sent; a path it is later given for a task is
 * checked by that rule again there.
 */
export interface FoldersBody {
  answer: FolderAnswer;
}

export interface UndoBody {
  answer: UndoAnswer;
}

export interface LessonBody {
  answer: LessonAnswer;
}

export interface ChecksBody {
  answer: ChecksAnswer;
}

export interface LessonOpBody {
  answer: LessonOpAnswer;
}

export interface PushBody {
  answer: PushAnswer;
}

/** The most folders one answer lists, across folders, suggestions and matches, as the local list stops at. */
export const FOLDER_ENTRIES_MAX = 500;
/** The longest name or path in an answer, and the most markers one folder carries. */
export const FOLDER_TEXT_MAX = 1024;
export const FOLDER_MARKERS_MAX = 16;

export interface FollowUpsDeliveredBody extends LeaseBody {
  ids: string[];
}

export interface FinishBody extends LeaseBody {
  outcome: TaskOutcome;
}
