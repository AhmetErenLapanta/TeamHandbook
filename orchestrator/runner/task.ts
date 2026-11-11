import type { AgentAnswers, AgentRequest, Decision } from "../server/tasks/adapters/contract.js";
import type { Lease, NumberedEvent, OpenedRequest, RelayedFollowUp, RequestVerdict, RunnerCommand, RunnerEvent, RunnerLink, RunnerTask, TaskOutcome, TaskProgress } from "./link.js";
import { MachineRefused, NotTaken, ProtocolMismatch } from "./http-link.js";
import { maskEvent, maskOutcome, maskRequest } from "./mask.js";
import type { RunnerState } from "./state.js";

/** How often a runner renews the lease on the task it runs: three tries inside one lease. */
export const RENEW_MS = 20_000;
/**
 * How long a runner keeps its agent going without a renewal it could make. The orchestrator
 * cannot stop a push made with the person's own credentials, so the runner stops itself well
 * inside the 90 seconds after which the orchestrator gives the task up.
 */
export const FENCE_MS = 60_000;
const unlessNotTaken = (error: unknown) => {
  if (!(error instanceof NotTaken)) throw error;
};

const refusedForGood = (error: unknown) => error instanceof MachineRefused || error instanceof ProtocolMismatch;

/** How long events gather before they are sent together. */
export const FLUSH_MS = 500;

export interface ExecutorHooks {
  /** Aborted when the task has to stop now: a Stop, or a lease this runner no longer holds. */
  signal: AbortSignal;
  onEvent(event: RunnerEvent): void;
  /** One of the orchestrator's own lines about the run, for the task's log. */
  log(text: string): void;
  record(progress: TaskProgress): void;
  /** The agent's process group and the directory it works in, so a later start ends what a crash left running. */
  onProcess(pgid: number, root: string): void;
  /** Waits for the person's answer to what the agent asked. */
  decide(request: AgentRequest): Promise<{ decision: Decision; note?: string; answers?: AgentAnswers; plan?: string }>;
  /** Asked right before anything leaves the machine for the forge: true only while the lease is still this runner's. */
  leaseHeld(): Promise<boolean>;
  /** Hands the orchestrator a request this machine opened on the forge; a runner whose orchestrator opens the request itself refuses it. */
  reportRequest?(opened: OpenedRequest): Promise<RequestVerdict>;
  /** The follow-ups the person sent while the task runs, oldest first, not yet handed to the agent; absent where none is relayed. */
  followUps?(): RelayedFollowUp[];
  /** That these reached the agent: they are not handed again, and the orchestrator stops showing them as waiting. */
  delivered?(ids: readonly string[]): void;
  attachment?(id: string): Promise<Uint8Array>;
}

/** Runs one leased task: checkout, agent, tests and push, through the hooks. */
export interface TaskExecutor {
  run(task: RunnerTask, hooks: ExecutorHooks): Promise<TaskOutcome>;
}

export interface LeasedTask {
  readonly taskId: string;
  command(command: RunnerCommand): void;
  /** Stops the agent because this runner is shutting down; the outcome is still reported. */
  shutDown(): void;
  /** The outcome, and whether the orchestrator was told it; a runner that lost the lease tells nobody. */
  readonly done: Promise<{ outcome: TaskOutcome; reported: boolean }>;
}

export interface TaskOptions {
  mask: (text: string) => string;
  state?: RunnerState;
  now?: () => number;
}

export const LOST_LEASE = "This machine lost the task's lease; the orchestrator holds it as interrupted.";
export const STOPPED = "Stopped by the person who started the task.";
export const SHUT_DOWN = "The task stopped when its runner stopped; Continue picks it up again.";

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function runLeasedTask(lease: Lease, link: RunnerLink, executor: TaskExecutor, { mask, state, now = Date.now }: TaskOptions): LeasedTask {
  const { task, leaseId } = lease;
  const stop = new AbortController();
  let lost = false;
  let lastRenewed = now();
  let next = lease.nextEvent;
  let pending: NumberedEvent[] = [];
  const progress: TaskProgress[] = [];
  let sending: Promise<void> | null = null;
  const followUps: RelayedFollowUp[] = [];
  const answers = new Map<string, (answer: { decision: Decision; note?: string; answers?: AgentAnswers; plan?: string }) => void>();

  const loseLease = () => {
    if (lost) return;
    lost = true;
    stop.abort(new Error(LOST_LEASE));
  };

  const renew = async (): Promise<boolean> => {
    if (lost) return false;
    try {
      if (await link.renew(task.id, leaseId)) {
        lastRenewed = now();
        return true;
      }
      loseLease();
      return false;
    } catch (error) {
      if (refusedForGood(error) || now() - lastRenewed >= FENCE_MS) loseLease();
      return false;
    }
  };

  const send = async (): Promise<void> => {
    const batch = pending;
    if (batch.length) {
      await link.events(task.id, leaseId, batch).catch(unlessNotTaken);
      pending = pending.slice(batch.length);
    }
    while (progress.length) {
      await link.progress(task.id, leaseId, progress[0]!).catch(unlessNotTaken);
      progress.shift();
    }
  };

  /** Sends what has gathered, one send at a time; what fails stays, in order, for the next one. */
  const flush = (): Promise<void> => {
    if (lost) return Promise.resolve();
    sending ??= send()
      .catch(() => undefined)
      .finally(() => (sending = null));
    return sending;
  };

  const heartbeat = setInterval(() => void renew(), RENEW_MS);
  const flusher = setInterval(() => void flush(), FLUSH_MS);

  const hooks: ExecutorHooks = {
    signal: stop.signal,
    onEvent(event) {
      const masked = maskEvent(event, mask);
      if (masked) pending.push({ n: next++, event: masked });
    },
    log(text) {
      pending.push({ n: next++, event: { type: "log", text: mask(text) } });
    },
    record(patch) {
      progress.push(patch);
    },
    onProcess(pgid, root) {
      state?.add({ taskId: task.id, pgid, root });
    },
    followUps: () => [...followUps],
    delivered(ids) {
      const reached = followUps.filter((f) => ids.includes(f.id)).map((f) => f.id);
      for (const id of reached) followUps.splice(followUps.findIndex((f) => f.id === id), 1);
      // A mark that does not go through leaves the follow-up shown as waiting; it is not handed to the agent twice.
      if (reached.length && link.followUpsDelivered) void link.followUpsDelivered(task.id, leaseId, reached).catch(() => {});
    },
    ...(link.attachment ? { attachment: (id: string) => link.attachment!(task.id, leaseId, id) } : {}),
    async decide(request) {
      const answered = new Promise<{ decision: Decision; note?: string }>((resolve, reject) => {
        answers.set(request.id, resolve);
        stop.signal.addEventListener("abort", () => reject(stop.signal.reason), { once: true });
      });
      while (!stop.signal.aborted) {
        try {
          await link.request(task.id, leaseId, maskRequest(request, mask));
          break;
        } catch (error) {
          if (error instanceof NotTaken) {
            answers.delete(request.id);
            return { decision: "deny" };
          }
          await delay(FLUSH_MS);
        }
      }
      return answered;
    },
    async leaseHeld() {
      return !stop.signal.aborted && (await renew());
    },
    async reportRequest(opened) {
      if (!link.forgeRequest) throw new Error("this runner's orchestrator opens the request itself");
      await flush();
      return link.forgeRequest(task.id, leaseId, opened);
    },
  };

  const done = (async () => {
    let outcome: TaskOutcome;
    try {
      outcome = maskOutcome(await executor.run(task, hooks), mask);
    } catch (error) {
      outcome = { status: "failed", error: error instanceof Error ? error.message : String(error), nativeSessionId: null, branch: null, position: null, request: null };
    }
    state?.remove(task.id);
    // The heartbeat runs until the orchestrator has the outcome: an outage while the last events
    // go out ends in the same fence as one while the agent runs, never in a loop that holds on.
    try {
      while (!lost) {
        await flush();
        if (!pending.length && !progress.length) {
          try {
            await link.finish(task.id, leaseId, outcome);
            return { outcome, reported: true };
          } catch (error) {
            if (refusedForGood(error)) loseLease();
            await delay(FLUSH_MS);
            continue;
          }
        }
        await delay(FLUSH_MS);
      }
      return { outcome: { ...outcome, status: "interrupted" as const, error: LOST_LEASE }, reported: false };
    } finally {
      clearInterval(heartbeat);
      clearInterval(flusher);
    }
  })();

  return {
    taskId: task.id,
    command(command) {
      if (command.taskId !== task.id) return;
      if (command.type === "stop") stop.abort(new Error(STOPPED));
      else if (command.type === "follow_up") {
        if (!followUps.some((f) => f.id === command.followUp.id)) followUps.push(command.followUp);
      } else {
        const resolve = answers.get(command.requestId);
        answers.delete(command.requestId);
        resolve?.({ decision: command.decision, ...(command.note === undefined ? {} : { note: command.note }), ...(command.answers ? { answers: command.answers } : {}), ...(command.plan === undefined ? {} : { plan: command.plan }) });
      }
    },
    shutDown() {
      stop.abort(new Error(SHUT_DOWN));
    },
    done,
  };
}
