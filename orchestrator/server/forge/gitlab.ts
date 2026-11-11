import type { RepoRecord } from "../store.js";
import { checkBranch, forgeHttp, ForgeHttpError } from "./http.js";
import { ForgeRefusal } from "./local.js";
import { PENDING_LIMIT, forgeState, forgeTime, shownText, shownUrl } from "./types.js";
import type { BranchUpdate, ChangeRequest, CommitCheck, FileChange, ForgeConfig, ForgeProvider, ForgeState, OpenedRequest, PendingShare, PushedBranch, RequestAssignment } from "./types.js";

interface Project {
  id: number;
  default_branch: string;
}

interface MergeRequest {
  iid: number;
  web_url: string;
  state: string;
  merged_at?: unknown;
  sha?: unknown;
}

interface OpenMergeRequest extends MergeRequest {
  title?: unknown;
  source_branch?: unknown;
  updated_at?: unknown;
  author?: { username?: unknown };
  source_project_id?: unknown;
  target_project_id?: unknown;
}

/**
 * How GitLab takes a token: an access token an admin pasted in its own header, an OAuth one (the
 * org's connection) only as a bearer, since GitLab refuses an OAuth token in PRIVATE-TOKEN.
 */
export function gitlabAuth(token: string, oauth: boolean): Record<string, string> {
  return oauth ? { authorization: `Bearer ${token}` } : { "PRIVATE-TOKEN": token };
}

/**
 * A request on GitLab through its REST API alone. The commits API creates the branch and its
 * commit in one call from `start_sha`, so the orchestrator never holds a clone with write access
 * and nothing is sent to the forge but the files of the change.
 */
export function createGitLabForge(config: ForgeConfig, token: string, fetchImpl: typeof fetch = fetch, oauth = false): ForgeProvider {
  const http = forgeHttp("GitLab", config.apiUrl, token, gitlabAuth(token, oauth), fetchImpl);
  const project = `/projects/${encodeURIComponent(config.project)}`;

  const exists = async (path: string): Promise<boolean> => {
    try {
      await http.request("GET", path);
      return true;
    } catch (err) {
      if (err instanceof ForgeHttpError && err.status === 404) return false;
      throw err;
    }
  };

  // Reviewers and the assignee are numeric ids on GitLab; a name it does not know is
  // reported beside the request rather than failing it.
  const userId = async (username: string, notes: string[], role: string): Promise<number | null> => {
    try {
      const users = await http.request<{ id: number; username: string }[]>("GET", `/users?username=${encodeURIComponent(username)}`);
      const match = users.find((u) => u.username === username);
      if (match) return match.id;
      notes.push(`GitLab has no user ${username}; not added as ${role}`);
    } catch (err) {
      notes.push(`${username} was not added as ${role}: ${(err as Error).message}`);
    }
    return null;
  };

  /** A merge request's fields with the team's reviewers, labels and assignee; a user GitLab does not know is said in `notes`. */
  const mergeRequest = async (branch: string, target: string, title: string, description: string, given: RequestAssignment | undefined, notes: string[]) => {
    const assignment = given ?? { reviewers: [], labels: [] };
    const reviewerIds: number[] = [];
    for (const reviewer of assignment.reviewers) {
      const id = await userId(reviewer, notes, "a reviewer");
      if (id !== null) reviewerIds.push(id);
    }
    const assigneeId = assignment.assignee ? await userId(assignment.assignee, notes, "the assignee") : null;
    return {
      source_branch: branch,
      target_branch: target,
      title,
      description,
      remove_source_branch: true,
      ...(assignment.labels.length ? { labels: assignment.labels.join(",") } : {}),
      ...(reviewerIds.length ? { reviewer_ids: reviewerIds } : {}),
      ...(assigneeId !== null ? { assignee_id: assigneeId } : {}),
    };
  };

  /** What GitLab is told to do with each file, from whether `sha` holds it; `lastCommit` makes GitLab refuse a file changed after it. */
  const actionsAt = async (repo: RepoRecord, files: FileChange[], sha: string, lastCommit?: string) => {
    const actions = [];
    for (const file of files) {
      const present = await exists(`${project}/repository/files/${encodeURIComponent(file.path)}?ref=${encodeURIComponent(sha)}`);
      const since = lastCommit && present ? { last_commit_id: lastCommit } : {};
      if (file.content === null) {
        if (!present) throw new Error(`${file.path} is not in ${repo.name}, so it cannot be deleted`);
        actions.push({ action: "delete", file_path: file.path, ...since });
      } else {
        actions.push({ action: present ? "update" : "create", file_path: file.path, content: file.content, ...since });
      }
    }
    return actions;
  };

  return {
    kind: "gitlab",
    // GitLab commits onto a branch's tip, so its head is checked first and each file names the head it
    // was prepared on: one changed since makes GitLab refuse rather than write over it.
    async updateBranch(repo: RepoRecord, branch: string, update: BranchUpdate): Promise<{ headSha: string }> {
      checkBranch(branch);
      if (!update.files.length) throw new Error("the change has no files");
      const at = await http.request<{ commit?: { id?: unknown } }>("GET", `${project}/repository/branches/${encodeURIComponent(branch)}`).catch((err) => {
        if (err instanceof ForgeHttpError && err.status === 404) throw new ForgeRefusal(`branch ${branch} is not in ${repo.name}; open the request again`);
        throw err;
      });
      if (at.commit?.id !== update.expectedHead) throw new ForgeRefusal(`${branch} moved since the change was prepared; read the request again`);
      const actions = await actionsAt(repo, update.files, update.expectedHead, update.expectedHead);
      try {
        const commit = await http.request<{ id: string }>("POST", `${project}/repository/commits`, {
          branch,
          commit_message: update.commitBody ? `${update.title}\n\n${update.commitBody}` : update.title,
          author_name: update.author.name,
          author_email: update.author.email,
          actions,
        });
        return { headSha: commit.id };
      } catch (err) {
        // GitLab answers a file changed after its last_commit_id with a 400 that says so.
        if (err instanceof ForgeHttpError && err.status === 400 && /changed since/i.test(err.message)) throw new ForgeRefusal(`${branch} moved since the change was prepared; read the request again`);
        throw err;
      }
    },

    async open(repo: RepoRecord, change: ChangeRequest): Promise<OpenedRequest> {
      checkBranch(change.branch);
      if (!change.files.length) throw new Error("the change has no files");
      const { default_branch: target } = await http.request<Project>("GET", project);
      if (await exists(`${project}/repository/branches/${encodeURIComponent(change.branch)}`)) {
        throw new ForgeRefusal(`branch ${change.branch} already exists in ${repo.name}; remove it on GitLab, then try again`);
      }
      const actions = await actionsAt(repo, change.files, change.baseSha);
      const commit = await http.request<{ id: string }>("POST", `${project}/repository/commits`, {
        branch: change.branch,
        start_sha: change.baseSha,
        commit_message: (change.commitBody ?? change.body) ? `${change.title}\n\n${change.commitBody ?? change.body}` : change.title,
        author_name: change.author.name,
        author_email: change.author.email,
        actions,
      });

      // The branch exists from here on: only a failed merge request throws below, and it takes the branch back first.
      const notes: string[] = [];
      const fields = await mergeRequest(change.branch, target, change.title, change.body, change.assignment, notes);
      let request: MergeRequest;
      try {
        request = await http.request<MergeRequest>("POST", `${project}/merge_requests`, fields);
      } catch (err) {
        // No request names the branch, so it is taken back; a retry then starts clean. If
        // GitLab refuses that too, the person is told which branch is left to delete.
        const left = await http.request("DELETE", `${project}/repository/branches/${encodeURIComponent(change.branch)}`).then(
          () => "the branch was removed again",
          () => `the branch stayed on GitLab: ${change.branch}`,
        );
        throw new Error(`the request was not opened: ${(err as Error).message}; ${left}; try again`);
      }
      return { number: request.iid, url: request.web_url, branch: change.branch, headSha: commit.id, ...(notes.length ? { notes } : {}) };
    },

    async openForBranch(repo: RepoRecord, pushed: PushedBranch): Promise<OpenedRequest> {
      checkBranch(pushed.branch);
      const at = await http.request<{ commit?: { id?: unknown } }>("GET", `${project}/repository/branches/${encodeURIComponent(pushed.branch)}`).catch((err) => {
        if (err instanceof ForgeHttpError && err.status === 404) throw new ForgeRefusal(`branch ${pushed.branch} is not in ${repo.name}; the runner pushes it first`);
        throw err;
      });
      const headSha = at.commit?.id;
      if (typeof headSha !== "string") throw new ForgeRefusal(`branch ${pushed.branch} is not in ${repo.name}; the runner pushes it first`);
      const target = pushed.target ?? (await http.request<Project>("GET", project)).default_branch;
      const notes: string[] = [];
      // The branch is the runner's: a merge request GitLab refuses leaves it where it was pushed.
      const request = await http.request<MergeRequest>("POST", `${project}/merge_requests`, await mergeRequest(pushed.branch, target, pushed.title, pushed.body, pushed.assignment, notes));
      return { number: request.iid, url: request.web_url, branch: pushed.branch, headSha, ...(notes.length ? { notes } : {}) };
    },

    async setCommitStatus(sha: string, check: CommitCheck): Promise<void> {
      if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error("a commit status is set on a full commit id");
      // GitLab names a failed check "failed"; a check that could not decide is one too, so a required one holds the merge.
      const state = check.state === "failure" || check.state === "error" ? "failed" : check.state;
      await http.request("POST", `${project}/statuses/${sha}`, { state, name: check.context, description: check.description.slice(0, 140) });
    },

    async status(_repo: RepoRecord, number: number): Promise<ForgeState> {
      const mr = await http.request<MergeRequest>("GET", `${project}/merge_requests/${number}`);
      if (mr.state === "merged") return forgeState("merged", forgeTime(mr.merged_at), mr.sha);
      return forgeState(mr.state === "closed" || mr.state === "locked" ? "closed" : "open", null, mr.sha);
    },

    async list(): Promise<PendingShare[]> {
      const open = await http.request<OpenMergeRequest[]>("GET", `${project}/merge_requests?state=opened&order_by=updated_at&sort=desc&per_page=${PENDING_LIMIT}`);
      return open.slice(0, PENDING_LIMIT).map((mr) => ({
        number: mr.iid,
        title: shownText(mr.title),
        branch: shownText(mr.source_branch),
        url: shownUrl(mr.web_url),
        author: shownText(mr.author?.username),
        updatedAt: shownText(mr.updated_at),
        fromFork: mr.source_project_id !== mr.target_project_id,
      }));
    },
  };
}
