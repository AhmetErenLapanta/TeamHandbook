import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { OrchestratorError } from "../errors.js";
import { isAbsolute, join, resolve, sep } from "node:path";
import { gitAsync, gitAsyncMaybe, oneAtATime } from "../git.js";
import type { RepoRecord } from "../store.js";
import { forgeState, PENDING_LIMIT, shownText } from "./types.js";
import type { BranchUpdate, ChangeRequest, ForgeProvider, ForgeState, OpenedRequest, PendingShare, PushedBranch } from "./types.js";
import { checkoutBusy, fastForwardCheckout } from "./project-git.js";

const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;

/** The bare repository a file:// URL names, or null when the URL is anything else. */
export function localRepoPath(url: string): string | null {
  if (url.startsWith("file://")) return decodeURIComponent(url.slice("file://".length));
  // A repository connected by path from the screen keeps its plain absolute path, with no scheme.
  return isAbsolute(url) ? url : null;
}

/**
 * A path inside the change must stay inside the repository. The screen builds these paths
 * from names a user typed; one that climbs out, is absolute or names .git is refused before
 * anything is built.
 */
export function safeRepoPath(root: string, path: string): string {
  if (!path || path.startsWith("/") || path.split("/").some((part) => part === ".." || part === "." || part === "" || part === ".git")) {
    throw new Error(`refusing path ${JSON.stringify(path)}`);
  }
  const target = resolve(root, path);
  if (!target.startsWith(resolve(root) + sep)) throw new Error(`refusing path ${JSON.stringify(path)}`);
  return target;
}

/** The repository's own state refuses the change: a link on its path, a branch already there, a conflict. */
export class ForgeRefusal extends OrchestratorError {
  constructor(message: string) {
    super("forge-refused", message, 409);
  }
}

/** Where the local forge keeps the description of the request on `branch`. */
export function localDescriptionRef(branch: string): string {
  return `refs/notes/orchestrator/${branch}`;
}

export interface LocalRequestLedger {
  /** Reserves the next number for good: two callers never receive the same one. */
  nextNumber(tenant: string, repoId: string): Promise<number>;
  /** The branch and head a request was recorded with, for reading where it stands; null for one never recorded. */
  request?(tenant: string, repoId: string, number: number): Promise<{ branch: string; headSha: string } | null>;
}

/** Every path the commit holds as a symbolic link (mode 120000). */
async function symlinksAt(repo: string, commit: string): Promise<Set<string>> {
  const out = await gitAsync(["ls-tree", "-r", "-z", "--full-tree", commit], repo);
  return new Set(
    out
      .split("\0")
      .filter((line) => line.startsWith("120000 "))
      .map((line) => line.slice(line.indexOf("\t") + 1)),
  );
}

/** The link a path would pass through, itself or any folder above it, or null. */
function linkOnPath(links: Set<string>, path: string): string | null {
  const parts = path.split("/");
  for (let i = 1; i <= parts.length; i++) {
    const prefix = parts.slice(0, i).join("/");
    if (links.has(prefix)) return prefix;
  }
  return null;
}

/**
 * A change as one commit on its base, built from git objects alone in `work`, a scratch repository,
 * from the commits `source` holds: no file is written to disk, a path climbing out of the
 * repository or through a symbolic link is refused, and a change that alters nothing is refused.
 * The author is the person who asked; the committer is the orchestrator.
 */
export async function changeCommit(source: string, work: string, change: ChangeRequest, repoName: string): Promise<string> {
  if (!change.files.length) throw new ForgeRefusal("the change has no files");
  for (const file of change.files) safeRepoPath("/repository", file.path);
  const links = await symlinksAt(source, change.baseSha);
  for (const file of change.files) {
    const link = linkOnPath(links, file.path);
    if (link) throw new ForgeRefusal(`refusing ${file.path}: ${link} is a symbolic link in ${repoName}`);
  }
  await gitAsync(["fetch", "--quiet", source, change.baseSha], work);
  await gitAsync(["read-tree", change.baseSha], work);
  for (const file of change.files) {
    if (file.content === null) {
      await gitAsync(["update-index", "--force-remove", "--", file.path], work);
    } else {
      const blob = (await gitAsync(["hash-object", "-w", "--stdin"], work, file.content)).trim();
      await gitAsync(["update-index", "--add", "--cacheinfo", `100644,${blob},${file.path}`], work);
    }
  }
  const tree = (await gitAsync(["write-tree"], work)).trim();
  if (tree === (await gitAsync(["rev-parse", `${change.baseSha}^{tree}`], work)).trim()) throw new ForgeRefusal("the change does not alter the repository");
  // A task's commit carries only its subject and an orchestrator line (commitBody); the agent's
  // report stays in the request's description, never in history a tracker reads.
  return (await gitAsync(["commit-tree", tree, "-p", change.baseSha, "-m", change.title, "-m", change.commitBody ?? change.body], work, undefined, change.author)).trim();
}

/**
 * A scratch repository the change is assembled in. It has a work tree only because git's index
 * commands want one; nothing is ever written into it. Its HEAD names whatever branch git
 * starts with (`master`, with no host config), and git refuses to fetch into a branch that is
 * checked out, so every ref the orchestrator keeps in it lives under `refs/orchestrator/`, never
 * `refs/heads/`: a team repository's branch of the same name - its default `master`, or a
 * request's - is never that checked-out branch.
 */
export async function scratch(workRoot: string, prefix: string): Promise<string> {
  mkdirSync(workRoot, { recursive: true });
  const work = mkdtempSync(join(workRoot, prefix));
  await gitAsync(["init", "--quiet"], work);
  await gitAsync(["config", "maintenance.auto", "false"], work);
  return work;
}

/**
 * Builds the change from git objects alone: each file's content is written as a blob, placed
 * in an index read from the base commit, and committed from that index. No file of the change
 * touches a disk, so a symbolic link in the team's repository has nothing to lead astray; one
 * on a changed path is refused outright, the way the plugin refuses to publish through one.
 * The team's bare repository then fetches the new branch, the way a forge receives one, and
 * its default branch never moves. The request's number is reserved before the branch exists,
 * so two requests opened at once cannot leave a branch without a record.
 */
export function createLocalForge(workRoot: string, ledger: LocalRequestLedger, urlBase = "local://requests"): ForgeProvider {
  return {
    kind: "local",
    async open(repo: RepoRecord, change: ChangeRequest): Promise<OpenedRequest> {
      const bare = localRepoPath(repo.url);
      if (!bare) throw new Error(`${repo.name} is not reachable by path; the local forge only serves file:// repositories`);
      if (!BRANCH.test(change.branch) || change.branch.includes("..")) throw new Error(`invalid branch name ${JSON.stringify(change.branch)}`);
      if (await gitAsyncMaybe(["rev-parse", "--verify", "--quiet", `refs/heads/${change.branch}`], bare)) {
        throw new ForgeRefusal(`branch ${change.branch} already exists in ${repo.name}`);
      }
      const work = await scratch(workRoot, "change-");
      try {
        const headSha = await changeCommit(bare, work, change, repo.name);
        await gitAsync(["update-ref", "refs/orchestrator/change", headSha], work);
        // A hosted forge keeps a request's description beside its branch; here it is a note on
        // the branch's head, under a notes ref of the branch's own so two requests never race for one.
        const notes = localDescriptionRef(change.branch);
        await gitAsync(["notes", "--ref", notes, "add", "-m", change.body || change.title, headSha], work);
        // The commit is built aside; only taking it into the team's repository waits its turn
        // there, and the branch is checked again in that turn, where no other write can race it.
        return await oneAtATime(bare, async () => {
          if (await gitAsyncMaybe(["rev-parse", "--verify", "--quiet", `refs/heads/${change.branch}`], bare)) {
            throw new ForgeRefusal(`branch ${change.branch} already exists in ${repo.name}`);
          }
          const number = await ledger.nextNumber(repo.tenant, repo.id);
          // One atomic fetch: the branch and its description arrive together or neither does.
          await gitAsync(["fetch", "--quiet", "--atomic", work, `refs/orchestrator/change:refs/heads/${change.branch}`, `${notes}:${notes}`], bare);
          return { number, url: `${urlBase}/${repo.id}/${number}`, branch: change.branch, headSha };
        });
      } finally {
        rmSync(work, { recursive: true, force: true });
      }
    },

    // In the repository's turn, and moved only from the head the change was prepared on: a branch
    // that moved meanwhile, or one checked out under the person's files, is refused, never rewritten.
    async updateBranch(repo: RepoRecord, branch: string, update: BranchUpdate): Promise<{ headSha: string }> {
      const bare = localRepoPath(repo.url);
      if (!bare) throw new Error(`${repo.name} is not reachable by path; the local forge only serves file:// repositories`);
      if (!BRANCH.test(branch) || branch.includes("..")) throw new Error(`invalid branch name ${JSON.stringify(branch)}`);
      return oneAtATime(bare, async () => {
        const head = (await gitAsyncMaybe(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}^{commit}`], bare))?.trim();
        if (!head) throw new ForgeRefusal(`branch ${branch} is not in ${repo.name}`);
        if (head !== update.expectedHead) throw new ForgeRefusal(`${branch} moved since the change was prepared; read the request again`);
        if ((await gitAsyncMaybe(["symbolic-ref", "--quiet", "HEAD"], bare))?.trim() === `refs/heads/${branch}`) {
          throw new ForgeRefusal(`${branch} is checked out in ${repo.name}; commit to it there`);
        }
        const work = await scratch(workRoot, "update-");
        try {
          const headSha = await changeCommit(bare, work, { title: update.title, body: "", commitBody: update.commitBody ?? "", branch, baseSha: head, files: update.files, author: update.author }, repo.name);
          await gitAsync(["update-ref", "refs/orchestrator/change", headSha], work);
          await gitAsync(["fetch", "--quiet", work, "refs/orchestrator/change:refs/orchestrator/update"], bare);
          // Moved only if it still names the head checked above.
          await gitAsync(["update-ref", `refs/heads/${branch}`, headSha, head], bare);
          await gitAsyncMaybe(["update-ref", "-d", "refs/orchestrator/update"], bare);
          // The request's description is a note on its branch's head, so it moves with the head.
          await gitAsyncMaybe(["notes", "--ref", localDescriptionRef(branch), "copy", head, headSha], bare);
          return { headSha };
        } finally {
          rmSync(work, { recursive: true, force: true });
        }
      });
    },

    // The runner pushed the branch into the person's repository; the request is its record and the
    // description beside it, and the branch itself is neither rewritten nor taken back.
    async openForBranch(repo: RepoRecord, pushed: PushedBranch): Promise<OpenedRequest> {
      const bare = localRepoPath(repo.url);
      if (!bare) throw new Error(`${repo.name} is not reachable by path; the local forge only serves file:// repositories`);
      if (!BRANCH.test(pushed.branch) || pushed.branch.includes("..")) throw new Error(`invalid branch name ${JSON.stringify(pushed.branch)}`);
      return oneAtATime(bare, async () => {
        const headSha = (await gitAsyncMaybe(["rev-parse", "--verify", "--quiet", `refs/heads/${pushed.branch}^{commit}`], bare))?.trim();
        if (!headSha) throw new ForgeRefusal(`branch ${pushed.branch} is not in ${repo.name}; the runner pushes it first`);
        if ((await gitAsyncMaybe(["merge-base", "--is-ancestor", pushed.baseSha, headSha], bare)) === null) {
          throw new ForgeRefusal(`branch ${pushed.branch} does not start from the commit the task started from`);
        }
        // A branch with nothing past the base is already in it, and would read as merged at once.
        if (headSha === pushed.baseSha) throw new ForgeRefusal(`branch ${pushed.branch} has no commit beyond the one the task started from`);
        await gitAsync(["notes", "--ref", localDescriptionRef(pushed.branch), "add", "--force", "-m", pushed.body || pushed.title, headSha], bare);
        const number = await ledger.nextNumber(repo.tenant, repo.id);
        return { number, url: `${urlBase}/${repo.id}/${number}`, branch: pushed.branch, headSha };
      });
    },

    // Where a request stands when the person merged or dropped it in their own repository, as L5 has
    // them do for a branch checked out there: merged once its head is in the default branch, closed
    // once its branch is gone without that, open otherwise. A squash merge leaves it open until the
    // branch is deleted.
    async status(repo: RepoRecord, number: number): Promise<ForgeState> {
      const bare = localRepoPath(repo.url);
      const request = await ledger.request?.(repo.tenant, repo.id, number);
      if (!bare || !request) throw new ForgeRefusal(`there is no request #${number} on ${repo.name}`);
      const target = (await gitAsync(["symbolic-ref", "--short", "HEAD"], bare)).trim();
      const head = (await gitAsyncMaybe(["rev-parse", "--verify", "--quiet", `refs/heads/${request.branch}^{commit}`], bare))?.trim() || null;
      // The request's own branch checked out is being worked on, not merged into itself.
      if (target === request.branch) return forgeState("open", null, head);
      if ((await gitAsyncMaybe(["merge-base", "--is-ancestor", head ?? request.headSha, `refs/heads/${target}`], bare)) !== null) return forgeState("merged", null, head);
      return forgeState(head ? "open" : "closed", null, head);
    },

    // A local forge has no requests of its own beyond the orchestrator's, so what waits to be merged
    // is every branch the default one does not contain: a teammate's share pushed here included.
    async list(repo: RepoRecord): Promise<PendingShare[]> {
      const bare = localRepoPath(repo.url);
      if (!bare) throw new Error(`${repo.name} is not reachable by path; the local forge only serves file:// repositories`);
      const target = (await gitAsync(["symbolic-ref", "--short", "HEAD"], bare)).trim();
      const format = ["%(refname:short)", "%(committerdate:iso-strict)", "%(authorname)", "%(subject)"].join("%00");
      const out = await gitAsync(["for-each-ref", `--no-merged=${target}`, "--sort=-committerdate", `--count=${PENDING_LIMIT}`, `--format=${format}`, "refs/heads/"], bare);
      return out.split("\n").filter(Boolean).map((line) => {
        const [branch, updatedAt, author, subject] = line.split("\0");
        return { number: null, title: shownText(subject), branch: shownText(branch), url: null, author: shownText(author), updatedAt: shownText(updatedAt), fromFork: false };
      });
    },
  };
}

/** The description the local forge keeps for the request on `branch`, or null when it keeps none. */
export async function readLocalDescription(repo: RepoRecord, branch: string): Promise<string | null> {
  const bare = localRepoPath(repo.url);
  return bare ? gitAsyncMaybe(["notes", "--ref", localDescriptionRef(branch), "show", `refs/heads/${branch}`], bare) : null;
}

/**
 * Takes back a branch whose request was not recorded, and its description with it, so no
 * branch is left that no request names and no description waits to refuse the next request
 * of the same name.
 */
export async function deleteLocalBranch(repo: RepoRecord, branch: string): Promise<void> {
  const bare = localRepoPath(repo.url);
  if (!bare) return;
  await oneAtATime(bare, async () => {
    await gitAsyncMaybe(["update-ref", "-d", `refs/heads/${branch}`], bare);
    await gitAsyncMaybe(["update-ref", "-d", localDescriptionRef(branch)], bare);
  });
}

/**
 * A merge into a branch checked out in the person's own working copy that the orchestrator does not
 * make, saying why and the command that makes it there.
 */
export class TargetCheckedOut extends ForgeRefusal {
  constructor(
    readonly branch: string,
    readonly target: string,
    repoName: string,
    why: string,
  ) {
    super(
      why === "it has changes not committed"
        ? `${target} is checked out in ${repoName} with changes not committed; commit them or set them aside, then merge again, or merge it in your own repository: git merge ${branch}`
        : `${target} is checked out in ${repoName}, and ${why}; merge it in your own repository: git merge ${branch}`,
    );
  }
}

/**
 * Merging is a person's decision in the orchestrator, never the change's own: the default branch
 * of the bare repository moves to a merge commit of the request's branch. The merge is
 * computed by git from objects (`merge-tree --write-tree`), with no checkout, and arrives in
 * the bare repository the same way the branch did. A merge that conflicts is refused.
 */
export function mergeLocalRequest(workRoot: string, repo: RepoRecord, branch: string, by: { name: string; email: string }): Promise<string> {
  // In turn with every other write to this repository: a merge reads the default branch and
  // writes it back, and a second merge reading it in between would be computed from a head
  // that no longer exists.
  return inLocalTurn(repo, () => mergeLocalBranch(workRoot, repo, branch, by));
}

/** Runs `work` in the repository's turn, for a caller whose own bookkeeping has to happen in that same turn. */
export function inLocalTurn<T>(repo: RepoRecord, work: () => Promise<T>): Promise<T> {
  const bare = localRepoPath(repo.url);
  if (!bare) throw new Error(`${repo.name} is not reachable by path`);
  return oneAtATime(bare, work);
}

/** The merge itself. Only inside the repository's turn (`inLocalTurn`). */
/**
 * `expectedHead` is the head last checked: the branch read at any other commit is refused, and that
 * exact commit is what merges, so a push between the check and the merge never reaches the target.
 */
export async function mergeLocalBranch(workRoot: string, repo: RepoRecord, branch: string, by: { name: string; email: string }, expectedHead?: string): Promise<string> {
  const bare = localRepoPath(repo.url);
  if (!bare) throw new Error(`${repo.name} is not reachable by path`);
  const target = (await gitAsync(["symbolic-ref", "--short", "HEAD"], bare)).trim();
  // In a working copy the default branch is the one checked out: it moves, with its files, only when
  // nothing of the person's is in the way; otherwise they merge it there themselves.
  const checkout = (await gitAsync(["rev-parse", "--is-bare-repository"], bare)).trim() !== "true";
  if (checkout) {
    const busy = target === branch ? "the request's own branch is the one checked out" : await checkoutBusy(bare);
    if (busy) throw new TargetCheckedOut(branch, target, repo.name, busy);
  }
  const work = await scratch(workRoot, "merge-");
  try {
    await gitAsync(["fetch", "--quiet", bare, `refs/heads/${target}:refs/orchestrator/target`, `refs/heads/${branch}:refs/orchestrator/request`], work);
    if (expectedHead && (await gitAsync(["rev-parse", "refs/orchestrator/request"], work)).trim() !== expectedHead) {
      throw new ForgeRefusal("the branch moved since it was checked; it is checked again before it merges");
    }
    let tree: string;
    try {
      tree = (await gitAsync(["merge-tree", "--write-tree", "refs/orchestrator/target", "refs/orchestrator/request"], work)).split("\n")[0]!.trim();
    } catch {
      throw new ForgeRefusal(`${branch} conflicts with ${target}; it cannot be merged as it is`);
    }
    const parents = [(await gitAsync(["rev-parse", "refs/orchestrator/target"], work)).trim(), (await gitAsync(["rev-parse", "refs/orchestrator/request"], work)).trim()];
    const merged = (await gitAsync(["commit-tree", tree, "-p", parents[0]!, "-p", parents[1]!, "-m", `Merge ${branch}`], work, undefined, by)).trim();
    await gitAsync(["update-ref", "refs/orchestrator/merged", merged], work);
    if (checkout) {
      const refused = await fastForwardCheckout(bare, work, "refs/orchestrator/merged");
      if (refused) throw new TargetCheckedOut(branch, target, repo.name, `git did not move it: ${refused}`);
      return merged;
    }
    await gitAsync(["fetch", "--quiet", work, `refs/orchestrator/merged:refs/heads/${target}`], bare);
    return merged;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
