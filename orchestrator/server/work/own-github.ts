import type { OrchestratorContext } from "../app.js";
import { localRepoPath } from "../forge/local.js";
import { projectFacts } from "../projects.js";

/**
 * On one person's own machine, the GitHub repositories their projects' folders name as origin:
 * the boards their own gh reads issues from. Read off each folder on every call, as a project's
 * origin is wherever its folder points now.
 */
export async function githubOrigins(ctx: Pick<OrchestratorContext, "store" | "tenant" | "dataDir">): Promise<{ name: string; url: string }[]> {
  const repos = new Map<string, string>();
  for (const repo of await ctx.store.listRepos(ctx.tenant)) {
    const path = localRepoPath(repo.url);
    const origin = path ? (await projectFacts(path, { dataDir: ctx.dataDir }).catch(() => null))?.origin : null;
    if (origin?.forge !== "github") continue;
    const name = new URL(origin.web).pathname.slice(1);
    if (/^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/.test(name)) repos.set(name, origin.web);
  }
  return [...repos].map(([name, url]) => ({ name, url })).sort((a, b) => a.name.localeCompare(b.name));
}
