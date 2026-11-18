import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { FileChange } from "../forge/types.js";
import { gitAsyncBytes, gitAsyncMaybe } from "../git.js";
import type { OrchestratorContext } from "../app.js";
import { shadowChanges, shadowPlaceOf, shadowSnapshot } from "../shadow-git.js";
import type { ShadowPlace } from "../shadow-git.js";
import type { RepoRecord } from "../store.js";
import type { TaskStore, TaskTurn } from "./types.js";

/** The most turns a task keeps points for; one past them goes on in the last. */
export const TURNS_MAX = 50;
/** As much of the person's words as names a turn. */
export const TURN_SAID_MAX = 120;

/** Where a task's own checkout is recorded a turn at a time: in the orchestrator's data, never in the person's repository or on a forge. */
export function turnsPlace(ctx: Pick<OrchestratorContext, "dataDir" | "tenant">, taskId: string, work: string): ShadowPlace {
  return { gitDir: join(ctx.dataDir, "task-turns", ctx.tenant, taskId), folder: work, where: { dataDir: ctx.dataDir }, owned: true };
}

/** Where a turn's snapshots are read: the task's own record of its checkout, or the shadow of the folder it worked in place. */
export function placeOfTurn(ctx: OrchestratorContext, turn: Pick<TaskTurn, "place" | "taskId">, project: Pick<RepoRecord, "id" | "url">): ShadowPlace {
  return turn.place === "project" ? shadowPlaceOf(ctx, project) : turnsPlace(ctx, turn.taskId, "");
}

export interface TurnRecorder {
  /** A turn starts: the person's words name it; the turn before ends where it starts. */
  begin(said: string): Promise<void>;
  /** The run's last turn ends here. */
  finish(): Promise<void>;
}

/**
 * Records a run's turns as snapshots of where its agent works. A place that cannot be recorded (too many files, a file
 * too large) keeps no turn points from then on: the run goes on, and its page shows no turns, rather than some.
 */
export function turnRecorder(store: Pick<TaskStore, "openTaskTurn" | "endTaskTurn" | "taskTurns">, tenant: string, taskId: string, place: ShadowPlace, kind: TaskTurn["place"]): TurnRecorder {
  let open: { n: number; start: string } | null = null;
  let kept = true;
  const snapshot = async (label: string): Promise<string | null> => {
    if (!kept) return null;
    const taken = await shadowSnapshot(place, label).catch((err: Error) => ({ refused: err.message }));
    if ("refused" in taken) {
      kept = false;
      return null;
    }
    return taken.sha;
  };
  const close = async (end: string) => {
    if (!open) return;
    const changed = await shadowChanges(place, open.start, end);
    await store.endTaskTurn(tenant, taskId, open.n, end, typeof changed === "string" ? 0 : changed.files.length + changed.untracked.length);
    open = null;
  };
  return {
    async begin(said) {
      const held = await store.taskTurns(tenant, taskId);
      if (held.length >= TURNS_MAX) return;
      const start = await snapshot(`turn ${held.length + 1} of ${taskId}`);
      if (!start) return;
      await close(start);
      const n = held.length + 1;
      await store.openTaskTurn({ tenant, taskId, n, at: new Date().toISOString(), said: said.slice(0, TURN_SAID_MAX), place: kind, start });
      open = { n, start };
    },
    async finish() {
      if (!open) return;
      const end = await snapshot(`end of ${taskId}`);
      if (end) await close(end);
    },
  };
}

/**
 * The files a request gets back to undo from a turn on: each path the turns from `start` to `end` changed, as `start`
 * held it, or removed where it had none. A file kept as a digest alone, as one that looks like a secret is, was never
 * recorded and is not written; nor is one that is not text.
 */
export async function filesAsAt(place: ShadowPlace, start: string, end: string, at: "start" | "end" = "start"): Promise<FileChange[] | { refused: string }> {
  const dir = place.gitDir;
  const listed = await gitAsyncMaybe(["--git-dir", dir, "diff", "--name-only", "--no-renames", "-z", start, end], dir);
  if (listed === null) return { refused: "these turns are not this task's" };
  const files: FileChange[] = [];
  const from = at === "start" ? start : end;
  for (const path of listed.split("\0").filter(Boolean)) {
    const there = await gitAsyncMaybe(["--git-dir", dir, "cat-file", "-e", `${from}:${path}`], dir);
    if (there === null) {
      files.push({ path, content: null });
      continue;
    }
    const bytes = await gitAsyncBytes(["--git-dir", dir, "cat-file", "blob", `${from}:${path}`], dir);
    if (bytes.includes(0)) return { refused: `${path} is not a text file, so it is not put back from a turn; undo the whole change instead` };
    files.push({ path, content: bytes.toString("utf8") });
  }
  return files;
}

/** The head of a request's branch as the orchestrator's copy reads it now. */
export async function branchHead(mirror: string, branch: string): Promise<string | null> {
  return (await gitAsyncMaybe(["--git-dir", mirror, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}^{commit}`], mirror))?.trim() || null;
}

/**
 * Removes the turn snapshots no task reads any more: a folder whose task is unknown, whose task ended before `before`
 * (the time its log is kept to), or whose starter has no account now. The task's turns go with them, so its page
 * offers none. Says how many folders went.
 */
export async function purgeTurns(ctx: Pick<OrchestratorContext, "store" | "tenant" | "dataDir">, before: string): Promise<number> {
  const root = join(ctx.dataDir, "task-turns", ctx.tenant);
  const kept = (await readdir(root, { withFileTypes: true }).catch(() => [])).filter((e) => e.isDirectory()).map((e) => e.name);
  if (!kept.length) return 0;
  const people = new Set((await ctx.store.listUsers(ctx.tenant)).flatMap((u) => [u.email, u.id]));
  let removed = 0;
  for (const taskId of kept) {
    const task = await ctx.store.getTask(ctx.tenant, taskId);
    const ended = task?.finishedAt && task.status !== "queued" && task.status !== "running" ? task.finishedAt : null;
    if (task && people.has(task.createdBy) && !(ended && ended < before)) continue;
    await rm(join(root, taskId), { recursive: true, force: true });
    if (task) await ctx.store.deleteTaskTurns(ctx.tenant, taskId);
    removed++;
  }
  return removed;
}
