import type { OrchestratorContext } from "../app.js";
import type { Principal } from "../auth.js";
import type { TaskRunner } from "./runner.js";
import type { TaskRecord } from "./types.js";

/** Who the demo's example task is recorded as: a stand-in, never an account anyone signs in to. */
export const DEMO_PRINCIPAL: Principal = { id: "demo", name: "Demo Seed", email: "demo@orchestrator.invalid", role: "owner", ownedTeams: [] };

/**
 * One finished task for a first look at the demo: the stand-in agent runs through the same
 * path as any task and leaves a request waiting for review. Only on a tenant with no task
 * yet, so a restarted demo does not pile up copies, and only when the stand-in is offered.
 */
export async function seedDemoTask(ctx: OrchestratorContext, runner: TaskRunner): Promise<TaskRecord | null> {
  if ((await ctx.store.taskPage(ctx.tenant, {}, null, 1)).tasks.length) return null;
  if (!runner.agents().some((a) => a.id === "fake")) return null;
  const repo = (await ctx.store.listRepos(ctx.tenant)).find((r) => r.head);
  if (!repo) return null;
  return runner.start({
    repo,
    title: "Add an incident review skill",
    description: "Write down how the team runs a review after an incident: the timeline, the contributing causes, and the follow-ups with an owner each.",
    agent: "fake",
    user: DEMO_PRINCIPAL,
  });
}
