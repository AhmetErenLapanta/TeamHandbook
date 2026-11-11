/** Whether a project's folder is a git repository, and whether that repository names an origin. */
export type GitState = "none" | "repo" | "origin";

/** Where a project's origin is, without the user or token its address was written with. */
export interface ProjectOrigin {
  forge: "github" | "gitlab" | "other";
  web: string;
}

/** What the orchestrator reads off a project's folder each time it is asked, never what was true when it was opened. */
export interface ProjectFacts {
  git: GitState;
  origin: ProjectOrigin | null;
  name: string;
  kind: "skills" | "code";
  /** A git repository with no commit yet: there is nothing for a sync to read until its first one. */
  empty: boolean;
  /** For a folder that is no git repository itself: how many working copies sit under it, two levels deep, at most 50; a task there works in each one it changes. */
  repos?: number;
}

/** Why a folder is not one a project is opened on. */
export type FolderRefusal = "not-absolute" | "not-found" | "not-a-folder" | "outside-home" | "home-itself" | "hidden" | "library" | "data-dir";

export interface FolderEntry {
  name: string;
  /** The folder's full real path: the server decides what is allowed, never the screen. */
  path: string;
  git: GitState;
  markers: string[];
  /** For a folder that is no git repository itself: how many working copies sit under it, two levels deep, at most 50. */
  repos?: number;
  /** When the folder last changed, on a suggestion or a match. */
  touchedAt?: string;
}

export interface FolderList {
  under: string;
  /** The folder one level up, or null at the home folder. */
  parent: string | null;
  folders: FolderEntry[];
  /** Folders that look like projects, the most recently changed first; given only when no folder was asked for. */
  suggestions: FolderEntry[];
  /** Folders whose name holds the search, when one was given. */
  matches?: FolderEntry[];
  /** Set when a scan stopped at its limit of entries or time. */
  truncated: boolean;
}
