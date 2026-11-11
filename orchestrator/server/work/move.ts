import { principalOf } from "../accounts.js";
import type { OrchestratorContext } from "../app.js";
import { manages } from "../auth.js";
import type { Principal } from "../auth.js";
import type { WorkColumn, WorkMoveTrigger, WorkTransitioned } from "../../shared/work.js";
import { ChangeRefused } from "../changes.js";
import { auditRequired } from "../integrations/audit.js";
import type { RequestStatus } from "../forge/types.js";
import { everyTask } from "../tasks/guards.js";
import { taskPhase } from "../tasks/phase.js";
import type { TaskRecord } from "../tasks/types.js";
import { movesKey, readSaved } from "./moves.js";
import { isOrgSource } from "./ids.js";
import { columnOf, JIRA_KEY } from "./provider.js";
import type { IssueRef } from "./provider.js";
import { board, columns, WorkNotFound } from "./service.js";
import { writesOff, writesOn } from "./writes.js";
import type { Opened, WorkDeps } from "./service.js";

type Ctx = Pick<OrchestratorContext, "store" | "tenant" | "vault" | "audit" | "forgeApps">;

const MOMENT: Record<WorkMoveTrigger, string> = { started: "the agent started", requestOpened: "the requests opened", merged: "the requests merged" };

/**
 * Moves one issue into a column through the first move its workflow offers into one of the
 * column's statuses. The move is written to the event log before it is sent, so an orchestrator with
 * no log moves nothing, and a move the tracker refuses is logged as failed. An automatic move
 * never goes back: an issue already in that column or past it stays where it is.
 */
async function moveIssue(ctx: Ctx, actor: Principal, opened: Opened, cols: readonly WorkColumn[], issue: IssueRef, column: string, why: string, forward: boolean): Promise<WorkTransitioned | null> {
  // The one place every move passes: with moving off for this tracker, nothing is asked of it, not even the issue's moves.
  if (!opened.writes) {
    if (forward) return null;
    throw new ChangeRefused(writesOff(opened.source.kind));
  }
  if (!JIRA_KEY.test(issue.key)) throw new ChangeRefused("that is not a Jira issue key");
  const target = cols.findIndex((c) => c.name === column);
  if (target < 0) {
    // A column the board's moves name that its columns no longer have, after they were arranged anew: an automatic move skips it.
    if (forward) {
      await auditRequired(ctx, actor, "work.move-skipped", { subject: `issue:${issue.key}`, detail: `did not move ${issue.key} to ${column} as ${why}: the board has no such column now` });
      return null;
    }
    throw new ChangeRefused(`${column} is not a column of this board`);
  }
  const { status, transitions } = await opened.provider.transitions(issue);
  const now = cols.findIndex((c) => c.statuses.includes(status));
  if (now === target || (forward && now > target)) return null;
  const move = transitions.find((t) => cols[target]!.statuses.includes(t.to));
  const subject = `issue:${issue.key}`;
  if (!move) {
    await auditRequired(ctx, actor, "work.move-skipped", { subject, detail: `did not move ${issue.key} to ${column} as ${why}: its workflow offers no move from ${status} into that column` });
    return null;
  }
  const via = isOrgSource(opened.source.id) ? "with the organization's token" : `through ${opened.source.id.slice(4)}`;
  await auditRequired(ctx, actor, "work.moved", { subject, detail: `moved ${issue.key} from ${status} to ${move.to} (${column}) ${via}, as ${why}` });
  try {
    await opened.provider.transition(issue, move.id);
  } catch (err) {
    await auditRequired(ctx, actor, "work.move-failed", { subject, detail: `${issue.key} was not moved to ${column}: ${(err as Error).message}` });
    throw err;
  }
  return { status: { name: move.to, category: move.category }, column: columnOf(cols, move.to) };
}

async function starterOf(ctx: Ctx, task: TaskRecord): Promise<Principal | null> {
  const user = (await ctx.store.getUser(ctx.tenant, task.createdBy)) ?? (await ctx.store.getUserByEmail(ctx.tenant, task.createdBy));
  return user ? principalOf(ctx.store, user) : null;
}

/**
 * Moves a task's issue as the board says, when the task reaches a moment: the organization's
 * board with the switch on comes first, then the board on the starter's own server. A board
 * counts only when the starter is shown it and the issue's address is on it; nothing moves for
 * an issue no board with the switch on holds.
 */
export async function moveForTask(ctx: Ctx, deps: WorkDeps, task: TaskRecord, trigger: WorkMoveTrigger): Promise<WorkTransitioned | null> {
  if (!task.issueKey || !task.issueUrl || !JIRA_KEY.test(task.issueKey)) return null;
  // A task's moment reads no board while changing issues is off.
  if (!(await writesOn(ctx))) return null;
  const starter = await starterOf(ctx, task);
  if (!starter) return null;
  const issue = { key: task.issueKey, url: task.issueUrl };
  for (const prefix of ["work.moves.tracker~", `work.moves.${starter.id}.`]) {
    for (const { key } of await ctx.store.listSettings(ctx.tenant, prefix)) {
      const saved = await readSaved(ctx, key);
      const column = saved?.enabled ? saved.moves[trigger] : undefined;
      if (!column || !saved!.issuePrefix || !issue.url.startsWith(saved!.issuePrefix)) continue;
      const boardId = key.slice(prefix === "work.moves.tracker~" ? "work.moves.".length : prefix.length);
      let found: Awaited<ReturnType<typeof board>>;
      try {
        found = await board(ctx, starter, boardId, deps);
      } catch (err) {
        if (err instanceof WorkNotFound) continue;
        throw err;
      }
      if (movesKey(found.opened.source.id, boardId, starter.id) !== key) continue;
      return moveIssue(ctx, starter, found.opened, await columns(found.opened, found.native, deps), issue, column, `${MOMENT[trigger]} on task ${task.id}`, true);
    }
  }
  return null;
}

/**
 * A person moving an issue by hand from the board: through their own server as themselves, or
 * with the organization's token when they are an owner or an admin, or own the board's team.
 */
export async function moveByHand(ctx: Ctx, user: Principal, key: string, given: unknown, deps: WorkDeps): Promise<WorkTransitioned> {
  const body = given as { board?: unknown; column?: unknown } | null;
  if (typeof body?.board !== "string" || typeof body.column !== "string") throw new ChangeRefused("send board and column");
  if (!JIRA_KEY.test(key)) throw new ChangeRefused("that is not a Jira issue key");
  const { opened, native, shown } = await board(ctx, user, body.board, deps);
  if (isOrgSource(opened.source.id) && !manages(user) && !(shown.team && user.ownedTeams.includes(shown.team))) {
    throw new ChangeRefused("only an owner or an admin, or an owner of the board's team, moves issues with the organization's tracker");
  }
  if (!shown.project || !key.startsWith(`${shown.project}-`)) throw new ChangeRefused(`${key} is not an issue of ${shown.name}`);
  const reason = await opened.provider.writable();
  if (reason) throw new ChangeRefused(reason);
  const site = new URL(shown.url).origin;
  const moved = await moveIssue(ctx, user, opened, await columns(opened, native, deps), { key, url: `${site}/browse/${key}` }, body.column, "moved by hand on the board", false);
  if (!moved) throw new ChangeRefused(`${key} is already in ${body.column}`);
  return moved;
}

/** What the event log is offered of each row it writes; the merge of a request is read from it. */
interface LoggedRow {
  tenant: string;
  kind: string;
  repoId: string | null;
  subject: string | null;
}

/**
 * Moves an issue on when every request of its task has merged. A merge happens outside a task's
 * run, on the merge route or in a forge refresh, and each writes `request.merged` to the event
 * log, so this reads the log rather than every place a request can merge.
 */
export function withMergeMoves<E extends LoggedRow, S extends { appendEvent(event: E): Promise<void> }>(store: S, ctxOf: (tenant: string) => Ctx | undefined, deps: WorkDeps): S {
  const append = store.appendEvent.bind(store);
  store.appendEvent = async (event: E) => {
    await append(event);
    if (event.kind !== "request.merged" || !event.repoId || !event.subject?.startsWith("request:")) return;
    const ctx = ctxOf(event.tenant);
    if (ctx) void movedOnMerge(ctx, deps, event.repoId, Number(event.subject.slice("request:".length))).catch((err: Error) => console.error(`work: ${err.message}`));
  };
  return store;
}

async function movedOnMerge(ctx: Ctx, deps: WorkDeps, repoId: string, number: number): Promise<void> {
  if (!Number.isInteger(number)) return;
  const tasks = await everyTask(ctx.store, ctx.tenant, { repoId, requestNumber: number });
  for (const task of tasks.filter((t) => t.issueKey)) {
    const statuses = new Map<string, RequestStatus>();
    for (const r of task.targets ? task.targets.filter((t) => t.requestNumber !== null).map((t) => ({ repoId: t.repoId, number: t.requestNumber! })) : task.requestNumber !== null ? [{ repoId: task.repoId, number: task.requestNumber }] : []) {
      const request = await ctx.store.getRequest(ctx.tenant, r.repoId, r.number);
      if (request) statuses.set(`${r.repoId}#${r.number}`, request.status);
    }
    if (taskPhase(task, (r, n) => statuses.get(`${r}#${n}`) ?? null) === "merged") await moveForTask(ctx, deps, task, "merged");
  }
}

/** The task runner's hook: the agent starting moves the issue as `started` says, every request open as `requestOpened` says. */
export function movesOnPhase(ctx: Ctx, deps: WorkDeps): (task: TaskRecord, phase: "working" | "review") => Promise<void> {
  return async (task, phase) => {
    await moveForTask(ctx, deps, task, phase === "working" ? "started" : "requestOpened");
  };
}
