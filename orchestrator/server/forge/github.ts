import type { RepoRecord } from "../store.js";
import { checkBranch, forgeHttp, ForgeHttpError } from "./http.js";
import { ForgeRefusal } from "./local.js";
import { forgeState, forgeTime, PENDING_LIMIT, shownText, shownUrl } from "./types.js";
import type { BranchUpdate, ChangeRequest, CommitCheck, FileChange, ForgeConfig, ForgeProvider, ForgeState, OpenedRequest, PendingShare, PushedBranch, RequestAssignment } from "./types.js";

/** How GitHub takes any token, an installation's or one an admin pasted: a bearer, with the API version pinned. */
export function githubAuth(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" };
}

/**
 * A pull request on GitHub through its REST API alone: a tree on top of the base commit's,
 * a commit on that tree, a ref for the branch, then the pull request. The orchestrator never
 * holds a clone with write access, and the default branch is never a target of any write.
 */
export function createGitHubForge(config: ForgeConfig, token: string, fetchImpl: typeof fetch = fetch): ForgeProvider {
  const http = forgeHttp("GitHub", config.apiUrl, token, githubAuth(token), fetchImpl);
  const [owner, name] = config.project.split("/");
  if (!owner || !name || config.project.split("/").length !== 2) throw new Error(`a GitHub repository is owner/name, not ${JSON.stringify(config.project)}`);
  const repoPath = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
  // A branch name keeps its slashes in a ref path; each segment is encoded on its own.
  const refPath = (branch: string) => branch.split("/").map(encodeURIComponent).join("/");

  /** One commit of `files` on top of `parent`, built from trees on GitHub; nothing points at it yet. */
  const commitOn = async (parent: string, files: FileChange[], message: string, author: { name: string; email: string }): Promise<string> => {
    const base = await http.request<{ tree: { sha: string } }>("GET", `${repoPath}/git/commits/${encodeURIComponent(parent)}`);
    const tree = await http.request<{ sha: string }>("POST", `${repoPath}/git/trees`, {
      base_tree: base.tree.sha,
      tree: files.map((file) => (file.content === null ? { path: file.path, mode: "100644", type: "blob", sha: null } : { path: file.path, mode: "100644", type: "blob", content: file.content })),
    });
    const commit = await http.request<{ sha: string }>("POST", `${repoPath}/git/commits`, { message, tree: tree.sha, parents: [parent], author: { name: author.name, email: author.email } });
    return commit.sha;
  };

  /** The team's reviewers, labels and assignee on an opened pull request; what GitHub refuses comes back as notes beside it. */
  const assign = async (number: number, assignment: RequestAssignment = { reviewers: [], labels: [] }): Promise<string[]> => {
    const notes: string[] = [];
    const attempt = async (what: string, path: string, body: unknown) => {
      try {
        await http.request("POST", path, body);
      } catch (err) {
        notes.push(`${what} were not added: ${(err as Error).message}`);
      }
    };
    if (assignment.reviewers.length) await attempt("reviewers", `${repoPath}/pulls/${number}/requested_reviewers`, { reviewers: assignment.reviewers });
    if (assignment.labels.length) await attempt("labels", `${repoPath}/issues/${number}/labels`, { labels: assignment.labels });
    if (assignment.assignee) await attempt("assignees", `${repoPath}/issues/${number}/assignees`, { assignees: [assignment.assignee] });
    return notes;
  };

  return {
    kind: "github",
    async open(repo: RepoRecord, change: ChangeRequest): Promise<OpenedRequest> {
      checkBranch(change.branch);
      if (!change.files.length) throw new Error("the change has no files");
      const { default_branch: base } = await http.request<{ default_branch: string }>("GET", repoPath);
      // Asked before anything is written: found only when the ref is created, a taken name
      // leaves a tree and a commit on GitHub that nothing points at.
      const taken = await http.request("GET", `${repoPath}/git/ref/heads/${refPath(change.branch)}`).then(
        () => true,
        (err) => {
          if (err instanceof ForgeHttpError && err.status === 404) return false;
          throw err;
        },
      );
      if (taken) throw new ForgeRefusal(`branch ${change.branch} already exists in ${repo.name}; remove it on GitHub, then try again`);
      const commit = { sha: await commitOn(change.baseSha, change.files, (change.commitBody ?? change.body) ? `${change.title}\n\n${change.commitBody ?? change.body}` : change.title, change.author) };
      try {
        await http.request("POST", `${repoPath}/git/refs`, { ref: `refs/heads/${change.branch}`, sha: commit.sha });
      } catch (err) {
        if (err instanceof ForgeHttpError && err.status === 422) throw new ForgeRefusal(`branch ${change.branch} already exists in ${repo.name}; remove it on GitHub, then try again`);
        throw err;
      }
      let pull: { number: number; html_url: string };
      try {
        pull = await http.request("POST", `${repoPath}/pulls`, { title: change.title, head: change.branch, base, body: change.body });
      } catch (err) {
        // No request names the branch, so it is taken back; if GitHub refuses that too, the
        // person is told which branch is left to delete.
        const left = await http.request("DELETE", `${repoPath}/git/refs/heads/${refPath(change.branch)}`).then(
          () => "the branch was removed again",
          () => `the branch stayed on GitHub: ${change.branch}`,
        );
        throw new Error(`the request was not opened: ${(err as Error).message}; ${left}; try again`);
      }

      // The request exists from here on: what GitHub refuses below is reported beside it.
      const notes = await assign(pull.number, change.assignment);
      return { number: pull.number, url: pull.html_url, branch: change.branch, headSha: commit.sha, ...(notes.length ? { notes } : {}) };
    },

    async openForBranch(repo: RepoRecord, pushed: PushedBranch): Promise<OpenedRequest> {
      checkBranch(pushed.branch);
      const ref = await http.request<{ object?: { sha?: unknown } }>("GET", `${repoPath}/git/ref/heads/${refPath(pushed.branch)}`).catch((err) => {
        if (err instanceof ForgeHttpError && err.status === 404) throw new ForgeRefusal(`branch ${pushed.branch} is not in ${repo.name}; the runner pushes it first`);
        throw err;
      });
      const headSha = ref.object?.sha;
      if (typeof headSha !== "string") throw new ForgeRefusal(`branch ${pushed.branch} is not in ${repo.name}; the runner pushes it first`);
      const base = pushed.target ?? (await http.request<{ default_branch: string }>("GET", repoPath)).default_branch;
      // The branch is the runner's: a pull request GitHub refuses leaves it where it was pushed.
      const pull = await http.request<{ number: number; html_url: string }>("POST", `${repoPath}/pulls`, { title: pushed.title, head: pushed.branch, base, body: pushed.body });
      const notes = await assign(pull.number, pushed.assignment);
      return { number: pull.number, url: pull.html_url, branch: pushed.branch, headSha, ...(notes.length ? { notes } : {}) };
    },

    // GitHub moves a ref without force only forward, so a branch that moved since is refused there too.
    async updateBranch(repo: RepoRecord, branch: string, update: BranchUpdate): Promise<{ headSha: string }> {
      checkBranch(branch);
      if (!update.files.length) throw new Error("the change has no files");
      const ref = await http.request<{ object?: { sha?: unknown } }>("GET", `${repoPath}/git/ref/heads/${refPath(branch)}`).catch((err) => {
        if (err instanceof ForgeHttpError && err.status === 404) throw new ForgeRefusal(`branch ${branch} is not in ${repo.name}; open the request again`);
        throw err;
      });
      if (ref.object?.sha !== update.expectedHead) throw new ForgeRefusal(`${branch} moved since the change was prepared; read the request again`);
      const headSha = await commitOn(update.expectedHead, update.files, update.commitBody ? `${update.title}\n\n${update.commitBody}` : update.title, update.author);
      try {
        await http.request("PATCH", `${repoPath}/git/refs/heads/${refPath(branch)}`, { sha: headSha, force: false });
      } catch (err) {
        if (err instanceof ForgeHttpError && err.status === 422) throw new ForgeRefusal(`${branch} moved since the change was prepared; read the request again`);
        throw err;
      }
      return { headSha };
    },

    async setCommitStatus(sha: string, check: CommitCheck): Promise<void> {
      if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error("a commit status is set on a full commit id");
      await http.request("POST", `${repoPath}/statuses/${sha}`, { state: check.state, context: check.context, description: check.description.slice(0, 140) });
    },

    async status(_repo: RepoRecord, number: number): Promise<ForgeState> {
      const pull = await http.request<{ state: string; merged: boolean; merged_at?: unknown; head?: { sha?: unknown } }>("GET", `${repoPath}/pulls/${number}`);
      if (pull.merged) return forgeState("merged", forgeTime(pull.merged_at), pull.head?.sha);
      return forgeState(pull.state === "closed" ? "closed" : "open", null, pull.head?.sha);
    },

    async list(): Promise<PendingShare[]> {
      type Pull = { number: number; html_url?: unknown; title?: unknown; updated_at?: unknown; head?: { ref?: unknown; repo?: { id?: unknown } | null }; base?: { repo?: { id?: unknown } }; user?: { login?: unknown } };
      const open = await http.request<Pull[]>("GET", `${repoPath}/pulls?state=open&sort=updated&direction=desc&per_page=${PENDING_LIMIT}`);
      return open.slice(0, PENDING_LIMIT).map((pull) => ({
        number: pull.number,
        title: shownText(pull.title),
        branch: shownText(pull.head?.ref),
        url: shownUrl(pull.html_url),
        author: shownText(pull.user?.login),
        updatedAt: shownText(pull.updated_at),
        // A fork that was deleted leaves no head repository at all.
        fromFork: pull.head?.repo?.id === undefined || pull.head.repo.id !== pull.base?.repo?.id,
      }));
    },
  };
}
