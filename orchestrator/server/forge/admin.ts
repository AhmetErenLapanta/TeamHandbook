import { OrchestratorError } from "../errors.js";
import { ForgeHttpError } from "./http.js";
import type { ForgeHttp } from "./http.js";

/**
 * What a forge's driver does to repositories themselves, apart from requests: list what the org's
 * connection reaches, tell an empty repository, create one, write a new repository's scaffold and
 * describe a webhook. A driver gets only a ForgeHttp - the forge's API at an address already held,
 * with the token in a header it masks - and never the orchestrator's store, vault or settings, so all
 * it can reach is the forge it is for.
 */

/** At most this many repositories are listed for a connection: the ones it touched last. */
export const LISTED_MAX = 100;

export const NOT_EMPTY = "that repository already has commits; the orchestrator writes to it only through requests, so connect it instead";

/** A refusal from setting up the team repository, said to the person as it is. */
export class SetupRefused extends OrchestratorError {
  constructor(message: string, status: 400 | 403 | 404 | 409 | 502 = 400) {
    super("team-repo", message, status);
  }
}

/** One step a person takes on the forge, with the page it is taken on. */
export interface ForgeStep {
  text: string;
  url: string | null;
}

/**
 * The forge lets only the account's owner create the repository, as GitHub does for an app on a
 * personal account: the way there is said as steps, each with the page it is taken on.
 */
export class MakeItOnGitHub extends SetupRefused {
  constructor(
    message: string,
    readonly steps: ForgeStep[],
  ) {
    super(message, 409);
  }
}

/** A repository the orchestrator is about to write a team's scaffold to. */
export interface RepoTarget {
  fullName: string;
  url: string;
  /** How the forge's API names it: GitLab's project number, GitHub's owner/name as a path. */
  apiId: string;
  created: boolean;
}

export interface ListedOnForge {
  fullName: unknown;
  url: unknown;
  empty: boolean;
}

export interface NewRepository {
  name: string;
  visibility: string;
  /** GitLab only: the group to create it in. */
  namespace?: string;
}

/** Who the connection reaches on the forge, and the pages a person is sent to when the orchestrator cannot create a repository itself. */
export interface ConnectedAccount {
  account: string;
  organization: boolean;
  webUrl: string;
  /** Where the installation's repositories are chosen; GitHub only. */
  manageUrl: string | null;
}

export interface RepoAdmin {
  /** The visibilities a new repository takes on this forge. */
  visibilities: readonly string[];
  list(http: ForgeHttp): Promise<ListedOnForge[]>;
  /** The repository as a target when it has no branch and no tag at all; NOT_EMPTY otherwise. */
  emptyTarget(http: ForgeHttp, fullName: string, url: string): Promise<RepoTarget>;
  create(http: ForgeHttp, repository: NewRepository, connected: ConnectedAccount): Promise<RepoTarget>;
  /** The scaffold as the repository's first commit, never with force; a push in between is reported, not overwritten. */
  writeScaffold(http: ForgeHttp, target: RepoTarget, files: Record<string, string>, author: { name: string; email: string }, title: string): Promise<void>;
  /** The call that sets a webhook delivering pushes and request changes to `url`, signed with `secret`. */
  webhook(target: RepoTarget, url: string, secret: string): { path: string; body: unknown };
}

/** A forge's refusal during setup, as the person reads it. */
export async function forgeCall<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (err) {
    if (err instanceof ForgeHttpError) throw new SetupRefused(err.message, 502);
    throw err;
  }
}

/** Whether the forge refused a new repository because its name is taken. */
export function nameTaken(err: unknown): boolean {
  return err instanceof ForgeHttpError && (err.status === 400 || err.status === 422) && /taken|exists/i.test(err.message);
}
