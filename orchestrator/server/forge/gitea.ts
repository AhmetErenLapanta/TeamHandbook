import { orchestratorCommitter } from "../git.js";
import type { RepoRecord } from "../store.js";
import { checkBranch, forgeHttp, ForgeHttpError } from "./http.js";
import type { ForgeHttp } from "./http.js";
import { ForgeRefusal } from "./local.js";
import { newestComments, normalizeChecks, requestComment, targetOf } from "./read-model.js";
import type { CheckState, Mergeability, RawCheck, RequestComment, RequestDetail, ReviewSummary } from "./read-model.js";
import { forgeState, forgeTime, PENDING_LIMIT, shownText, shownUrl } from "./types.js";
import type { ChangeRequest, CommitCheck, ForgeConfig, ForgeProvider, ForgeState, OpenedRequest, PendingShare, RequestStatus } from "./types.js";

/** How Gitea takes an access token. */
export function giteaAuth(token: string): Record<string, string> {
  return { authorization: `token ${token}` };
}

interface Content {
  type?: unknown;
  sha?: unknown;
}

/**
 * A pull request on Gitea 1.20 or later through its REST API alone: the branch made at the base
 * commit, the change written onto it as one commit, then the pull request. Gitea writes files only
 * onto a branch's tip, so the branch is made first, at the base itself: a commit pushed to the
 * default branch meanwhile never becomes the change's parent. The author is the person who asked,
 * the committer the orchestrator.
 */
export function createGiteaForge(config: ForgeConfig, token: string, fetchImpl: typeof fetch = fetch): ForgeProvider {
  const http = forgeHttp("Gitea", config.apiUrl, token, giteaAuth(token), fetchImpl);
  const [owner, name] = config.project.split("/");
  if (!owner || !name || config.project.split("/").length !== 2) throw new Error(`a Gitea repository is owner/name, not ${JSON.stringify(config.project)}`);
  const repoPath = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
  // A branch name or a file path keeps its slashes in a path; each segment is encoded on its own.
  const segments = (value: string) => value.split("/").map(encodeURIComponent).join("/");
  const missing = <T>(err: unknown): T | null => {
    if (err instanceof ForgeHttpError && err.status === 404) return null;
    throw err;
  };

  /** What Gitea is told to do with each file, from what the base commit holds at its path. */
  const operations = (repo: RepoRecord, change: ChangeRequest) =>
    Promise.all(
      change.files.map(async (file) => {
        const at = await http.request<Content | Content[]>("GET", `${repoPath}/contents/${segments(file.path)}?ref=${encodeURIComponent(change.baseSha)}`).catch(missing<Content>);
        if (Array.isArray(at)) throw new ForgeRefusal(`refusing ${file.path}: it is a folder in ${repo.name}`);
        if (at && at.type !== "file") throw new ForgeRefusal(`refusing ${file.path}: it is a ${String(at.type)} in ${repo.name}`);
        const content = file.content === null ? {} : { content: Buffer.from(file.content, "utf8").toString("base64") };
        if (file.content === null && !at) throw new ForgeRefusal(`${file.path} is not in ${repo.name} to remove`);
        return { operation: file.content === null ? "delete" : at ? "update" : "create", path: file.path, ...(at ? { sha: String(at.sha) } : {}), ...content };
      }),
    );

  const removeBranch = (branch: string) =>
    http.request("DELETE", `${repoPath}/branches/${segments(branch)}`).then(
      () => "the branch was removed again",
      () => `the branch stayed on Gitea: ${branch}`,
    );

  return {
    kind: "gitea",
    async open(repo: RepoRecord, change: ChangeRequest): Promise<OpenedRequest> {
      checkBranch(change.branch);
      if (!change.files.length) throw new Error("the change has no files");
      const { default_branch: base } = await http.request<{ default_branch: string }>("GET", repoPath);
      const taken = await http.request("GET", `${repoPath}/branches/${segments(change.branch)}`).then(() => true, missing<boolean>);
      if (taken) throw new ForgeRefusal(`branch ${change.branch} already exists in ${repo.name}; remove it on Gitea, then try again`);
      // Read before anything is written, so a path Gitea would refuse leaves no branch behind.
      const files = await operations(repo, change);
      try {
        await http.request("POST", `${repoPath}/branches`, { new_branch_name: change.branch, old_ref_name: change.baseSha });
      } catch (err) {
        if (err instanceof ForgeHttpError && err.status === 409) throw new ForgeRefusal(`branch ${change.branch} already exists in ${repo.name}; remove it on Gitea, then try again`);
        throw err;
      }
      let headSha: string;
      try {
        const written = await http.request<{ commit?: { sha?: unknown } }>("POST", `${repoPath}/contents`, {
          branch: change.branch,
          files,
          message: (change.commitBody ?? change.body) ? `${change.title}\n\n${change.commitBody ?? change.body}` : change.title,
          author: { name: change.author.name, email: change.author.email },
          committer: orchestratorCommitter(),
        });
        headSha = String(written.commit?.sha ?? "");
        if (!/^[0-9a-f]{40}$/.test(headSha)) throw new Error("Gitea named no commit for the change");
      } catch (err) {
        throw new Error(`the change was not written: ${(err as Error).message}; ${await removeBranch(change.branch)}`);
      }
      let pull: { number: number; html_url: string };
      try {
        pull = await http.request("POST", `${repoPath}/pulls`, { title: change.title, head: change.branch, base, body: change.body });
      } catch (err) {
        throw new Error(`the request was not opened: ${(err as Error).message}; ${await removeBranch(change.branch)}; try again`);
      }

      // The request exists from here on: what Gitea refuses below is reported beside it.
      const notes: string[] = [];
      const assignment = change.assignment ?? { reviewers: [], labels: [] };
      const attempt = async (what: string, call: () => Promise<unknown>) => {
        try {
          await call();
        } catch (err) {
          notes.push(`${what} were not added: ${(err as Error).message}`);
        }
      };
      if (assignment.reviewers.length) await attempt("reviewers", () => http.request("POST", `${repoPath}/pulls/${pull.number}/requested_reviewers`, { reviewers: assignment.reviewers }));
      if (assignment.labels.length) {
        // Gitea takes a request's labels by id, so the names the team wrote are looked up first.
        await attempt("labels", async () => {
          const known = await http.request<{ id: number; name: string }[]>("GET", `${repoPath}/labels?limit=${PENDING_LIMIT}`);
          const ids = assignment.labels.map((label) => known.find((k) => k.name === label)?.id);
          const unknown = assignment.labels.filter((_, n) => ids[n] === undefined);
          if (ids.some((id) => id !== undefined)) await http.request("POST", `${repoPath}/issues/${pull.number}/labels`, { labels: ids.filter((id) => id !== undefined) });
          if (unknown.length) throw new Error(`${unknown.join(", ")} ${unknown.length === 1 ? "is not a label" : "are not labels"} of ${repo.name}; add ${unknown.length === 1 ? "it" : "them"} on Gitea, or take ${unknown.length === 1 ? "it" : "them"} out of the team's labels`);
        });
      }
      if (assignment.assignee) await attempt("assignees", () => http.request("PATCH", `${repoPath}/issues/${pull.number}`, { assignees: [assignment.assignee] }));
      return { number: pull.number, url: pull.html_url, branch: change.branch, headSha, ...(notes.length ? { notes } : {}) };
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
      type Pull = { number: number; html_url?: unknown; title?: unknown; updated_at?: unknown; head?: { ref?: unknown; repo_id?: unknown }; base?: { repo_id?: unknown }; user?: { login?: unknown } };
      const open = await http.request<Pull[]>("GET", `${repoPath}/pulls?state=open&sort=recentupdate&limit=${PENDING_LIMIT}`);
      return open.slice(0, PENDING_LIMIT).map((pull) => ({
        number: pull.number,
        title: shownText(pull.title),
        branch: shownText(pull.head?.ref),
        url: shownUrl(pull.html_url),
        author: shownText(pull.user?.login),
        updatedAt: shownText(pull.updated_at),
        fromFork: pull.head?.repo_id === undefined || pull.head.repo_id !== pull.base?.repo_id,
      }));
    },
  };
}

/*
 * What the orchestrator reads of a request on Gitea, in the shapes it reads every forge in, for the
 * read model, the request watch and the runner's request to take up once Gitea joins HOSTED_FORGES.
 */

const giteaRepo = (config: ForgeConfig) => `/repos/${config.project.split("/").map(encodeURIComponent).join("/")}`;

interface GiteaPull {
  number?: unknown;
  state?: unknown;
  merged?: unknown;
  mergeable?: unknown;
  html_url?: unknown;
  head?: { ref?: unknown; sha?: unknown; repo_id?: unknown };
  base?: { repo_id?: unknown; ref?: unknown };
  user?: { login?: unknown };
  requested_reviewers?: unknown[] | null;
}

const giteaStatus = (pull: GiteaPull): RequestStatus => (pull.merged === true ? "merged" : pull.state === "open" ? "open" : "closed");

const giteaCheck = (status: unknown): CheckState => (status === "success" ? "success" : status === "pending" ? "pending" : "failure");

/** A request's detail: Gitea says only whether it can merge, so anything but a clean merge reads as a conflict. */
export async function readGiteaRequest(http: ForgeHttp, config: ForgeConfig, number: number): Promise<RequestDetail> {
  const repo = giteaRepo(config);
  const pull = await http.request<GiteaPull>("GET", `${repo}/pulls/${number}`);
  const reviews = await http.request<{ id?: unknown; user?: { login?: unknown }; state?: unknown; dismissed?: unknown; submitted_at?: unknown }[]>("GET", `${repo}/pulls/${number}/reviews?limit=${PENDING_LIMIT}`);
  const headSha = String(pull.head?.sha ?? "");
  const statuses = /^[0-9a-f]{40}$/.test(headSha)
    ? await http.request<{ id?: unknown; context?: unknown; status?: unknown; target_url?: unknown; updated_at?: unknown; created_at?: unknown }[]>("GET", `${repo}/commits/${headSha}/statuses?limit=${PENDING_LIMIT}`)
    : [];
  const status = giteaStatus(pull);
  const mergeability: Mergeability = status !== "open" ? { state: "not-open", reason: null } : pull.mergeable === true ? { state: "mergeable", reason: null } : { state: "conflict", reason: "the branch conflicts with its base" };

  // Each reviewer's latest word counts, as on GitHub; a dismissed review says nothing.
  const latest = new Map<string, string>();
  for (const r of [...reviews].sort((a, b) => String(a.submitted_at ?? "").localeCompare(String(b.submitted_at ?? "")) || (Number(a.id) || 0) - (Number(b.id) || 0))) {
    const who = shownText(r.user?.login);
    if (!who || r.dismissed === true) continue;
    if (r.state === "APPROVED" || r.state === "REQUEST_CHANGES") latest.set(who, String(r.state));
  }
  const approvedBy = [...latest].filter(([, s]) => s === "APPROVED").map(([who]) => who);
  const review: ReviewSummary = {
    decision: [...latest.values()].includes("REQUEST_CHANGES") ? "changes-requested" : approvedBy.length ? "approved" : (pull.requested_reviewers ?? []).length ? "pending" : "none",
    approvedBy,
  };
  const raw: RawCheck[] = statuses.map((s) => ({
    name: shownText(s.context),
    group: "status",
    state: giteaCheck(s.status),
    at: typeof s.updated_at === "string" ? s.updated_at : typeof s.created_at === "string" ? s.created_at : null,
    sequence: Number(s.id) || 0,
    url: shownUrl(s.target_url),
  }));
  // Gitea Actions report minutes after a push, so no status at all tells nothing yet.
  return { number, status, headSha, ...targetOf(pull.base?.ref), mergeability, review, checks: normalizeChecks(raw, { checksAlwaysReport: false }) };
}

/** What people said on a request: its conversation, and the comments of its newest reviews on lines. */
export async function giteaComments(http: ForgeHttp, config: ForgeConfig, number: number): Promise<RequestComment[]> {
  type Said = { id?: unknown; body?: unknown; user?: { login?: unknown }; updated_at?: unknown; html_url?: unknown; path?: unknown; position?: unknown };
  const repo = giteaRepo(config);
  const [conversation, reviews] = await Promise.all([
    http.request<Said[]>("GET", `${repo}/issues/${number}/comments`),
    http.request<{ id?: unknown; comments_count?: unknown }[]>("GET", `${repo}/pulls/${number}/reviews?limit=${PENDING_LIMIT}`),
  ]);
  // Each review's line comments are a call of their own; the newest ten reviews that have any are read.
  const withLines = reviews.filter((r) => Number(r.comments_count) > 0).slice(-10);
  const onLines = (await Promise.all(withLines.map((r) => http.request<Said[]>("GET", `${repo}/pulls/${number}/reviews/${Number(r.id)}/comments`)))).flat();
  return newestComments([...conversation, ...onLines].map((c) => requestComment(c.id, c.user?.login, false, c.body, c.updated_at, c.path, c.position, c.html_url)));
}

/** A request as the runner's report is checked against it: its branch, whether it comes from a fork, who opened it, its head. */
export async function giteaRunnerSeen(http: ForgeHttp, config: ForgeConfig, number: number) {
  const pull = await http.request<GiteaPull>("GET", `${giteaRepo(config)}/pulls/${number}`);
  return {
    sourceBranch: String(pull.head?.ref ?? ""),
    fromFork: pull.head?.repo_id === undefined || pull.head.repo_id !== pull.base?.repo_id,
    author: String(pull.user?.login ?? ""),
    headSha: String(pull.head?.sha ?? ""),
    url: shownUrl(pull.html_url),
    open: pull.state === "open" && pull.merged !== true,
  };
}

