import type { OrchestratorContext } from "../app.js";
import { mirrorDir } from "../app.js";
import { gitAsyncMaybe } from "../git.js";
import { machineFolderOf } from "../projects.js";
import type { RepoRecord } from "../store.js";
import { BRANCH } from "./http.js";
import { localRepoPath } from "./local.js";

/** The most branches the start form is offered: the ones committed to most recently. */
export const BRANCHES_MAX = 200;

export interface RepoBranches {
  /** The branch a task starts from when none is picked. */
  default: string | null;
  branches: string[];
}

async function refsByDate(dir: string, pattern: string): Promise<string[]> {
  const listed = await gitAsyncMaybe(["for-each-ref", "--sort=-committerdate", "--format=%(refname)", pattern], dir);
  return (listed ?? "").split("\n").filter(Boolean);
}

/**
 * The branches a task on this repository can start from, for the start form's base. Nothing asks
 * the forge: a repository the orchestrator mirrors is read from its mirror, as fresh as its last
 * sync, and one read by path from the person's own clone, its own branches alone: a task starts at
 * a branch's head in the clone and its request goes into a branch there, so one only on the origin
 * is switched to first. Names git would take as an option or a range are left out. Null for a folder
 * on a machine, whose branches only that machine reads.
 */
export async function repoBranches(ctx: OrchestratorContext, repo: RepoRecord): Promise<RepoBranches | null> {
  const path = localRepoPath(repo.url);
  if (machineFolderOf(repo.url) || (!path && !repo.head)) return null;
  const dir = path ?? mirrorDir(ctx, repo.id);
  const current = (await gitAsyncMaybe(["symbolic-ref", "--quiet", "--short", "HEAD"], dir))?.trim() || null;
  const names = (await refsByDate(dir, "refs/heads")).map((ref) => ref.slice("refs/heads/".length)).filter((name) => BRANCH.test(name) && !name.includes(".."));
  const branches = [...new Set([...(current ? [current] : []), ...names])].slice(0, BRANCHES_MAX);
  return { default: current, branches };
}
