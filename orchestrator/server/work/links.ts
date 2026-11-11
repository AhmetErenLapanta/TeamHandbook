import type { OrchestratorContext } from "../app.js";
import type { Principal } from "../auth.js";
import { forgeRequestName } from "../../shared/forge-def.js";
import type { WorkTaskLink } from "../../shared/work.js";
import { endReason } from "../task-board.js";
import { everyTask, visibleTasks } from "../tasks/guards.js";
import { taskPhase } from "../tasks/phase.js";
import type { TaskRecord } from "../tasks/types.js";

const KEYS_PER_QUERY = 200;

const reasonOf = (error: string | null): { reason?: string } => {
  const reason = endReason(error);
  return reason ? { reason } : {};
};

/**
 * The orchestrator tasks each issue was started from, as this person may see them, newest first:
 * read from the orchestrator's own records on every call, never from the tracker cache, so a board
 * shows a task's progress as it happens. A task this person may not read is not counted.
 */
export async function taskLinks(ctx: Pick<OrchestratorContext, "store" | "tenant">, user: Principal, keys: readonly string[]): Promise<Map<string, WorkTaskLink[]>> {
  const unique = [...new Set(keys)];
  const tasks: TaskRecord[] = [];
  const visible = visibleTasks(user);
  for (let i = 0; i < unique.length; i += KEYS_PER_QUERY) {
    tasks.push(...(await everyTask(ctx.store, ctx.tenant, { ...visible, issueKeys: unique.slice(i, i + KEYS_PER_QUERY) })));
  }
  tasks.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
  const links = new Map<string, WorkTaskLink[]>();
  for (const task of tasks) {
    const link = await taskLink(ctx, task);
    links.set(task.issueKey!, [...(links.get(task.issueKey!) ?? []), link]);
  }
  return links;
}

async function taskLink(ctx: Pick<OrchestratorContext, "store" | "tenant">, task: TaskRecord): Promise<WorkTaskLink> {
  const opened = task.targets
    ? task.targets.filter((t) => t.requestNumber !== null).map((t) => ({ repoId: t.repoId, number: t.requestNumber! }))
    : task.requestNumber !== null
      ? [{ repoId: task.repoId, number: task.requestNumber }]
      : [];
  const requests: WorkTaskLink["requests"] = [];
  for (const { repoId, number } of opened) {
    const request = await ctx.store.getRequest(ctx.tenant, repoId, number);
    if (!request) continue;
    if (request.provider === "local") requests.push({ repoId, number, status: request.status, url: null, name: `${(await ctx.store.getRepo(ctx.tenant, repoId))?.name ?? repoId} #${number}` });
    else requests.push({ repoId, number, status: request.status, url: request.url, name: forgeRequestName(request.provider, number) });
  }
  const statusOf = (repoId: string, number: number) => requests.find((r) => r.repoId === repoId && r.number === number)?.status ?? null;
  return {
    taskId: task.id,
    status: task.status,
    phase: taskPhase(task, statusOf),
    result: task.result ?? null,
    targets: (task.targets ?? []).map((t) => ({ repoId: t.repoId, status: t.status })),
    requests,
    startedBy: task.createdBy,
    costUsd: task.cost.usd,
    ...(task.status === "failed" || task.status === "interrupted" ? reasonOf(task.error) : {}),
  };
}
