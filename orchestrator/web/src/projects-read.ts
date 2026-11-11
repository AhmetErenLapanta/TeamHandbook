import { call } from "./api";
import type { RepoRecord } from "./api";

/** As PROJE-sozlesme.md section 1 has them; they move to shared/projects.ts with the server's slice. */
export type GitState = "none" | "repo" | "origin";
/** `empty` is a Git repository with no commit yet, which has nothing for the orchestrator to read. */
export interface ProjectFacts { git: GitState; origin: { forge: "github" | "gitlab" | "other"; web: string } | null; name: string; kind: "skills" | "code"; empty?: boolean; repos?: number }
/** `machine` is set for a folder on a connected machine, whose path reads from that machine's home as `~`. */
/** `trust`: a folder worked on in place, how far its own Claude Code settings reach its tasks; null for a project the orchestrator clones. */
export type Project = RepoRecord & { facts: ProjectFacts | null; machine?: { id: string; path: string } | null; trust?: FolderTrust | null };

/** A folder tasks work in, as EK17-EK2-sozlesme.md has it: from the person's own Claude Code, the most recently used first; `about` is its CLAUDE.md's first heading, untrusted text. */
export interface WorkFolder { path: string; name: string; about: string | null; usedAt: string | null; sessions?: number }

export interface FolderEntry { name: string; path: string; git: GitState; markers: string[]; touchedAt?: string; repos?: number }
export interface FolderList { under: string; parent: string | null; folders: FolderEntry[]; suggestions: FolderEntry[]; matches?: FolderEntry[]; truncated: boolean }

/** As FORGE-sozlesme.md dilim 6 has them: what a commit in a project's folder takes, and the message it starts from. */
export interface CommitFile { path: string; status: "added" | "modified" | "deleted" | "renamed"; bytes: number | null; secretLike: boolean }
export interface CommitPlan { files: CommitFile[]; omitted: number; first: boolean; message: string }

/**
 * The one place the folder and project routes are named. The server decides every path: a folder
 * listed, searched for or pasted reaches a project only through its rule, never through this page.
 */
/** A folder's own Claude Code settings, as its person answered once: off until they say yes. */
export type FolderTrust = "unasked" | "trusted" | "declined";

export const projectsRead = {
  /** The orchestrator's own machine, or a connected one, which answers at its next poll. */
  folders: (where: { under?: string; q?: string } = {}, machine?: string) => {
    const query = new URLSearchParams(Object.entries(where).filter((e): e is [string, string] => Boolean(e[1]))).toString();
    const at = machine ? `/api/machines/${encodeURIComponent(machine)}/folders` : "/api/local/folders";
    return call<FolderList>("GET", query ? `${at}?${query}` : at);
  },
  open: (path: string, machine?: string) => call<{ project: Project; existing: boolean }>("POST", "/api/projects", { path, ...(machine ? { machineId: machine } : {}) }),
  /** The folders a task on one person's own orchestrator is routed to, the most recently used first. */
  workFolders: () => call<{ folders: WorkFolder[] }>("GET", "/api/work-folders"),
  /** `home` is the orchestrator's own home on one person's machine, and null where projects sit on connected machines. */
  list: () => call<{ projects: Project[]; last: string | null; home?: string | null }>("GET", "/api/projects"),
  /** Makes the folder a Git repository; no file is added or committed. */
  gitInit: (id: string) => call<{ project: Project }>("POST", `/api/projects/${encodeURIComponent(id)}/git/init`, { commandId: crypto.randomUUID() }),
  commitPlan: (id: string) => call<CommitPlan>("GET", `/api/projects/${encodeURIComponent(id)}/git/commit`),
  /** Each attempt is its own command: a retry after a refusal sends what the person changed, not the answer kept for the last one. */
  commit: (id: string, message: string, exclude: string[]) =>
    call<{ project: Project; headSha: string }>("POST", `/api/projects/${encodeURIComponent(id)}/git/commit`, { commandId: crypto.randomUUID(), message, exclude }),
  /** Cloned with the person's own git sign-in into `into`, or under ~/code when none is named. */
  clone: (url: string, into?: string) =>
    call<{ project: Project; existing: boolean }>("POST", "/api/projects/clone", { commandId: crypto.randomUUID(), url, ...(into ? { into } : {}) }),
  rename: (id: string, name: string) => call<{ project: Project }>("PATCH", `/api/projects/${encodeURIComponent(id)}`, { name }),
  readSkillsFrom: (id: string, skillsFrom: string | null) => call<{ project: Project }>("PATCH", `/api/projects/${encodeURIComponent(id)}`, { skillsFrom }),
  /** Whether the folder's own Claude Code settings load for its next tasks; only the person who opened it says. */
  /** The repositories found in a folder of this machine, as a task there finds them; null for a repository itself or a folder on another machine. */
  repositories: (id: string) => call<{ repositories: { path: string; name: string; openRequests: number }[] | null; tooMany?: boolean }>("GET", `/api/projects/${encodeURIComponent(id)}/repositories`),
  trust: (id: string, trusted: boolean) => call<{ trust: FolderTrust }>("PUT", `/api/projects/${encodeURIComponent(id)}/trust`, { trusted }),
};

/** A pasted `~/…` read against the home the folder list named; the server still decides whether it may be a project. */
export function pastedPath(text: string, home: string | null): string {
  const path = text.trim();
  if (home && (path === "~" || path.startsWith("~/"))) return `${home}${path.slice(1)}`;
  return path;
}

/** A folder's path as the person reads it: from home as `~`, shorter and saying less about the machine. */
export function homeRelative(path: string, home: string | null): string {
  if (!home) return path;
  return path === home ? "~" : path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

/** Where the folder is, as the person reads it: a machine's from its own home, the orchestrator's own from this one. */
export function folderPlace(project: Pick<Project, "url" | "machine">, home: string | null): string {
  return project.machine?.path ?? homeRelative(project.url.replace(/^file:\/\//, ""), home);
}

/** Whether what was typed is a path to open rather than words to search folders for. */
export function looksLikePath(text: string): boolean {
  return /^(~|\/)/.test(text.trim());
}

/** The places between home and a folder, each one a step back up the list. */
export function placeSteps(under: string, home: string): { label: string; path: string }[] {
  if (under !== home && !under.startsWith(`${home}/`)) return [{ label: under, path: under }];
  const parts = under.slice(home.length).split("/").filter(Boolean);
  return [{ label: "~", path: home }, ...parts.map((part, i) => ({ label: part, path: `${home}/${parts.slice(0, i + 1).join("/")}` }))];
}

/** The folder a clone lands in when no place is named: the address's last part, without .git, as the server names it. */
export function cloneName(url: string): string | null {
  const name = url.trim().replace(/\/+$/, "").split(/[/:]/).pop()?.replace(/\.git$/, "") ?? "";
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name) ? name : null;
}
