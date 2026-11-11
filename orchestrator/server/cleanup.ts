import type { OrchestratorContext } from "./app.js";
import { purgeOldEvents } from "./events.js";
import { purgeTaskLogs, purgeUsageCounts, readPrivacy } from "./privacy.js";
import { purgeAttachments } from "./attachments.js";
import type { Store } from "./store.js";

/** Effects settled this long ago are pruned; failed ones are kept for whoever looks into them. */
const SETTLED_EFFECTS_KEPT_MS = 7 * 86_400_000;
const ROUND_MS = 60 * 60_000;
const EFFECTS_PAGE = 1_000;

export interface CleanupReport {
  taskLogLines: number;
  attachments: number;
  usageCounts: number;
  events: number;
  expiredQuestions: number;
  settledEffects: number;
  signupSteps: number;
  runnerRows: number;
}

export interface CleanupOptions {
  /** Days a cloud orchestrator keeps signup steps; 0 on a self-hosted one, which keeps none. */
  signupDays: number;
}

const NAMES: [keyof CleanupReport, string][] = [
  ["taskLogLines", "task log lines"],
  ["attachments", "task attachments"],
  ["usageCounts", "skill use counts"],
  ["events", "events"],
  ["expiredQuestions", "agent questions expired"],
  ["settledEffects", "settled effects"],
  ["signupSteps", "signup steps"],
  ["runnerRows", "runner nonces and pairing codes"],
];

/**
 * One pass over everything the orchestrator keeps for a time: each organization's task log,
 * skill use and event log by its own retention, agents' questions past their time, effects
 * settled a week ago, signup steps past ORCHESTRATOR_IDENTITY_EVENTS_DAYS, runner nonces and pairing
 * codes past their time and ended sessions. A part that fails is logged and the rest still runs.
 */
export async function cleanupRound(store: Store, served: readonly OrchestratorContext[], options: CleanupOptions, now = new Date(), warn: (line: string) => void = console.error): Promise<CleanupReport> {
  const report: CleanupReport = { taskLogLines: 0, attachments: 0, usageCounts: 0, events: 0, expiredQuestions: 0, settledEffects: 0, signupSteps: 0, runnerRows: 0 };
  const count = async (part: keyof CleanupReport, what: string, work: () => Promise<number>) => {
    report[part] += await work().catch((err: Error) => (warn(`cleanup ${what}: ${err.message}`), 0));
  };
  for (const ctx of served) {
    await count("taskLogLines", `task log (${ctx.tenant})`, () => purgeTaskLogs(ctx.store, ctx.tenant, now));
    // Attachments go with the task log they belong beside, by the same retention.
    await count("attachments", `attachments (${ctx.tenant})`, async () => purgeAttachments(ctx, new Date(now.getTime() - (await readPrivacy(ctx.store, ctx.tenant)).taskLogDays * 86_400_000).toISOString()));
    await count("usageCounts", `skill use (${ctx.tenant})`, () => purgeUsageCounts(ctx.store, ctx.tenant, now));
    await count("events", `event log (${ctx.tenant})`, () => purgeOldEvents(ctx, now));
  }
  await count("expiredQuestions", "agent questions", () => store.expireTaskRequests(now.toISOString()));
  await count("settledEffects", "effects", async () => {
    // A page at a time, so a week of a busy organization's effects never holds the table in one long delete.
    const before = new Date(now.getTime() - SETTLED_EFFECTS_KEPT_MS).toISOString();
    let removed = 0;
    for (;;) {
      const page = await store.pruneEffects(before, EFFECTS_PAGE);
      removed += page;
      if (page < EFFECTS_PAGE) return removed;
    }
  });
  if (options.signupDays) await count("signupSteps", "signup steps", () => store.pruneIdentityEvents(new Date(now.getTime() - options.signupDays * 86_400_000).toISOString()));
  await count("runnerRows", "runner nonces and pairing codes", () => store.pruneRunnerRows(now.toISOString()));
  await store.purgeExpired(now.toISOString()).catch((err: Error) => warn(`cleanup sessions: ${err.message}`));
  return report;
}

/** The one line a round writes, or null when it removed nothing. */
export function cleanupSummary(report: CleanupReport): string | null {
  const parts = NAMES.filter(([key]) => report[key] > 0).map(([key, name]) => `${report[key]} ${name}`);
  return parts.length ? `cleanup: ${parts.join(", ")}` : null;
}

/** Well inside a runner's 90-second lease, so a machine that went quiet shows interrupted within one lease and a little more. */
const LEASE_SWEEP_MS = 15_000;

/** Ends the leases past their time every LEASE_SWEEP_MS, in every mode: one conditional write, so several processes sweeping at once do no harm. Returns what stops it. */
export function startLeaseExpiry(store: Store, everyMs = LEASE_SWEEP_MS): () => void {
  const sweep = () =>
    void store.expireLeases(new Date().toISOString()).then(
      ({ interrupted, failed }) => {
        if (interrupted || failed) console.log(`leases: ${interrupted} interrupted, ${failed} failed`);
      },
      (err: Error) => console.error(`lease expiry: ${err.message}`),
    );
  const timer = setInterval(sweep, everyMs);
  timer.unref();
  return () => clearInterval(timer);
}

/** Runs a round now and every hour after, over the organizations this process serves at that moment; returns what stops it. */
export function startCleanup(store: Store, served: () => readonly OrchestratorContext[], options: CleanupOptions): () => void {
  const round = () =>
    void cleanupRound(store, served(), options).then((report) => {
      const line = cleanupSummary(report);
      if (line) console.log(line);
    });
  round();
  const timer = setInterval(round, ROUND_MS);
  timer.unref();
  return () => clearInterval(timer);
}
