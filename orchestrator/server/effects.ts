import type { OrchestratorEvent } from "./events.js";
import { inBackground } from "./forge/http.js";
import { redactLine } from "./log.js";
import { metrics } from "./metrics.js";
import type { Metrics } from "./metrics.js";
import type { TaskPatch, TaskRecord } from "./tasks/types.js";

/**
 * What a restart does to an effect: a process-bound one belonged to the process that queued it
 * (an agent turn it was driving) and is cancelled, a replay-safe one (a push, a request opened
 * once, a clean-up) is taken up again.
 */
export type EffectReplay = "process-bound" | "replay-safe";
export type EffectStatus = "pending" | "done" | "failed" | "cancelled";

export interface EffectInput {
  kind: string;
  /** Names and references only: a payload that looks like it holds a secret is refused, not stored. */
  payload: Record<string, unknown>;
  replay: EffectReplay;
}

/** A side effect of a task, written with the command that asked for it and carried out after it committed. */
export interface EffectRecord {
  tenant: string;
  id: string;
  taskId: string;
  /** Its place among the task's effects; one runs only once every earlier one has settled. */
  seq: number;
  kind: string;
  payload: Record<string, unknown>;
  replay: EffectReplay;
  status: EffectStatus;
  attempts: number;
  claimedBy: string | null;
  leaseUntil: string | null;
  dueAt: string;
  lastError: string | null;
  result: string | null;
  createdAt: string;
  settledAt: string | null;
}

/** A command's answer, kept under the id its caller sent, so the same command again gets this back and does nothing. */
export interface CommandReceipt {
  tenant: string;
  actorId: string;
  commandId: string;
  kind: string;
  taskId: string;
  result: string;
  createdAt: string;
}

export interface TaskCommand {
  tenant: string;
  taskId: string;
  at: string;
  receipt?: Pick<CommandReceipt, "actorId" | "commandId" | "kind" | "result">;
  /** The task the command creates, written in the same transaction as its effects. */
  createTask?: TaskRecord;
  taskPatch?: TaskPatch;
  events?: OrchestratorEvent[];
  effects?: EffectInput[];
}

export type EffectOutcome = { done: string | null } | { retryAt: string; error: string } | { failed: string };

export interface EffectStore {
  /**
   * The command's task write, events, effects and receipt in one transaction. A receipt already
   * kept for the same actor and command id comes back with `replayed` and nothing is written.
   */
  commitCommand(command: TaskCommand): Promise<{ replayed: boolean; receipt: CommandReceipt | null; effects: EffectRecord[] }>;
  getReceipt(tenant: string, actorId: string, commandId: string): Promise<CommandReceipt | null>;
  /** The oldest due effect whose task has no earlier one unsettled, leased to `by` until `until`; null when none is. */
  claimEffect(by: string, now: string, until: string, tenants?: readonly string[]): Promise<EffectRecord | null>;
  /** False once the lease is someone else's or the effect has settled. */
  renewEffect(tenant: string, id: string, by: string, until: string): Promise<boolean>;
  /** Settles an effect its holder still holds: done, back to pending at a later time, or failed; false otherwise. */
  settleEffect(tenant: string, id: string, by: string, outcome: EffectOutcome, now: string): Promise<boolean>;
  taskEffects(tenant: string, taskId: string): Promise<EffectRecord[]>;
  /** After a restart: a tenant's pending process-bound effects are cancelled and replay-safe ones lose their lease. */
  recoverEffects(tenant: string, now: string): Promise<{ cancelled: number; requeued: number }>;
  /** Deletes at most `limit` effects done or cancelled before `before`, the oldest first; failed ones stay for whoever looks into them. */
  pruneEffects(before: string, limit: number): Promise<number>;
}

/** Carries out one kind of effect and says what came of it; throwing retries it unless it throws an EffectRefused. */
export type EffectHandler = (effect: EffectRecord) => Promise<string | null>;

/** A failure another attempt cannot change, such as a request the forge says is gone: the effect fails at once. */
export class EffectRefused extends Error {}

export interface EffectWorkerOptions {
  store: EffectStore;
  handlers: Readonly<Record<string, EffectHandler>>;
  /** Who holds what this worker claims, unique per process. */
  by: string;
  /** The organizations whose effects this worker carries out. */
  tenants: () => readonly string[];
  concurrency?: number;
  leaseMs?: number;
  maxAttempts?: number;
  idleMs?: number;
  now?: () => Date;
  counted?: Metrics;
}

/** The wait before attempt n + 1: 100 ms doubling, at most 30 s. */
export function retryDelayMs(attempts: number): number {
  return Math.min(30_000, 100 * 2 ** Math.max(0, attempts - 1));
}

/**
 * Carries out effects as they come due, `concurrency` at a time, each under a lease it renews
 * while its handler runs. An effect is tried `maxAttempts` times with a growing wait between,
 * and fails at once when its handler refuses it or no handler knows its kind.
 */
export function effectWorker(options: EffectWorkerOptions): { start: () => void; stop: () => Promise<void>; drain: () => Promise<number> } {
  const { store, handlers, by } = options;
  const leaseMs = options.leaseMs ?? 30_000;
  const maxAttempts = options.maxAttempts ?? 5;
  const now = options.now ?? (() => new Date());
  const counted = options.counted ?? metrics;
  let running = false;
  let loops: Promise<void>[] = [];

  const settle = async (effect: EffectRecord, outcome: EffectOutcome, label: string) => {
    if (await store.settleEffect(effect.tenant, effect.id, by, outcome, now().toISOString())) counted.effectSettled(effect.kind, label);
  };

  /** Claims and carries out one effect; false when none was due. */
  const once = async (): Promise<boolean> => {
    const at = now();
    const effect = await store.claimEffect(by, at.toISOString(), new Date(at.getTime() + leaseMs).toISOString(), options.tenants());
    if (!effect) return false;
    const handler = handlers[effect.kind];
    if (!handler) {
      await settle(effect, { failed: `no handler carries out ${effect.kind} effects` }, "failed");
      return true;
    }
    const renew = setInterval(() => void store.renewEffect(effect.tenant, effect.id, by, new Date(now().getTime() + leaseMs).toISOString()).catch(() => undefined), Math.max(1000, leaseMs / 2));
    try {
      // An effect runs after the command that asked for it, with nobody waiting on it.
      const result = await inBackground(() => handler(effect));
      await settle(effect, { done: result === null ? null : redactLine(result) }, "done");
    } catch (err) {
      // Kept in the effect's row, so it is masked as a log line is: a forge's answer repeats what it was sent.
      const error = redactLine((err as Error).message);
      if (err instanceof EffectRefused || effect.attempts >= maxAttempts) await settle(effect, { failed: error }, "failed");
      else await settle(effect, { retryAt: new Date(now().getTime() + retryDelayMs(effect.attempts)).toISOString(), error }, "retried");
    } finally {
      clearInterval(renew);
    }
    return true;
  };

  const loop = async () => {
    while (running) {
      const worked = await once().catch(() => false);
      if (!worked && running) await new Promise((resolve) => setTimeout(resolve, options.idleMs ?? 1000));
    }
  };

  return {
    start() {
      if (running) return;
      running = true;
      loops = Array.from({ length: options.concurrency ?? 4 }, loop);
    },
    async stop() {
      running = false;
      await Promise.all(loops);
      loops = [];
    },
    async drain() {
      let done = 0;
      while (await once()) done += 1;
      return done;
    },
  };
}
