import type { OrchestratorContext } from "../app.js";
import { ORCHESTRATOR_ACTOR, recordEvent } from "../events.js";
import { ForgeHttpError } from "../forge/http.js";
import type { BranchUpdate, ForgeProvider } from "../forge/types.js";
import type { RepoRecord } from "../store.js";

/**
 * Whether what the orchestrator does on its own keeps working: reading a team repository, running
 * tasks, reaching a forge. One failure is ordinary - a forge restarts, a network blinks - so a
 * check is called broken only after `FAILURES_BEFORE_ALERT` in a row, and then it says so once,
 * in the event log, which Slack hears when an admin picked it. When it works again it says that
 * too, once. A check that breaks again soon after is not announced again within `REALERT_MS`,
 * so one flapping repository does not fill a channel.
 */
export const FAILURES_BEFORE_ALERT = 3;
export const REALERT_MS = 6 * 60 * 60_000;

export type HealthCheck = { kind: "sync"; repoId: string } | { kind: "forge"; repoId: string } | { kind: "tasks" };

interface CheckState {
  failures: number;
  /** When this check's last "stopped working" was told, or null; a recovery is told only after one. */
  alertedAt: number | null;
  broken: boolean;
  /** Whether the current broken spell was told, so its recovery is told too. */
  told: boolean;
}

const WHAT: Record<HealthCheck["kind"], string> = {
  sync: "Reading the repository",
  forge: "Reaching the repository's forge",
  tasks: "Running tasks",
};

const states = new Map<string, CheckState>();

const keyOf = (tenant: string, check: HealthCheck) => `${tenant}\0${check.kind}\0${"repoId" in check ? check.repoId : ""}`;

/** Forgets every check's state; a new orchestrator process starts with none. */
export function resetHealth(): void {
  states.clear();
}

/**
 * Notes one outcome of a check, and records `health.degraded` or `health.recovered` when the
 * check crosses the line. Never throws: a log that refuses the row is said on the orchestrator's own
 * output, and what was being done goes on.
 */
export async function noteHealth(ctx: Pick<OrchestratorContext, "store" | "tenant">, check: HealthCheck, outcome: { ok: true } | { ok: false; detail: string }, now = Date.now()): Promise<void> {
  const key = keyOf(ctx.tenant, check);
  const state = states.get(key) ?? { failures: 0, alertedAt: null, broken: false, told: false };
  states.set(key, state);
  const repoId = "repoId" in check ? check.repoId : null;
  const record = (kind: string, detail: string) =>
    recordEvent(ctx, ORCHESTRATOR_ACTOR, kind, { repoId, subject: `health:${check.kind}`, detail }).catch((err: Error) => console.error(`health: the event log did not take ${kind}: ${err.message}`));
  if (outcome.ok) {
    const wasTold = state.broken && state.told;
    Object.assign(state, { failures: 0, broken: false, told: false });
    if (wasTold) await record("health.recovered", `${WHAT[check.kind]} works again`);
    return;
  }
  state.failures++;
  if (state.broken || state.failures < FAILURES_BEFORE_ALERT) return;
  state.broken = true;
  if (state.alertedAt !== null && now - state.alertedAt < REALERT_MS) return;
  state.alertedAt = now;
  state.told = true;
  await record("health.degraded", `${WHAT[check.kind]} failed ${state.failures} times in a row; the last: ${outcome.detail}`);
}

/** Whether a forge's failure says the forge or its token is not working, rather than refusing one change. */
function forgeBroken(err: unknown): boolean {
  return err instanceof ForgeHttpError && (err.status === 0 || err.status === 401 || err.status === 403 || err.status >= 500);
}

/**
 * A hosted forge's provider whose every call counts toward that repository's forge check: an
 * answer is the forge working, an unreachable forge, a refused token or a server error is not,
 * and a refusal of one change (a branch that exists, a name it will not take) says nothing.
 */
export function watchedForge(ctx: Pick<OrchestratorContext, "store" | "tenant">, repo: RepoRecord, provider: ForgeProvider): ForgeProvider {
  if (provider.kind === "local") return provider;
  const check: HealthCheck = { kind: "forge", repoId: repo.id };
  const watch = <T>(call: Promise<T>): Promise<T> =>
    call.then(
      async (value) => {
        await noteHealth(ctx, check, { ok: true });
        return value;
      },
      async (err: unknown) => {
        if (forgeBroken(err)) await noteHealth(ctx, check, { ok: false, detail: (err as Error).message });
        throw err;
      },
    );
  return {
    kind: provider.kind,
    open: (r, change) => watch(provider.open(r, change)),
    ...(provider.openForBranch ? { openForBranch: (r: RepoRecord, pushed: Parameters<NonNullable<ForgeProvider["openForBranch"]>>[1]) => watch(provider.openForBranch!(r, pushed)) } : {}),
    ...(provider.updateBranch ? { updateBranch: (r: RepoRecord, branch: string, update: BranchUpdate) => watch(provider.updateBranch!(r, branch, update)) } : {}),
    ...(provider.status ? { status: (r: RepoRecord, n: number) => watch(provider.status!(r, n)) } : {}),
    ...(provider.list ? { list: (r: RepoRecord) => watch(provider.list!(r)) } : {}),
    ...(provider.setCommitStatus ? { setCommitStatus: (sha: string, c: Parameters<NonNullable<ForgeProvider["setCommitStatus"]>>[1]) => watch(provider.setCommitStatus!(sha, c)) } : {}),
  };
}
