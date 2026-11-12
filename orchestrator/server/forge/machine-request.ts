import type { OrchestratorContext } from "../app.js";
import type { Principal } from "../auth.js";
import { OrchestratorError } from "../errors.js";
import { pushOnMachine } from "../machine-folders.js";
import { openTargetRequest } from "../tasks/leased.js";
import type { TaskTarget } from "../tasks/types.js";
import { openOnUnconnectedRemote } from "./unconnected.js";

/** A press that pushed or opened nothing: why, in the machine's or the orchestrator's own words. */
export class MachineRequestRefused extends OrchestratorError {}

/**
 * A change a task kept on its person's machine, pushed to its remote and opened as a request
 * because its starter pressed for it: the branch and the head are the ones the task recorded,
 * never anything the press sends, and the machine refuses a branch that moved since. Once pushed,
 * the request opens under the same checks as one a machine pushed at a task's end.
 */
export async function openKeptChange(ctx: OrchestratorContext, user: Principal, taskId: string, position: number, push = pushOnMachine, open = openTargetRequest, unconnected = openOnUnconnectedRemote): Promise<TaskTarget> {
  const task = await ctx.store.getTask(ctx.tenant, taskId);
  if (!task || (task.createdBy !== user.email && task.createdBy !== user.id)) throw new MachineRequestRefused("not-starter", "only the person who started the task opens its change as a request", 403);
  const kept = task.targets?.[position];
  const project = await ctx.store.getRepo(ctx.tenant, task.repoId);
  // A change the machine pushed to a remote the organization never connected opens with the starter's own sign-in, once the orchestrator read and checked it.
  if (kept?.status === "local" && kept.reason === "not-connected" && project) {
    const answer = await unconnected(ctx, user, task, project, kept);
    if ("refused" in answer) throw new MachineRequestRefused("not-opened", `the request did not open: ${answer.refused}`, 409);
    const { forge, account, number, url } = answer.opened;
    await ctx.store.updateTaskTarget(ctx.tenant, task.id, position, { status: "request", reason: `opened on ${forge} as ${account}`, forgeRequest: { forge, number, url }, error: null });
    return (await ctx.store.getTask(ctx.tenant, task.id))!.targets![position]!;
  }
  if (!kept || kept.status !== "local" || kept.reason !== "unpushed" || kept.path === undefined || !kept.branch || !kept.head) throw new MachineRequestRefused("not-kept", "this change is not one kept on its machine for a press to push", 409);
  if (!project) throw new MachineRequestRefused("not-kept", "the folder this task ran in is no longer connected", 409);
  const pushed = await push(ctx, project, { path: kept.path, branch: kept.branch, head: kept.head });
  if ("unread" in pushed) throw new MachineRequestRefused("not-pushed", pushed.unread, 409);
  const opened = await open(ctx, task.id, position);
  if ("refused" in opened) throw new MachineRequestRefused("not-opened", `${kept.branch} was pushed, and the request did not open: ${opened.refused}`, 409);
  return opened;
}
