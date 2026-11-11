import type { RepoRecord } from "../store.js";
import type { RequestStatus } from "../../shared/activity.js";
import type { HostedForge } from "../../shared/forge-def.js";

/** One file in a proposed change. `content: null` deletes it. */
export interface FileChange {
  path: string;
  content: string | null;
}

/**
 * Everything the orchestrator proposes to a team repository travels as one of these: a branch
 * off a known commit, carrying whole files, opened as a request a person approves. Nothing
 * the orchestrator does writes to a team's default branch directly.
 */
export interface ChangeRequest {
  title: string;
  body: string;
  /**
   * The commit's body, when it is not the request's description. A task's description quotes
   * its agent's report, and a commit message is what a tracker integration reads for smart
   * commands and closing words, so a task's commit carries only lines the orchestrator wrote.
   */
  commitBody?: string;
  /** The branch to create. The provider refuses one that already exists. */
  branch: string;
  /** The commit the change was prepared against: the mirror's head the screen showed. */
  baseSha: string;
  files: FileChange[];
  /** Who asked, as the orchestrator knows them; recorded as the commit author. */
  author: { name: string; email: string };
  /** The team's reviewers and labels from its team file, and the asker's forge login when known. */
  assignment?: RequestAssignment;
}

/** A new commit for a request's branch, on top of the head it was prepared against: fast-forward alone. */
export interface BranchUpdate {
  files: FileChange[];
  /** The commit's subject. */
  title: string;
  commitBody?: string;
  /** Who asked; recorded as the commit's author. */
  author: { name: string; email: string };
  /** The branch's head the change was prepared on. A branch that moved since refuses the update, never loses what moved it. */
  expectedHead: string;
}

/** A branch a runner on the person's machine already pushed, for the orchestrator to open a request from. */
export interface PushedBranch {
  title: string;
  body: string;
  branch: string;
  /** The commit the task started from: the branch has to descend from it where the orchestrator can tell. */
  baseSha: string;
  /** The branch the request goes into; the repository's default when left out. */
  target?: string;
  assignment?: RequestAssignment;
}

export interface RequestAssignment {
  reviewers: string[];
  labels: string[];
  assignee?: string;
}

export interface OpenedRequest {
  number: number;
  url: string;
  branch: string;
  headSha: string;
  /**
   * What the forge would not take after the request existed: an unknown reviewer, a label it
   * refused. The request is open either way; reporting these as a failure would have the
   * person retry onto a branch that now exists.
   */
  notes?: string[];
}

export type { RequestStatus };

export interface RequestRecord extends OpenedRequest {
  tenant: string;
  repoId: string;
  title: string;
  status: RequestStatus;
  provider: ForgeKind;
  createdAt: string;
  createdBy: string;
  /** When it was merged, as the forge says or the orchestrator merged it; absent for one not merged, or merged before the orchestrator kept the time. */
  mergedAt?: string;
  /** The last head of a task's request that passed the check of a pushed branch; absent before any. */
  checkedHead?: string;
  /** The head that failed that check and why: the request is held until a later head passes. Absent when it is not held. */
  heldHead?: string;
  heldReason?: string;
}

/** Where a request stands on its forge, with the time the forge gives for its merge. */
export interface ForgeState {
  status: RequestStatus;
  mergedAt: string | null;
  /** The request's head as the forge has it now, for a re-check of what was pushed; absent where the forge did not say. */
  headSha?: string;
}

/** A forge's word on a request, with the head it names kept only when it is a full commit id. */
export function forgeState(status: RequestStatus, mergedAt: string | null, head: unknown): ForgeState {
  return { status, mergedAt, ...(typeof head === "string" && /^[0-9a-f]{40}$/.test(head) ? { headSha: head } : {}) };
}

export type ForgeKind = "local" | HostedForge;

/**
 * How a change reaches a forge. `local` keeps the request in the orchestrator's own store and
 * the branch in a bare repository the orchestrator can reach by path: the demo, the tests, and
 * a team with no forge at all. `gitlab` and `github` open a real request with a token the
 * orchestrator holds for that repository.
 */
export interface ForgeProvider {
  readonly kind: ForgeKind;
  open(repo: RepoRecord, change: ChangeRequest): Promise<OpenedRequest>;
  /** A new commit on a request's branch on top of `update.expectedHead`; refused with ForgeRefusal when the branch moved meanwhile. */
  updateBranch?(repo: RepoRecord, branch: string, update: BranchUpdate): Promise<{ headSha: string }>;
  /** A request for a branch already pushed, by a runner on the person's machine: nothing is written to the branch, and it is never taken back. */
  openForBranch?(repo: RepoRecord, pushed: PushedBranch): Promise<OpenedRequest>;
  /** Where a request stands on the forge. The local forge's answer lives in the store, so it has none. */
  status?(repo: RepoRecord, number: number): Promise<ForgeState>;
  /** What waits to be merged in the team repository, whoever opened it, most recently updated first and at most PENDING_LIMIT. */
  list?(repo: RepoRecord): Promise<PendingShare[]>;
  /** A check's outcome on a commit, where the forge shows a request's checks; never a comment. */
  setCommitStatus?(sha: string, check: CommitCheck): Promise<void>;
}

/** One check on a commit: the forge shows it beside the request and can require it before a merge. */
export interface CommitCheck {
  state: "pending" | "success" | "failure" | "error";
  context: string;
  /** At most 140 characters, the shortest limit of the two forges. */
  description: string;
}

/** The most a listing of what waits to be merged reads from a forge in one go. */
export const PENDING_LIMIT = 50;

/**
 * A request open on the team repository, or on the local forge a branch not merged into the
 * default one. Its title and author come from whoever pushed it, so they are shown as text.
 */
export interface PendingShare {
  /** The forge's number; null for a local branch no request of the orchestrator's names. */
  number: number | null;
  title: string;
  branch: string;
  url: string | null;
  author: string;
  updatedAt: string;
  /** Opened from another repository - a fork - whose branch name says nothing about who made it. */
  fromFork: boolean;
}

const TEXT_MAX = 200;

/** A time the forge gives, kept only as a UTC ISO time; anything else reads as not given. */
export function forgeTime(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 40) return null;
  const at = Date.parse(value);
  return Number.isFinite(at) ? new Date(at).toISOString() : null;
}

/** A link the forge gives, shown only as an http(s) address: the screen makes it a link, and a `javascript:` one would run there. */
export function shownUrl(value: unknown): string | null {
  return typeof value === "string" && /^https?:\/\//i.test(value) && URL.canParse(value) ? value : null;
}

/** A title or a name from the forge as a listing shows it: on one line, without control characters, and short. */
export function shownText(value: unknown): string {
  return typeof value === "string" ? value.replace(/\p{C}+/gu, " ").trim().slice(0, TEXT_MAX) : "";
}

/** How a repository on a hosted forge is reached. The token is kept apart, sealed in the vault. */
export interface ForgeConfig {
  repoId: string;
  kind: HostedForge;
  /** The API root: https://gitlab.com/api/v4, https://api.github.com, or a self-hosted one. */
  apiUrl: string;
  /** GitLab's project path (group/name) or GitHub's owner/name. */
  project: string;
}

export interface ForgeConfigStore {
  getForgeConfig(tenant: string, repoId: string): Promise<ForgeConfig | null>;
  setForgeConfig(tenant: string, config: ForgeConfig): Promise<void>;
  deleteForgeConfig(tenant: string, repoId: string): Promise<void>;
}
