import type { OrchestratorContext } from "./app.js";
import { inConfiguration, syncRepos } from "./app.js";
import { ORCHESTRATOR_ACTOR } from "./events.js";
import { inBackground } from "./forge/http.js";
import { eachAtMost } from "./git.js";
import { refreshRequest } from "./propose.js";

/** How often the orchestrator reads its repositories and its hosted requests again on its own, unless ORCHESTRATOR_SYNC_MINUTES says otherwise. */
export const SYNC_MINUTES = 10;
/** Requests asked about at once, so a round with many open requests stays under a forge's rate limit. */
export const REFRESH_AT_ONCE = 2;
/** At most this many hosted requests are asked about in one round; the ones asked longest ago go first. */
export const REFRESH_PER_ROUND = 100;

/** ORCHESTRATOR_SYNC_MINUTES: 0 turns the rounds off, 1 to 1440 sets their spacing; anything else stops the orchestrator at start. */
export function syncMinutes(value: string | undefined = process.env.ORCHESTRATOR_SYNC_MINUTES): number {
  if (value === undefined || value === "") return SYNC_MINUTES;
  const minutes = Number(value);
  if (!Number.isInteger(minutes) || minutes < 0 || minutes > 1440) throw new Error("ORCHESTRATOR_SYNC_MINUTES is a whole number of minutes from 0 (off) to 1440");
  return minutes;
}

/** When this process last asked about each hosted request, per org, so a round starts with the ones asked longest ago. */
const lastAsked = new Map<string, Map<string, number>>();

/**
 * One round for one org: every repository the configuration lists is fetched again, and each
 * open request, on GitLab, on GitHub or on a repository read by path, is asked where it stands, a
 * few at a time. A merge made on the
 * forge reaches the inventory, the policies and the tasks' setup without anyone pressing Sync.
 * A failure is recorded on its repository or logged, and the rest of the round goes on.
 */
export async function syncRound(ctx: OrchestratorContext, signal?: AbortSignal, log: (line: string) => void = console.error): Promise<{ repos: number; requests: number }> {
  const repos = (await ctx.store.listRepos(ctx.tenant)).filter((r) => inConfiguration(ctx, r.id));
  await syncRepos(ctx, repos.map((r) => r.id), signal);
  const byId = new Map(repos.map((r) => [r.id, r]));
  // A request on a repository read by path is asked too: its local forge reads from git alone
  // whether the person merged the branch or deleted it in their own repository.
  const open = (await ctx.store.listRequests(ctx.tenant)).filter((r) => r.status === "open" && byId.has(r.repoId));
  const asked = lastAsked.get(ctx.tenant) ?? new Map<string, number>();
  lastAsked.set(ctx.tenant, asked);
  const due = open.sort((a, b) => (asked.get(`${a.repoId}#${a.number}`) ?? 0) - (asked.get(`${b.repoId}#${b.number}`) ?? 0)).slice(0, REFRESH_PER_ROUND);
  await eachAtMost(due, REFRESH_AT_ONCE, async (r) => {
    asked.set(`${r.repoId}#${r.number}`, Date.now());
    await refreshRequest(ctx, byId.get(r.repoId)!, r.number, ORCHESTRATOR_ACTOR, "read by the orchestrator's own check").catch((err: Error) => log(`refresh ${r.repoId} #${r.number}: ${err.message}`));
  }, signal);
  return { repos: repos.length, requests: due.length };
}

/**
 * Runs a round for each org every `minutes`, one round at a time: one still going when the next
 * is due is let finish, and the next waits its turn. Aborting `signal` stops the rounds; one under
 * way starts no further sync.
 */
export function startAutoSync(contexts: readonly OrchestratorContext[], minutes: number, signal: AbortSignal): void {
  if (!minutes) return;
  const round = async () => {
    for (const ctx of contexts) {
      if (signal.aborted) return;
      // Nobody waits on a round, so when a forge's quota runs low it gives way to the calls people wait on.
      await inBackground(() => syncRound(ctx, signal)).catch((err: Error) => console.error(`sync round ${ctx.tenant}: ${err.message}`));
    }
  };
  const next = () => {
    if (signal.aborted) return;
    setTimeout(() => void round().finally(next), minutes * 60_000).unref();
  };
  next();
}
