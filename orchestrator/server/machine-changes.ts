import type { TaskOutcome } from "../runner/link.js";
import type { OrchestratorContext } from "./app.js";
import { mirrorDir } from "./app.js";
import { machineAsksOf } from "./machine-folders.js";
import type { PolicyRule } from "./plugin.js";
import { machineFolderOf } from "./projects.js";
import type { RepoRecord } from "./store.js";
import { editRefusal, taskPolicy } from "./tasks/task-policy.js";
import type { TaskRecord } from "./tasks/types.js";

/*
 * A task worked in a folder of its person's machine leaves its change there, recorded by the
 * machine's own shadow; the machine reports the paths it changed and never their content. The
 * team's rules on which files an agent edits hold here as for a run in a folder on this
 * orchestrator: a change one breaks fails the task and is taken back on the machine.
 */

/** Where a rule's paths are resolved for a folder this orchestrator has no copy of: any fixed root reads relative rules alike. */
const POLICY_ROOT = "/project";

/**
 * The team's rules a task in a folder without git is held to, read where its run reads them: a
 * code project's from the skills repository it names, read at that repository's head; a folder
 * that names none has none.
 */
export async function inPlaceRules(ctx: OrchestratorContext, repo: RepoRecord): Promise<PolicyRule[] | { refused: string }> {
  const code = ctx.tasks?.codeTarget(repo) ?? null;
  const source = code?.skillsFrom ? await ctx.store.getRepo(ctx.tenant, code.skillsFrom) : null;
  if (code?.skillsFrom && !source?.head) return { refused: `the skills repository ${code.skillsFrom} has not been read, so the team's policy cannot be checked` };
  return source ? taskPolicy(mirrorDir(ctx, source.id), source.head!) : [];
}

export type MachineUndo = { undone: string[]; kept: string[] } | { refused: string; code: string; status: 409 | 502 | 504 };

/** Takes a task's change back on the machine whose folder it is in, waiting for the machine's answer. */
export async function undoOnMachine(ctx: OrchestratorContext, repo: RepoRecord, snapshots: { before: string; after: string }): Promise<MachineUndo> {
  const folder = machineFolderOf(repo.url);
  if (!folder) return { refused: `${repo.name} is not a folder on a person's machine`, code: "not-on-a-machine", status: 409 };
  const name = (await ctx.store.listMachines(ctx.tenant, null)).find((m) => m.id === folder.machineId)?.name ?? "its machine";
  const answer = await machineAsksOf(ctx).ask(folder.machineId, "undos", { projectId: repo.id, path: folder.path, before: snapshots.before, after: snapshots.after });
  if (answer === "offline") return { refused: `${name} is not connected now; start its runner and undo again`, code: "machine-offline", status: 409 };
  if (answer === "busy") return { refused: `${name} is still answering earlier asks; undo again in a moment`, code: "machine-busy", status: 409 };
  if (answer === null) return { refused: `${name} did not answer; its runner is stopped or older than this orchestrator, so update it and undo again`, code: "machine-did-not-answer", status: 504 };
  if (answer === "invalid") return { refused: `${name} answered with something other than what it undid`, code: "machine-answer-invalid", status: 502 };
  return "refused" in answer ? { refused: answer.refused, code: "undo-refused", status: 409 } : answer;
}

/** Records the undo a machine answered, once, and says so in the task's log. */
export async function keepUndo(ctx: OrchestratorContext, task: Pick<TaskRecord, "id">, repo: RepoRecord, undone: { undone: string[]; kept: string[] }, by: string): Promise<boolean> {
  if (!(await ctx.store.markTaskChangesUndone(ctx.tenant, task.id, { at: new Date().toISOString(), by, kept: undone.kept }))) return false;
  await ctx.store.appendTaskLog(ctx.tenant, task.id, [`The task's change in ${repo.name} was undone${undone.kept.length ? `, except ${undone.kept.join(", ")}, changed again since` : ""}.`]);
  return true;
}

/**
 * What a machine reported of a task it worked in a folder of its own: the change is recorded for
 * its person to review and undo, and one the team's rules refuse fails the task and is taken back
 * on the machine. The machine is still in its finish call here, so the undo is asked of its next
 * poll rather than waited on.
 */
export async function keepMachineChanges(ctx: OrchestratorContext, taskId: string, outcome: TaskOutcome): Promise<void> {
  const changes = outcome.changes;
  if (!changes) return;
  const task = await ctx.store.getTask(ctx.tenant, taskId);
  const repo = task ? await ctx.store.getRepo(ctx.tenant, task.repoId) : null;
  if (!task || !repo || !machineFolderOf(repo.url)) return;
  await ctx.store.setTaskChanges(ctx.tenant, task.id, { before: changes.before, after: changes.after, files: changes.files, undone: null });
  // The machine refused the change by the team's policy and took it back itself: nothing is asked of it again.
  if (changes.undone) {
    await keepUndo(ctx, task, repo, { undone: changes.files.map((f) => f.path).filter((path) => !changes.undone!.kept.includes(path)), kept: changes.undone.kept }, "orchestrator");
    return;
  }
  if (outcome.status !== "needs-review") return;
  const rules = await inPlaceRules(ctx, repo);
  const held = "refused" in rules ? `The change was not checked against the team's policy: ${rules.refused}.` : (editRefusal(rules, changes.files.map((f) => f.path), POLICY_ROOT)?.replace(/ No request was opened\.$/, "") ?? null);
  if (!held) {
    await ctx.store.appendTaskLog(ctx.tenant, task.id, [`The change stays in ${repo.name} for its person to review, keep or undo.`]);
    return;
  }
  await ctx.store.updateTask(ctx.tenant, task.id, { status: "failed", error: `${held} Its change is being undone on the machine.` });
  await ctx.store.appendTaskLog(ctx.tenant, task.id, [`${held} Its change is being undone on the machine.`]);
  void undoOnMachine(ctx, repo, changes).then(async (undone) => {
    if ("refused" in undone) await ctx.store.appendTaskLog(ctx.tenant, task.id, [`The change was not undone on the machine: ${undone.refused}. Undo it from this task once the machine is connected.`]);
    else await keepUndo(ctx, task, repo, undone, "orchestrator");
  });
}

