import type { CommandReceipt } from "./effects.js";
import type { AgentEvent } from "./tasks/adapters/contract.js";
import type { TaskCost, TaskRecord, TaskStage, TestOutcome } from "./tasks/types.js";

/** What a machine reports of one agent CLI on it; the account it is signed in with never leaves the machine. */
export interface MachineAgentStatus {
  id: string;
  installed: boolean;
  version: string | null;
  supported: "ok" | "update";
  signIn: "signed-in" | "signed-out" | "unknown";
}

/** A person's own machine, connected with a one-time code, that runs their tasks with their own agent sign-in. */
export interface MachineRecord {
  tenant: string;
  id: string;
  userId: string;
  name: string;
  platform: string;
  /** The machine's Ed25519 public key; every request it makes is signed by the key only the machine holds. */
  publicKey: string;
  agents: MachineAgentStatus[];
  /** What of the work the orchestrator hands out the machine's runner says it understands; a runner from before it says none. */
  features?: MachineFeature[];
  createdAt: string;
  lastSeenAt: string | null;
  revokedAt: string | null;
}

/** A part of the work a runner understands only from some version on; the orchestrator offers what needs it only to a machine that lists it. */
export const MACHINE_FEATURES = ["workspace-continues"] as const;
export type MachineFeature = (typeof MACHINE_FEATURES)[number];

export interface PairingRecord {
  tenant: string;
  codeHash: string;
  userId: string;
  expiresAt: string;
}

/** What only the runner holding a task reads of it; the lease id is its fencing token and never reaches a browser. */
export interface TaskLease {
  runner: "local" | "server";
  claimedBy: string | null;
  leaseId: string | null;
  leaseUntil: string | null;
  /** The agent's own session id, so Continue resumes the same conversation on the same machine. */
  nativeSession: string | null;
  /** The branch the runner reported it pushes to; a request it reports is held to this one. */
  branch: string | null;
  /** When the run that holds it now started. */
  runStartedAt?: string | null;
}

/** An event as the store keeps it, numbered by the runner per task so a resent batch writes nothing twice: its kind, the line the log shows, and the masked event itself. */
export interface RunnerEventRow {
  n: number;
  kind: RunnerEvent["type"];
  text: string;
  data: RunnerEvent;
}

/** What a runner reports of a task: the agent's own events, the orchestrator's own lines as `log`, and each follow-up as it reached the agent as `steer`. */
export type RunnerEvent = AgentEvent | { type: "log"; text: string } | { type: "steer"; text: string; by: string };

/** What the orchestrator's progress on a leased task changes; `addCost` is added to what the task already spent. */
export interface LeasedTaskPatch {
  stage?: TaskStage;
  baseSha?: string;
  branch?: string;
  tests?: TestOutcome;
  addCost?: TaskCost;
  /** The agent's estimate of the turn it is in, in dollars, kept until the turn's own cost comes and added to it when the run is cut off first. */
  turnEstimate?: number;
  /** The agent's session id, recorded before the agent starts, so Continue after a crash resumes it. */
  nativeSession?: string;
}

export interface LeasedTaskEnd {
  status: "needs-review" | "failed" | "interrupted";
  error: string | null;
  nativeSession: string | null;
  branch: string | null;
  /** For a run cut off at its plan's usage limit: when the limit resets, already checked to be near and ahead. */
  limitResetAt?: string | null;
  /** How long the agent worked in this run, its cards' waits left out; added to what earlier runs worked. */
  ranMs?: number;
}

export interface RunnerStore {
  savePairing(pairing: PairingRecord): Promise<void>;
  /** Takes a pairing code once, while it is unused and unexpired; null otherwise. */
  takePairing(tenant: string, codeHash: string, now: string): Promise<{ userId: string } | null>;
  countOpenPairings(tenant: string, userId: string, now: string): Promise<number>;
  /** Keeps the machine while the organization connects fewer than `runners`, counted in the same transaction; false when full. */
  insertMachine(machine: MachineRecord & { tokenHash: string }, runners: number | null): Promise<boolean>;
  /** The connected machine a device token names, with its organization; null for an unknown or revoked one. */
  machineByToken(tokenHash: string): Promise<MachineRecord | null>;
  /** One person's machines, or the organization's when `userId` is null, revoked ones included. */
  listMachines(tenant: string, userId: string | null): Promise<MachineRecord[]>;
  /** Revokes the machine and interrupts the tasks it holds in the same transaction; false when there was none to revoke. */
  revokeMachine(tenant: string, id: string, at: string): Promise<boolean>;
  touchMachine(tenant: string, id: string, at: string, agents?: readonly MachineAgentStatus[], features?: readonly MachineFeature[]): Promise<void>;
  /** Records a signed request's nonce until `until`; false when the machine used it already. */
  takeNonce(tenant: string, machineId: string, nonce: string, until: string): Promise<boolean>;
  /** Deletes nonces past their time and pairings used or expired. */
  pruneRunnerRows(now: string): Promise<number>;

  /**
   * Leases the oldest queued task this person started to run on their own machine, and gives the
   * number its next event takes; null when none waits, or the organization runs `concurrent`
   * tasks already, counted in the same transaction.
   */
  claimLocalTask(tenant: string, person: string, holder: string, leaseId: string, until: string, now: string, concurrent?: number | null): Promise<{ task: TaskRecord; nextEvent: number } | null>;
  /** Extends a lease still held and unexpired; false when the lease is gone, which ends the run. */
  renewLease(tenant: string, taskId: string, leaseId: string, until: string, now: string): Promise<boolean>;
  /** The tasks this holder leases now, with their leases and whether someone asked to stop each. */
  heldTasks(tenant: string, holder: string, now: string): Promise<{ taskId: string; leaseId: string; stopRequested: boolean }[]>;
  /** Cancels a local task no runner holds, queued or interrupted, with its open questions; false when it was not such a task, as when a machine claimed it first. */
  cancelLocalTask(tenant: string, taskId: string, at: string): Promise<boolean>;
  /** Puts an interrupted task no runner holds back in line, its machine and session kept, with the caller's receipt, if any, in the same write; false when it was not such a task. */
  continueLocalTask(tenant: string, taskId: string, receipt: Pick<CommandReceipt, "actorId" | "commandId" | "kind" | "result"> | null, at: string): Promise<boolean>;
  /** Interrupted tasks on a machine waiting for a usage limit that resets at or before `before`: when, when the limit was hit, and how many times one went on by itself. */
  limitedTasks(tenant: string, before: string): Promise<{ taskId: string; resetAt: string; limitAt: string | null; goneOn: number }[]>;
  /** Lets go of the reset the task waits for, so nothing puts it back in line for it; false when it waits for another or none. */
  dropLimit(tenant: string, taskId: string, resetAt: string): Promise<boolean>;
  /** Puts the task waiting for this reset back in line, counted and marked as going on after the limit; false when it no longer waits for it. */
  continueAfterLimit(tenant: string, taskId: string, resetAt: string): Promise<boolean>;
  /** Whether the task's run being handed out goes on after a usage limit reset; true once per such going on. */
  takeLimitContinue(tenant: string, taskId: string): Promise<boolean>;
  /** Asks the runner holding the task to stop it, until the run ends; false when no runner holds it. A `reason` (a limit's) becomes the task's error when the run ends. */
  requestStop(tenant: string, taskId: string, at: string, reason?: string | null): Promise<boolean>;
  /** Keeps each event once by its number; false when the lease is not the task's. */
  appendRunnerEvents(tenant: string, taskId: string, leaseId: string, events: readonly RunnerEventRow[]): Promise<boolean>;
  /** Applies the patch only while the lease holds; false when it does not. */
  updateLeasedTask(tenant: string, taskId: string, leaseId: string, patch: LeasedTaskPatch): Promise<boolean>;
  /** Ends the task as the runner reports it and gives the lease up in one write; false when the lease did not hold. */
  finishLeasedTask(tenant: string, taskId: string, leaseId: string, end: LeasedTaskEnd, now: string): Promise<boolean>;
  /** Leases past `now`: a local task becomes interrupted and waits for Continue, the orchestrator's own fails. */
  expireLeases(now: string): Promise<{ interrupted: number; failed: number }>;
  taskLease(tenant: string, taskId: string): Promise<TaskLease | null>;
}
