import { lstat, stat } from "node:fs/promises";
import { join } from "node:path";
import type { OrchestratorContext } from "../app.js";
import type { Principal } from "../auth.js";
import { recordEvent } from "../events.js";
import { localRepoPath } from "../forge/local.js";
import { isGitFolder, machineFolderOf } from "../projects.js";
import type { RepoRecord } from "../store.js";
import { workingCopies } from "../../runner/workspace.js";

/**
 * Whether a person trusts the Claude Code settings a folder of theirs carries, asked once per
 * project on a task's page and off until they say yes. A folder's own settings can run programs
 * and send the model and the sign-in elsewhere (apiKeyHelper, env), and print mode asks nobody,
 * so a run as them loads only their user settings until they trust it.
 */
export type FolderTrust = "unasked" | "trusted" | "declined";

const trustKey = (repoId: string) => `folder.trust.${repoId}`;

export async function folderTrust(ctx: Pick<OrchestratorContext, "store" | "tenant">, repoId: string): Promise<FolderTrust> {
  const value = await ctx.store.getSetting(ctx.tenant, trustKey(repoId));
  return value === "trusted" || value === "declined" ? value : "unasked";
}

/** Takes a project's trust back to unasked, as when its record moves to another folder: a folder trusted before is not this one. */
export async function forgetFolderTrust(ctx: Pick<OrchestratorContext, "store" | "tenant">, repoId: string): Promise<void> {
  await ctx.store.deleteSetting(ctx.tenant, trustKey(repoId));
}

export async function setFolderTrust(ctx: OrchestratorContext, actor: Principal, repoId: string, trusted: boolean): Promise<FolderTrust> {
  const trust: FolderTrust = trusted ? "trusted" : "declined";
  await ctx.store.setSetting(ctx.tenant, trustKey(repoId), trust);
  await recordEvent(ctx, actor, "project.folder-trust", { repoId, subject: `repo:${repoId}`, detail: trusted ? `trusted the folder's own Claude Code settings for tasks that run as its person` : `kept the folder's own Claude Code settings out of tasks` });
  return trust;
}

/**
 * The folder a project is worked on in place: one on this machine that is no git repository at
 * all, neither a working one nor a bare one (a repository connected by path is often bare), or null.
 */
export async function inPlaceFolder(repo: RepoRecord): Promise<string | null> {
  const path = localRepoPath(repo.url);
  if (!path || !(await lstat(path).then((found) => found.isDirectory(), () => false))) return null;
  return (await isGitFolder(path)) ? null : path;
}

/** Whether a task's agent works in the person's own folder itself, on this machine or theirs, rather than in a clone the orchestrator makes. */
export async function opensInPlace(repo: RepoRecord): Promise<boolean> {
  return Boolean(machineFolderOf(repo.url)) || Boolean(await inPlaceFolder(repo));
}

/**
 * Whether a task's agent works in the folder itself, where the folder's own settings are the person's to trust.
 * A folder holding repositories is worked on in a task copy of each, which loads its person's user settings alone.
 */
export async function trustsOwnFolder(ctx: Pick<OrchestratorContext, "addedRepos">, repo: RepoRecord): Promise<boolean> {
  if (machineFolderOf(repo.url)) {
    const opened = ctx.addedRepos?.get(repo.id)?.machine;
    return !opened?.repos && (opened?.git ?? "none") === "none";
  }
  const folder = await inPlaceFolder(repo);
  if (!folder) return false;
  const copies = await workingCopies(folder, 1);
  return Array.isArray(copies) && copies.length === 0;
}

/**
 * Whether trusting the folder would change what its tasks load: Claude Code reads a folder's own settings only from these
 * two files, the sources a trusted folder turns on. A folder on another machine is not read from here, so it is asked.
 */
async function hasOwnSettings(repo: RepoRecord): Promise<boolean> {
  const folder = await inPlaceFolder(repo);
  if (!folder) return true;
  const there = (path: string) => stat(join(folder, ".claude", path)).then((s) => s.isFile(), () => false);
  return (await there("settings.json")) || (await there("settings.local.json"));
}

/**
 * A project's trust choice for its page and its tasks': its folder's, or null where no folder of the person's is worked
 * on itself, or where the folder has no settings of its own, so trusting it would change nothing and nothing is asked.
 */
export async function projectTrust(ctx: Pick<OrchestratorContext, "store" | "tenant" | "addedRepos">, repo: RepoRecord): Promise<FolderTrust | null> {
  if (!(await trustsOwnFolder(ctx, repo))) return null;
  const trust = await folderTrust(ctx, repo.id);
  return trust === "unasked" && !(await hasOwnSettings(repo)) ? null : trust;
}
