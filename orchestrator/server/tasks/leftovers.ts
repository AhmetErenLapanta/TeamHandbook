import type { OrchestratorContext } from "../app.js";
import { localDescriptionRef, localRepoPath } from "../forge/local.js";
import { gitAsync, gitAsyncMaybe, oneAtATime } from "../git.js";

/**
 * The branch of a task that an orchestrator stopped between taking the branch into the team's
 * repository and recording its request: the branch is there, and no request names it. It is
 * moved, with its description, to `refs/orchestrator/orphaned/<stamp>/` - the place the start-up
 * reconciliation moves the orchestrator's own unnamed branches to - so it leaves the branch list
 * and `git update-ref` brings it back. Nothing is deleted. Only the local forge's repositories
 * are reached; a hosted forge's branch stays where the forge has it. Answers where the branch
 * went and the commands, run in the repository, that bring back the branch and its description.
 */
export async function setAsideTaskBranch(ctx: OrchestratorContext, repoId: string, branch: string, stamp: string): Promise<{ ref: string; back: string[] } | null> {
  const repo = await ctx.store.getRepo(ctx.tenant, repoId);
  const bare = repo ? localRepoPath(repo.url) : null;
  if (!repo || !bare) return null;
  if ((await ctx.store.listRequests(ctx.tenant, repoId)).some((r) => r.branch === branch)) return null;
  return oneAtATime(bare, async () => {
    const sha = (await gitAsyncMaybe(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], bare))?.trim();
    if (!sha) return null;
    const aside = `refs/orchestrator/orphaned/${stamp}`;
    await gitAsync(["update-ref", `${aside}/heads/${branch}`, sha], bare);
    const note = (await gitAsyncMaybe(["rev-parse", "--verify", "--quiet", localDescriptionRef(branch)], bare))?.trim();
    if (note) await gitAsync(["update-ref", `${aside}/notes/${branch}`, note], bare);
    await gitAsync(["update-ref", "-d", `refs/heads/${branch}`, sha], bare);
    if (note) await gitAsync(["update-ref", "-d", localDescriptionRef(branch), note], bare);
    const back = [`git update-ref refs/heads/${branch} ${aside}/heads/${branch}`, ...(note ? [`git update-ref ${localDescriptionRef(branch)} ${aside}/notes/${branch}`] : [])];
    return { ref: `${aside}/heads/${branch}`, back };
  });
}
