import { realpath } from "node:fs";
import { lstat, readdir, readFile, stat } from "node:fs/promises";
import { promisify } from "node:util";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { Hono } from "hono";
import type { FolderEntry, FolderList, FolderRefusal, GitState, ProjectFacts, ProjectOrigin } from "../shared/projects.js";
import type { OrchestratorContext } from "./app.js";
import type { OrchestratorEnv, Principal } from "./auth.js";
import { manages } from "./auth.js";
import { localRepoPath } from "./forge/local.js";
import { onWindowsFromWsl } from "./local.js";
import { WORKING_COPIES_MAX, workingCopies } from "../runner/workspace.js";
import { localMode } from "./mode.js";
import { route } from "./route-scopes.js";
import type { RepoRecord } from "./store.js";

export interface Where {
  home?: string;
  dataDir: string;
}

const MESSAGES: Record<FolderRefusal, string> = {
  "not-absolute": "give the folder's full path",
  "not-found": "no folder is at that path",
  "not-a-folder": "that path is a file, not a folder",
  "outside-home": "that folder is outside your home folder; open one inside it",
  "home-itself": "that is your home folder itself; open a folder inside it",
  hidden: "that folder is hidden; open one whose path has no part starting with a dot",
  library: "that folder is inside Library, which holds the system's and apps' own files; open one of your own",
  "data-dir": "that folder holds the orchestrator's own data; open another",
};

/** What a refused folder answers with, the same on every route that takes one. */
export function folderRefusalStatus(refused: FolderRefusal): 400 | 404 {
  return refused === "not-found" ? 404 : 400;
}

// Both sides come from the system's own realpath, which gives each name as it is on disk, so they compare as they are.
const within = (outer: string, inner: string) => {
  const rel = relative(outer, inner);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

const nativeRealpath = promisify(realpath.native);

/** The home folder by its real path, as every listing and folder rule reads it. */
export async function homeReal(home: string = homedir()): Promise<string> {
  return (await realOf(home)) ?? home;
}

/** The real path the system itself resolves, links and the case of names on disk included, or null when nothing is there. */
async function realOf(path: string): Promise<string | null> {
  return nativeRealpath(path).catch(() => null);
}

/**
 * Whether a folder is one a project opens on: by its real path, inside the home folder and not the
 * home folder itself, with no hidden part, not in Library, and neither inside nor around the
 * orchestrator's own data, which an agent working there would otherwise write to. Called at every
 * use, opening, a task's start, a snapshot, an undo and a machine's run, so a folder swapped for a
 * link after it was opened gets no further. `listing` is for a folder the picker only reads names
 * in: the home folder itself is listed, and a folder around the data, which an agent never works
 * in from a list, is not refused for it.
 */
export async function projectFolder(path: string, { home = homedir(), dataDir }: Where, listing = false): Promise<{ real: string } | { refused: FolderRefusal; message: string }> {
  const no = (refused: FolderRefusal) => ({ refused, message: MESSAGES[refused] });
  if (!isAbsolute(path)) return no("not-absolute");
  const real = await realOf(path);
  if (!real) return no("not-found");
  if (!(await stat(real)).isDirectory()) return no("not-a-folder");
  const homeReal = (await realOf(home)) ?? home;
  if (!within(homeReal, real)) return { refused: "outside-home", message: onWindowsFromWsl(real) ?? MESSAGES["outside-home"] };
  const rel = relative(homeReal, real);
  if (rel === "" && !listing) return no("home-itself");
  const parts = rel ? rel.split(sep) : [];
  if (parts.some((part) => part.startsWith("."))) return no("hidden");
  if (parts[0]?.toLowerCase() === "library") return no("library");
  const dataReal = (await realOf(dataDir)) ?? dataDir;
  if (within(dataReal, real) || (!listing && within(real, dataReal))) return no("data-dir");
  return { real };
}

const exists = (path: string) => lstat(path).then(() => true, () => false);

/**
 * A project on a folder of a person's machine is recorded by the machine and the folder's path
 * from that machine's home, `machine:<id>:~/...`: nothing here reads it, and the machine checks
 * the folder by its own rule each time it works there.
 */
export function machineProjectUrl(machineId: string, path: string): string {
  return `machine:${machineId}:${path}`;
}

/** The machine and `~` path a machine project's address names; null for any other address. */
export function machineFolderOf(url: string): { machineId: string; path: string } | null {
  const found = /^machine:([^:]+):(~(?:\/.*)?)$/.exec(url);
  return found ? { machineId: found[1]!, path: found[2]! } : null;
}

/**
 * Whether a record holds the requests of a repository a task found in a project's folder: its id is
 * `<project>--<path>` and its path is inside that folder, so it belongs to the project and is no
 * project of its own. Both are asked, since a project's own id can hold `--`.
 */
function inProjectFolder(repo: RepoRecord, repos: readonly RepoRecord[]): boolean {
  const path = localRepoPath(repo.url);
  return path !== null && repos.some((project) => {
    const folder = localRepoPath(project.url);
    return folder !== null && repo.id.startsWith(`${project.id}--`) && path.startsWith(`${folder}${sep}`);
  });
}

/**
 * The projects a person is shown: every one but a folder on someone else's machine, whose name and
 * path from that machine's home are its person's alone, as its folder list is. An owner or admin,
 * who answers for the organization's projects, is shown all. A record a task keeps for a repository
 * in a project's folder is shown to nobody.
 */
export async function shownProjects(ctx: Pick<OrchestratorContext, "store" | "tenant">, user: Principal, listed: RepoRecord[]): Promise<RepoRecord[]> {
  const repos = listed.filter((r) => !inProjectFolder(r, listed));
  if (manages(user) || !repos.some((r) => machineFolderOf(r.url))) return repos;
  const mine = new Set((await ctx.store.listMachines(ctx.tenant, user.id)).map((m) => m.id));
  return repos.filter((r) => {
    const folder = machineFolderOf(r.url);
    return !folder || mine.has(folder.machineId);
  });
}

/** Whether a folder is a git repository at all: a working one with `.git`, or a bare one; a plain folder has nothing to sync. */
export async function isGitFolder(path: string): Promise<boolean> {
  return (await exists(join(path, ".git"))) || ((await exists(join(path, "HEAD"))) && (await exists(join(path, "objects"))));
}

/** An origin's address as a page links to it: https, with neither user nor token, and no `.git`. */
export function originOf(remote: string): ProjectOrigin | null {
  const scp = /^(?:ssh:\/\/)?[^@/\s]+@([^:/\s]+)(?::\d+)?[:/]([^\s]+?)(?:\.git)?\/?$/.exec(remote.trim());
  let host: string;
  let path: string;
  if (scp && !/^https?:/i.test(remote)) [host, path] = [scp[1]!, scp[2]!];
  else if (URL.canParse(remote) && /^https?:$/.test(new URL(remote).protocol)) {
    const url = new URL(remote);
    [host, path] = [url.host, url.pathname.replace(/^\/+|\/+$/g, "").replace(/\.git$/, "")];
  } else return null;
  const forge = host === "github.com" ? "github" : host === "gitlab.com" ? "gitlab" : "other";
  return { forge, web: `https://${host}/${path}` };
}

/** The origin url a repository's config file names, read as text: no git runs in a folder that is not the orchestrator's own. */
export function originInConfig(config: string): string | null {
  let inOrigin = false;
  for (const raw of config.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("[")) inOrigin = /^\[\s*remote\s+"origin"\s*\]$/.test(line);
    else if (inOrigin) {
      const set = /^url\s*=\s*(.+)$/.exec(line);
      if (set) return set[1]!.trim().replace(/^"(.*)"$/, "$1");
    }
  }
  return null;
}

/**
 * The git folders of the repository a folder is, its own and the one its config and branches are
 * in; undefined for no git at all, null when there is none to read: the folder itself when it is a
 * bare repository, `.git` a folder, or a file
 * that points at one (a worktree, a submodule), whose target has to stay inside the home folder
 * and away from the orchestrator's data. A worktree's own folder keeps its HEAD and the
 * repository it was made from keeps its origin and branches, named by its `commondir`.
 */
async function gitDirsOf(real: string, where: Required<Where>): Promise<{ own: string; common: string } | null | undefined> {
  const dotGit = join(real, ".git");
  const found = await lstat(dotGit).catch(() => null);
  // A bare repository is its own git folder, as isGitFolder reads it.
  if (!found) return (await exists(join(real, "HEAD"))) && (await exists(join(real, "objects"))) ? { own: real, common: real } : undefined;
  if (found.isDirectory()) return { own: dotGit, common: dotGit };
  if (!found.isFile()) return null;
  const pointer = /^gitdir:\s*(.+)$/m.exec(await readFile(dotGit, "utf8").catch(() => ""))?.[1]?.trim();
  if (!pointer) return null;
  const target = await realOf(isAbsolute(pointer) ? pointer : join(real, pointer));
  const homeReal = (await realOf(where.home)) ?? where.home;
  const dataReal = (await realOf(where.dataDir)) ?? where.dataDir;
  if (!target || !within(homeReal, target) || within(dataReal, target) || within(target, dataReal)) return null;
  const common = (await readFile(join(target, "commondir"), "utf8").catch(() => "")).trim();
  return { own: target, common: common ? join(target, common) : target };
}

/** Whether the branch HEAD names has no commit, read off the ref files: a HEAD that names a commit, or that cannot be read, is not empty. */
async function noCommitYet(dirs: { own: string; common: string }): Promise<boolean> {
  const branch = /^ref:\s*(refs\/heads\/\S+)\s*$/.exec(await readFile(join(dirs.own, "HEAD"), "utf8").catch(() => ""))?.[1];
  if (!branch || branch.split("/").includes("..")) return false;
  if (await exists(join(dirs.common, branch))) return false;
  const packed = await readFile(join(dirs.common, "packed-refs"), "utf8").catch(() => "");
  return !packed.split("\n").some((line) => line.endsWith(` ${branch}`));
}

/** What a project's folder is now: git or not, its origin, and the name and kind it gets without being asked. */
export async function projectFacts(real: string, { home = homedir(), dataDir }: Where): Promise<ProjectFacts> {
  const kind = (await exists(join(real, ".claude-plugin", "marketplace.json"))) || (await exists(join(real, ".claude-plugin", "plugin.json"))) ? "skills" : "code";
  const dirs = await gitDirsOf(real, { home, dataDir });
  if (dirs === undefined) {
    const repos = await repoCount(real);
    return { git: "none", origin: null, name: basename(real), kind, empty: false, ...(repos ? { repos } : {}) };
  }
  const config = dirs ? await readFile(join(dirs.common, "config"), "utf8").catch(() => null) : null;
  const remote = config ? originInConfig(config) : null;
  const origin = remote ? originOf(remote) : null;
  return { git: origin ? "origin" : "repo", origin, name: basename(real), kind, empty: dirs ? await noCommitYet(dirs) : false };
}

const MARKERS = [".git", "package.json", "pyproject.toml", "go.mod", "Cargo.toml", ".claude-plugin"];
// Reading inside these asks macOS for a permission on the orchestrator's behalf: a scan does not
// go in until the person opens one of them themselves.
export const ASKS_FIRST = new Set(["desktop", "documents", "downloads", "pictures", "movies", "music"]);
export const SKIPPED = new Set(["node_modules", "library"]);
export const ROOTS = ["code", "Projects", "projects", "src", "dev", "Developer", "work", "repos", ""];
const PAGE = 500;
const SCAN_ENTRIES = 5_000;
const SCAN_MS = 1_000;
const SCAN_DEPTH = 3;
const SUGGESTIONS = 12;
const MATCHES = 50;

/** Where reading is allowed: the home folder, and the folder the person opened, which lets the picker inside a protected one. */
interface Reach {
  homeReal: string;
  opened?: string;
}

/**
 * Whether reading inside a folder asks macOS for a permission the person has not given by opening
 * it: one of the home's Desktop, Documents, Downloads and the like, or anything in one, by its real
 * path, so a link that leads into one is caught too.
 */
function asksFirst(real: string, { homeReal, opened }: Reach): boolean {
  if (!within(homeReal, real)) return false;
  const top = relative(homeReal, real).split(sep)[0] ?? "";
  if (!ASKS_FIRST.has(top.toLowerCase())) return false;
  return !(opened && within(join(homeReal, top), opened));
}

async function markersOf(path: string, reach: Reach): Promise<string[]> {
  // Its name is shown; what is inside waits until the person opens it.
  if (asksFirst(path, reach)) return [];
  const names = await readdir(path).catch(() => [] as string[]);
  return [...MARKERS.filter((m) => names.includes(m)), ...(names.some((n) => n.endsWith(".xcodeproj")) ? ["*.xcodeproj"] : [])];
}

/** The working copies under a folder that is none itself, counted as a task there finds them: at most 50. */
async function repoCount(path: string): Promise<number> {
  const found = await workingCopies(path).catch(() => [] as string[]);
  return "tooMany" in found ? WORKING_COPIES_MAX : found.length;
}

async function entryOf(path: string, reach: Reach, touched = false): Promise<FolderEntry> {
  const markers = await markersOf(path, reach);
  const at = touched ? (await stat(path).catch(() => null))?.mtime.toISOString() : undefined;
  const git = markers.includes(".git") ? "repo" : "none";
  // Counted only where the markers were read: a folder macOS guards is not looked into until the person opens it.
  const repos = git === "none" && !asksFirst(path, reach) ? await repoCount(path) : undefined;
  return { name: basename(path), path, git, markers, ...(repos ? { repos } : {}), ...(at ? { touchedAt: at } : {}) };
}

/** The folders inside one, by lstat alone: hidden ones and the system's left out, a link only where its real path passes the rule. */
async function childrenOf(real: string, where: Required<Where>): Promise<string[]> {
  const listed = await readdir(real, { withFileTypes: true }).catch(() => []);
  const found: string[] = [];
  for (const d of listed) {
    if (found.length >= PAGE) break;
    if (d.name.startsWith(".") || SKIPPED.has(d.name.toLowerCase()) || !(d.isDirectory() || d.isSymbolicLink())) continue;
    const checked = await projectFolder(join(real, d.name), where);
    if (!("refused" in checked)) found.push(checked.real);
  }
  return found.sort((a, b) => basename(a).localeCompare(basename(b)));
}

/** A bounded walk from the common roots: depth, entries and time capped, never into a folder macOS asks a permission for. */
async function scan(where: Required<Where>, keep: (path: string, markers: string[]) => boolean, limit: number): Promise<{ found: FolderEntry[]; truncated: boolean }> {
  const homeReal = (await realOf(where.home)) ?? where.home;
  const started = Date.now();
  let visited = 0;
  let truncated = false;
  const found = new Map<string, FolderEntry>();
  const queue: { path: string; depth: number }[] = [];
  const reach: Reach = { homeReal };
  for (const root of ROOTS) {
    const real = await realOf(root ? join(homeReal, root) : homeReal);
    if (real && !asksFirst(real, reach)) queue.push({ path: real, depth: 0 });
  }
  const seen = new Set<string>();
  while (queue.length) {
    if (visited >= SCAN_ENTRIES || Date.now() - started > SCAN_MS) {
      truncated = true;
      break;
    }
    const { path, depth } = queue.shift()!;
    if (seen.has(path)) continue;
    seen.add(path);
    const names = await readdir(path, { withFileTypes: true }).catch(() => []);
    visited += names.length;
    for (const d of names) {
      if (!d.isDirectory() || d.name.startsWith(".") || SKIPPED.has(d.name.toLowerCase())) continue;
      const checked = await projectFolder(join(path, d.name), where);
      if ("refused" in checked || asksFirst(checked.real, reach)) continue;
      const child = checked.real;
      const markers = await markersOf(child, reach);
      if (keep(child, markers) && !found.has(child)) found.set(child, await entryOf(child, reach, true));
      // A project's own folders are its own, not further projects to suggest.
      if (!markers.length && depth + 1 < SCAN_DEPTH) queue.push({ path: child, depth: depth + 1 });
    }
  }
  const sorted = [...found.values()].sort((a, b) => (b.touchedAt ?? "").localeCompare(a.touchedAt ?? ""));
  return { found: sorted.slice(0, limit), truncated: truncated || sorted.length > limit };
}

/** The folders opened before, then the project-looking ones a scan finds, to the one limit. */
async function suggestions(where: Required<Where>, homeReal: string, opened: readonly string[]): Promise<{ found: FolderEntry[]; truncated: boolean }> {
  const again: FolderEntry[] = [];
  for (const path of opened) {
    const checked = await projectFolder(path, where);
    // The person opened it: reading inside it asks nothing they have not already given.
    if (!("refused" in checked) && !again.some((e) => e.path === checked.real)) again.push(await entryOf(checked.real, { homeReal, opened: checked.real }, true));
  }
  again.sort((a, b) => (b.touchedAt ?? "").localeCompare(a.touchedAt ?? ""));
  // A code root holding several working copies is the one folder a person works in: offered as it is, so opening it
  // takes one pick rather than finding it among its repositories.
  for (const name of ROOTS.filter(Boolean)) {
    const checked = await projectFolder(join(homeReal, name), where);
    if ("refused" in checked || again.some((e) => e.path === checked.real)) continue;
    const entry = await entryOf(checked.real, { homeReal }, true);
    if ((entry.repos ?? 0) >= 2) again.push(entry);
  }
  const room = Math.max(SUGGESTIONS - again.length, 0);
  const scanned = room ? await scan(where, (path, markers) => markers.length > 0 && !again.some((e) => e.path === path), room) : { found: [], truncated: false };
  return { found: [...again.slice(0, SUGGESTIONS), ...scanned.found], truncated: scanned.truncated || again.length > SUGGESTIONS };
}

/**
 * The folders a person picks a project from: one folder's children, the project-looking folders of
 * the common roots, or the ones whose name holds `q`. `opened` are the folders already opened as
 * projects: they are suggested first, the most recently changed first, each still by the folder
 * rule, so a folder with no project file of any kind is found again on the first screen.
 */
export async function listFolders(under: string | undefined, q: string | undefined, where: Where, opened: readonly string[] = []): Promise<FolderList | { refused: FolderRefusal; message: string }> {
  const full = { home: where.home ?? homedir(), dataDir: where.dataDir };
  const homeReal = (await realOf(full.home)) ?? full.home;
  const checked = await projectFolder(under ?? homeReal, full, true);
  if ("refused" in checked) return checked;
  const at = checked.real;
  const atHome = at === homeReal;
  // The folder asked for is one the person opened: inside a protected one, its own folders are read too.
  const folders = await Promise.all((await childrenOf(at, full)).map((path) => entryOf(path, { homeReal, opened: at })));
  const search = q?.trim().toLowerCase();
  const suggested = !under && !search ? await suggestions(full, homeReal, opened) : null;
  const matched = search ? await scan(full, (path) => basename(path).toLowerCase().includes(search), MATCHES) : null;
  return {
    under: at,
    parent: atHome ? null : dirname(at),
    folders,
    suggestions: suggested?.found ?? [],
    ...(matched ? { matches: matched.found } : {}),
    truncated: Boolean(suggested?.truncated || matched?.truncated || folders.length >= PAGE),
  };
}

/** Who reads a local orchestrator's folders: its owner, signed in, never a key, a task's token or a machine. */
export function browsesFolders(user: Principal): boolean {
  return !user.key && manages(user);
}

/** The folder picker's one route: a local orchestrator's owner only. */
export function localFolderRoutes(ctx: OrchestratorContext, home?: string): Hono<OrchestratorEnv> {
  const app = new Hono<OrchestratorEnv>();
  route(app, "GET /api/local/folders", async (c) => {
    if (!localMode()) return c.json({ error: "not found" }, 404);
    const user = c.get("user");
    if (!browsesFolders(user)) return c.json({ error: "only this machine's owner browses its folders" }, 403);
    const opened = (await ctx.store.listRepos(ctx.tenant)).flatMap((r) => localRepoPath(r.url) ?? []);
    const listed = await listFolders(c.req.query("under") || undefined, c.req.query("q"), { ...(home ? { home } : {}), dataDir: ctx.dataDir }, opened);
    if ("refused" in listed) return c.json({ error: listed.message, code: listed.refused }, listed.refused === "not-found" ? 404 : 400);
    return c.json(listed);
  });
  return app;
}

export type { GitState };
