import type { OrchestratorContext } from "../app.js";
import { principalOf } from "../accounts.js";
import { newId } from "../ids.js";
import { suspended } from "../scim.js";
import type { TaskRunner } from "./runner.js";
import { startTask } from "./routes.js";

/** When a repeat runs: every day, every weekday, or one day of the week, at a time of day on this machine's clock. */
export type RepeatEvery = "day" | "weekday" | "monday" | "tuesday" | "wednesday" | "thursday" | "friday" | "saturday" | "sunday";

/** A task its person asked to start again on a schedule, at most once a day. */
export interface TaskRepeat {
  tenant: string;
  id: string;
  createdBy: string;
  /** The start it repeats, as POST /api/tasks took it, less the repeat itself. */
  start: Record<string, unknown>;
  title: string;
  every: RepeatEvery;
  /** HH:MM on this machine's clock. */
  at: string;
  createdAt: string;
  /** The run time it last reached, run or skipped. */
  lastAt: string | null;
  skipped: { at: string; reason: string } | null;
  stoppedAt: string | null;
}

export interface RepeatStore {
  addRepeat(repeat: TaskRepeat): Promise<void>;
  listRepeats(tenant: string): Promise<TaskRepeat[]>;
  /** Moves a repeat on to the run time it reached; `skipped` when that run did not happen. */
  reachRepeat(tenant: string, id: string, at: string, skipped: { at: string; reason: string } | null): Promise<void>;
  stopRepeat(tenant: string, id: string, at: string): Promise<boolean>;
}

const DAYS: Record<string, number> = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };
const EVERY = new Set<string>(["day", "weekday", ...Object.keys(DAYS)]);
const AT = /^([01]\d|2[0-3]):([0-5]\d)$/;
/** The most repeats a person keeps at once: each starts a task a day, so this is the most a day's schedule starts. */
export const REPEATS_MAX = 20;
/** How late a run may start after its time, as the minute tick goes; later than that it was missed. */
const LATE_MS = 2 * 60_000;

/** The repeat a start asks for, or why it is not one. */
export function readRepeat(value: unknown): { every: RepeatEvery; at: string } | { error: string } {
  const r = value as { every?: unknown; at?: unknown } | null;
  if (!r || typeof r !== "object" || typeof r.every !== "string" || !EVERY.has(r.every) || typeof r.at !== "string" || !AT.test(r.at)) return { error: "repeat is { every: day, weekday or a day of the week, at: HH:MM }" };
  return { every: r.every as RepeatEvery, at: r.at };
}

const runsOn = (every: RepeatEvery, day: number) => every === "day" || (every === "weekday" ? day >= 1 && day <= 5 : DAYS[every] === day);

/** The repeat's run times on this machine's clock: the last one at or before `now`, and the first one after it. */
export function runTimes(repeat: Pick<TaskRepeat, "every" | "at">, now: Date): { last: Date | null; next: Date } {
  const [hours, minutes] = repeat.at.split(":").map(Number) as [number, number];
  const on = (offset: number) => {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset, hours, minutes, 0, 0);
    return runsOn(repeat.every, d.getDay()) ? d : null;
  };
  let last: Date | null = null;
  for (let offset = 0; offset >= -7 && !last; offset--) {
    const d = on(offset);
    if (d && d <= now) last = d;
  }
  let next: Date | null = null;
  for (let offset = 0; offset <= 8 && !next; offset++) {
    const d = on(offset);
    if (d && d > now) next = d;
  }
  return { last, next: next! };
}

const clock = (d: Date) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;

/**
 * One pass over the repeats: each whose run time came within the last two minutes starts as its person, through the one
 * start every task takes, its budget, limits and approvals the same; one whose run time passed while this orchestrator
 * was not running is not run late, and says so. Returns the tasks it started.
 */
export async function runRepeats(ctx: OrchestratorContext, runner: TaskRunner, now = new Date(), log: (line: string) => void = console.log): Promise<string[]> {
  const started: string[] = [];
  for (const repeat of await ctx.store.listRepeats(ctx.tenant)) {
    if (repeat.stoppedAt) continue;
    const { last } = runTimes(repeat, now);
    if (!last || last.getTime() <= Date.parse(repeat.createdAt) || (repeat.lastAt && Date.parse(repeat.lastAt) >= last.getTime())) continue;
    const at = last.toISOString();
    if (now.getTime() - last.getTime() > LATE_MS) {
      await ctx.store.reachRepeat(ctx.tenant, repeat.id, at, { at, reason: `This computer was not running the orchestrator at ${clock(last)}, so it did not run; it runs at its next time.` });
      continue;
    }
    await ctx.store.reachRepeat(ctx.tenant, repeat.id, at, null);
    const account = (await ctx.store.listUsers(ctx.tenant)).find((u) => u.email === repeat.createdBy);
    // A repeat runs as its person: one whose account is gone or turned off by the directory is stopped, not run.
    if (!account || (await suspended(ctx.store, ctx.tenant, account.id))) {
      await ctx.store.stopRepeat(ctx.tenant, repeat.id, now.toISOString());
      continue;
    }
    const result = await startTask(ctx, runner, await principalOf(ctx.store, account), repeat.start);
    if ("error" in result) {
      await ctx.store.reachRepeat(ctx.tenant, repeat.id, at, { at, reason: `It did not start at ${clock(last)}: ${result.error}.` });
      log(`repeat ${repeat.id}: not started: ${result.error}`);
    } else started.push(result.task.id);
  }
  return started;
}

/** Runs the repeats once a minute; the returned function stops it. */
export function startRepeats(ctx: OrchestratorContext, runner: TaskRunner): () => void {
  const timer = setInterval(() => void runRepeats(ctx, runner).catch((err: Error) => console.error(`repeats: ${err.message}`)), 60_000);
  timer.unref();
  return () => clearInterval(timer);
}

/** A new repeat of `start` for its person. */
export function newRepeat(tenant: string, createdBy: string, start: Record<string, unknown>, title: string, when: { every: RepeatEvery; at: string }): TaskRepeat {
  return { tenant, id: newId("rpt"), createdBy, start, title, every: when.every, at: when.at, createdAt: new Date().toISOString(), lastAt: null, skipped: null, stoppedAt: null };
}
