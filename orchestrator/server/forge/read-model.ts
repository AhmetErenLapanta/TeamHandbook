import { createHash } from "node:crypto";
import type { OrchestratorContext } from "../app.js";
import { OrchestratorError } from "../errors.js";
import { repoForgeAccess } from "../propose.js";
import { cliConfig, ownCliReader, OwnCliRefused } from "./own-cli.js";
import type { RepoRecord } from "../store.js";
import { giteaComments, readGiteaRequest } from "./gitea.js";
import { forgeHttp, ForgeHttpError } from "./http.js";
import type { ForgeHttp } from "./http.js";
import { shownText, shownUrl } from "./types.js";
import type { ForgeConfig, RequestStatus } from "./types.js";

/**
 * What the orchestrator reads of a request before anyone merges it, the same shape for every forge:
 * its checks, folded to one state; the review decision; whether it can merge and what holds it.
 * The forges differ in what they can say, and the capability matrix records how, so the screen
 * and an agent read one answer rather than each learning both forges.
 */

import { FORGES } from "../../shared/forge-def.js";
import { CAPABILITIES } from "../../shared/forge-read.js";
import type { CheckState, ChecksSummary, ForgeCapabilities, HostedForge, Mergeability, RequestComment, RequestDetail, RequestStatusRead, RequestWatch, ReviewSummary } from "../../shared/forge-read.js";
import { ownCliHere } from "./own-cli-here.js";

export { CAPABILITIES };
export type { CheckState, ChecksSummary, ForgeCapabilities, HostedForge, Mergeability, RequestComment, RequestDetail, RequestStatusRead, RequestWatch, ReviewSummary };

/** One check as a forge reports it, before reruns of the same check are folded into the newest. */
export interface RawCheck {
  name: string;
  group: string;
  state: CheckState;
  /** When it started or was reported; GitLab gives one-second times, so `sequence` breaks a tie. */
  at: string | null;
  sequence: number;
  url: string | null;
}

const ORDER: Record<CheckState, number> = { failure: 0, pending: 1, success: 2, skipped: 3 };

/**
 * A rerun reports the same check again, so each group and name keeps only its newest report:
 * the latest time, and the higher sequence when two share a time.
 */
export function normalizeChecks(raw: RawCheck[], capabilities: Pick<ForgeCapabilities, "checksAlwaysReport">): ChecksSummary {
  const newest = new Map<string, RawCheck>();
  for (const check of raw) {
    const key = `${check.group}\u0000${check.name}`;
    const kept = newest.get(key);
    const later = !kept || (check.at ?? "") > (kept.at ?? "") || ((check.at ?? "") === (kept.at ?? "") && check.sequence > kept.sequence);
    if (later) newest.set(key, check);
  }
  const checks = [...newest.values()]
    .sort((a, b) => ORDER[a.state] - ORDER[b.state] || a.name.localeCompare(b.name) || a.group.localeCompare(b.group))
    .map(({ name, group, state, url }) => ({ name, group, state, url }));
  if (!checks.length) return { state: capabilities.checksAlwaysReport ? "no-ci" : "unknown", checks };
  const state = checks.some((c) => c.state === "failure") ? "failing" : checks.some((c) => c.state === "pending") ? "pending" : "passing";
  return { state, checks };
}

export type ReadFailure = "unauthenticated" | "forbidden" | "rate-limited" | "not-found" | "unreachable" | "failed";

/** A forge read that failed, with why in a word a program reads and what to do in words for the person. */
export class ForgeReadError extends OrchestratorError {
  constructor(
    readonly reason: ReadFailure,
    message: string,
    readonly retryAt: string | null = null,
  ) {
    super(`forge-${reason}`, message, reason === "not-found" ? 404 : reason === "rate-limited" ? 429 : 502);
  }
}

/** The forge's refusal as a reason and the fix for this repository: reconnect, a new token, or wait. */
export function readFailure(err: ForgeHttpError, forge: HostedForge, repo: RepoRecord, throughConnection: boolean): ForgeReadError {
  const name = FORGES[forge].label;
  const access = throughConnection ? `an owner or an admin connects ${name} again under Integrations` : `an owner or an admin enters a new token for ${repo.name} under Integrations`;
  if (err.retryAt) return new ForgeReadError("rate-limited", `${name} asks the orchestrator to wait until ${err.retryAt} before reading more`, err.retryAt);
  if (err.status === 401) return new ForgeReadError("unauthenticated", `${name} no longer accepts the orchestrator's access to ${repo.name}; ${access}`);
  if (err.status === 403) return new ForgeReadError("forbidden", `${name} does not let the orchestrator's access read ${repo.name}'s requests; ${access}, one that reads them`);
  if (err.status === 404) return new ForgeReadError("not-found", `${name} has no such request in ${repo.name}, or the orchestrator's access does not see it; open it again from the list of requests, and if it is there, ${access}`);
  if (err.status === 0) return new ForgeReadError("unreachable", err.message);
  return new ForgeReadError("failed", err.message);
}

const BLOCKED: Record<string, string> = {
  ci_must_pass: "the pipeline has to pass first",
  ci_still_running: "the pipeline is still running",
  not_approved: "it needs more approvals",
  discussions_not_resolved: "open threads have to be resolved",
  draft_status: "it is a draft",
  blocked_status: "another merge request blocks it",
  need_rebase: "it has to be rebased onto the target branch",
  requested_changes: "a reviewer asked for changes",
  jira_association_missing: "it names no Jira issue",
  not_open: "it is not open",
  behind: "the branch is behind its base",
  blocked: "branch protection holds it (required reviews or checks)",
  draft: "it is a draft",
};

const words = (state: string) => BLOCKED[state] ?? `the forge reports ${shownText(state).replace(/_/g, " ")}`;

const gitlabState = (status: unknown): CheckState =>
  status === "success" ? "success" : status === "failed" ? "failure" : status === "skipped" || status === "canceled" || status === "manual" ? "skipped" : "pending";

async function readGitLab(http: ForgeHttp, config: ForgeConfig, number: number): Promise<RequestDetail> {
  const project = `/projects/${encodeURIComponent(config.project)}`;
  const mr = await http.request<{ state?: unknown; sha?: unknown; target_branch?: unknown; detailed_merge_status?: unknown; has_conflicts?: unknown; head_pipeline?: unknown }>("GET", `${project}/merge_requests/${number}`);
  const approvals = await http.request<{ approved?: unknown; approvals_left?: unknown; approved_by?: { user?: { username?: unknown } }[] }>("GET", `${project}/merge_requests/${number}/approvals`);
  const headSha = String(mr.sha ?? "");
  const statuses = /^[0-9a-f]{40}$/.test(headSha)
    ? await http.request<{ id?: unknown; name?: unknown; status?: unknown; created_at?: unknown; started_at?: unknown; target_url?: unknown; pipeline_id?: unknown }[]>("GET", `${project}/repository/commits/${headSha}/statuses?all=true&per_page=100`)
    : [];
  const status: RequestStatus = mr.state === "merged" ? "merged" : mr.state === "opened" ? "open" : "closed";
  const merge = String(mr.detailed_merge_status ?? "unchecked");
  const mergeability: Mergeability =
    status !== "open" ? { state: "not-open", reason: null }
    : mr.has_conflicts === true || merge === "conflict" ? { state: "conflict", reason: "the branch conflicts with its target" }
    : merge === "mergeable" ? { state: "mergeable", reason: null }
    : ["checking", "unchecked", "preparing", "approvals_syncing"].includes(merge) ? { state: "checking", reason: null }
    : { state: "blocked", reason: words(merge) };
  const approvedBy = (approvals.approved_by ?? []).map((a) => shownText(a.user?.username)).filter(Boolean);
  const review: ReviewSummary = {
    decision: approvals.approved === true && approvedBy.length ? "approved" : Number(approvals.approvals_left) > 0 ? "pending" : "none",
    approvedBy,
  };
  const raw: RawCheck[] = statuses.map((s) => ({
    name: shownText(s.name),
    group: s.pipeline_id !== undefined && s.pipeline_id !== null ? "pipeline" : "status",
    state: gitlabState(s.status),
    at: typeof s.started_at === "string" ? s.started_at : typeof s.created_at === "string" ? s.created_at : null,
    sequence: Number(s.id) || 0,
    url: shownUrl(s.target_url),
  }));
  return { number, status, headSha, ...targetOf(mr.target_branch), mergeability, review, checks: normalizeChecks(raw, CAPABILITIES.gitlab) };
}

const githubRunState = (status: unknown, conclusion: unknown): CheckState => {
  if (status !== "completed") return "pending";
  if (conclusion === "success") return "success";
  if (conclusion === "neutral" || conclusion === "skipped" || conclusion === "stale") return "skipped";
  return "failure";
};

async function readGitHub(http: ForgeHttp, config: ForgeConfig, number: number): Promise<RequestDetail> {
  const repo = `/repos/${config.project.split("/").map(encodeURIComponent).join("/")}`;
  const pr = await http.request<{ state?: unknown; merged?: unknown; mergeable?: unknown; mergeable_state?: unknown; head?: { sha?: unknown }; base?: { ref?: unknown }; requested_reviewers?: unknown[] }>("GET", `${repo}/pulls/${number}`);
  const reviews = await http.request<{ id?: unknown; user?: { login?: unknown }; state?: unknown; submitted_at?: unknown }[]>("GET", `${repo}/pulls/${number}/reviews?per_page=100`);
  const headSha = String(pr.head?.sha ?? "");
  const sha = /^[0-9a-f]{40}$/.test(headSha) ? headSha : null;
  const runs = sha ? await http.request<{ check_runs?: { id?: unknown; name?: unknown; status?: unknown; conclusion?: unknown; started_at?: unknown; html_url?: unknown; app?: { slug?: unknown } }[] }>("GET", `${repo}/commits/${sha}/check-runs?per_page=100`) : { check_runs: [] };
  const combined = sha ? await http.request<{ statuses?: { id?: unknown; context?: unknown; state?: unknown; updated_at?: unknown; target_url?: unknown }[] }>("GET", `${repo}/commits/${sha}/status`) : { statuses: [] };

  const status: RequestStatus = pr.merged === true ? "merged" : pr.state === "open" ? "open" : "closed";
  const state = String(pr.mergeable_state ?? "unknown");
  const mergeability: Mergeability =
    status !== "open" ? { state: "not-open", reason: null }
    : pr.mergeable === null || pr.mergeable === undefined || state === "unknown" ? { state: "checking", reason: null }
    : state === "dirty" || pr.mergeable === false ? { state: "conflict", reason: "the branch conflicts with its base" }
    : ["clean", "unstable", "has_hooks"].includes(state) ? { state: "mergeable", reason: null }
    : { state: "blocked", reason: words(state) };

  // Each reviewer's latest word counts; a comment says nothing, and a dismissed review takes theirs back.
  const latest = new Map<string, string>();
  for (const r of [...reviews].sort((a, b) => String(a.submitted_at ?? "").localeCompare(String(b.submitted_at ?? "")) || (Number(a.id) || 0) - (Number(b.id) || 0))) {
    const who = shownText(r.user?.login);
    if (!who || r.state === "COMMENTED" || r.state === "PENDING") continue;
    if (r.state === "DISMISSED") latest.delete(who);
    else latest.set(who, String(r.state));
  }
  const approvedBy = [...latest].filter(([, s]) => s === "APPROVED").map(([who]) => who);
  const review: ReviewSummary = {
    decision: [...latest.values()].includes("CHANGES_REQUESTED") ? "changes-requested" : approvedBy.length ? "approved" : (pr.requested_reviewers ?? []).length ? "pending" : "none",
    approvedBy,
  };

  const raw: RawCheck[] = [
    ...(runs.check_runs ?? []).map((r) => ({ name: shownText(r.name), group: shownText(r.app?.slug) || "checks", state: githubRunState(r.status, r.conclusion), at: typeof r.started_at === "string" ? r.started_at : null, sequence: Number(r.id) || 0, url: shownUrl(r.html_url) })),
    ...(combined.statuses ?? []).map((s) => ({
      name: shownText(s.context),
      group: "status",
      state: (s.state === "success" ? "success" : s.state === "pending" ? "pending" : "failure") as CheckState,
      at: typeof s.updated_at === "string" ? s.updated_at : null,
      sequence: Number(s.id) || 0,
      url: shownUrl(s.target_url),
    })),
  ];
  return { number, status, headSha, ...targetOf(pr.base?.ref), mergeability, review, checks: normalizeChecks(raw, CAPABILITIES.github) };
}

/** The branch a request merges into, when the forge names one as text. */
export const targetOf = (branch: unknown): { target?: string } => (typeof branch === "string" && branch ? { target: shownText(branch) } : {});

const READERS: Record<HostedForge, (http: ForgeHttp, config: ForgeConfig, number: number) => Promise<RequestDetail>> = { gitlab: readGitLab, github: readGitHub, gitea: readGiteaRequest };

/** The most comments a watch reads of a request, the newest; a longer thread is read from its page. */
export const COMMENTS_LIMIT = 50;
/** The most of one comment kept: a review's longest ordinary note, and short of a pasted log. */
export const COMMENT_MAX = 4000;

export const requestComment = (id: unknown, author: unknown, bot: boolean, body: unknown, at: unknown, path: unknown, line: unknown, url: unknown): RequestComment => ({
  id: String(id),
  author: shownText(author),
  kind: bot ? "bot" : "person",
  // Its lines stay; any other control character, which a terminal or a prompt reads as more than text, does not.
  body: typeof body === "string" ? body.replace(/(?![\n\t])\p{C}+/gu, " ").trim().slice(0, COMMENT_MAX) : "",
  at: typeof at === "string" ? at : "",
  path: typeof path === "string" && path ? path : null,
  line: Number.isInteger(line) ? (line as number) : null,
  url: shownUrl(url),
});

export const newestComments = (comments: RequestComment[]) => comments.sort((a, b) => b.at.localeCompare(a.at) || b.id.localeCompare(a.id)).slice(0, COMMENTS_LIMIT);

// GitLab's own notes (a push, a label set, an approval) are the forge speaking and are left out; a
// bot user, or a project's or group's access token, which GitLab names project_<id>_bot, is a bot.
async function gitlabComments(http: ForgeHttp, config: ForgeConfig, number: number): Promise<RequestComment[]> {
  type Note = { id?: unknown; body?: unknown; author?: { username?: unknown; bot?: unknown }; updated_at?: unknown; system?: unknown; position?: { new_path?: unknown; new_line?: unknown } | null };
  const notes = await http.request<Note[]>("GET", `/projects/${encodeURIComponent(config.project)}/merge_requests/${number}/notes?sort=desc&order_by=updated_at&per_page=${COMMENTS_LIMIT}`);
  return newestComments(notes.filter((n) => n.system !== true).map((n) => requestComment(n.id, n.author?.username, n.author?.bot === true || /^(project|group)_\d+_bot/.test(String(n.author?.username ?? "")), n.body, n.updated_at, n.position?.new_path, n.position?.new_line, null)));
}

// A GitHub request's conversation and its comments on lines are two lists; an app's account is a bot.
async function githubComments(http: ForgeHttp, config: ForgeConfig, number: number): Promise<RequestComment[]> {
  type Said = { id?: unknown; body?: unknown; user?: { login?: unknown; type?: unknown }; updated_at?: unknown; html_url?: unknown; path?: unknown; line?: unknown };
  const repo = `/repos/${config.project.split("/").map(encodeURIComponent).join("/")}`;
  const [conversation, onLines] = await Promise.all([
    http.request<Said[]>("GET", `${repo}/issues/${number}/comments?per_page=100`),
    http.request<Said[]>("GET", `${repo}/pulls/${number}/comments?sort=updated&direction=desc&per_page=${COMMENTS_LIMIT}`),
  ]);
  return newestComments([...conversation, ...onLines].map((c) => requestComment(c.id, c.user?.login, c.user?.type === "Bot", c.body, c.updated_at, c.path, c.line, c.html_url)));
}

const COMMENT_READERS: Record<HostedForge, (http: ForgeHttp, config: ForgeConfig, number: number) => Promise<RequestComment[]>> = { gitlab: gitlabComments, github: githubComments, gitea: giteaComments };

/**
 * What changes when anything a watcher acts on does: the request's state, head and target, whether it can
 * merge, the review, each check's state, and each person's comment as last edited. A body is not in it, so
 * an edited comment counts by its time.
 */
export function watchFingerprint(detail: RequestDetail, comments: RequestComment[]): string {
  const facts = {
    status: detail.status,
    head: detail.headSha,
    target: detail.target ?? null,
    merge: detail.mergeability.state,
    review: [detail.review.decision, [...detail.review.approvedBy].sort()],
    checks: detail.checks.checks.map((c) => `${c.group}/${c.name}=${c.state}`).sort(),
    // A bot's comment wakes nobody: a CI reporter or an updater says nothing a reviewer did.
    comments: comments.filter((c) => c.kind === "person").map((c) => `${c.id}@${c.at}`).sort(),
  };
  return createHash("sha256").update(JSON.stringify(facts)).digest("hex").slice(0, 32);
}

/** A request as a watch reads it: its detail, what people said on it, and the fingerprint of both. */
export function readRequestWatch(ctx: OrchestratorContext, repo: RepoRecord, number: number): Promise<RequestWatch> {
  return withForge(ctx, repo, async (http, config) => {
    const [detail, comments] = await Promise.all([READERS[config.kind](http, config, number), COMMENT_READERS[config.kind](http, config, number)]);
    return { detail, comments, fingerprint: watchFingerprint(detail, comments) };
  });
}

// In local mode a repository connected with no token is read through the person's own gh or glab, GETs alone.
async function withForge<T>(ctx: OrchestratorContext, repo: RepoRecord, read: (http: ForgeHttp, config: ForgeConfig) => Promise<T>): Promise<T> {
  const access = await repoForgeAccess(ctx, repo);
  const own = !access && (await ownCliHere(ctx)) ? cliConfig(await ctx.store.getForgeConfig(repo.tenant, repo.id)) : null;
  if (!access && !own) throw new ForgeReadError("unauthenticated", `the orchestrator has no access to ${repo.name}'s requests; an owner or an admin connects it under Integrations`);
  const config = access?.config ?? own!;
  const http = access ? forgeHttp(FORGES[config.kind].label, config.apiUrl, access.token, access.headers, access.send) : ownCliReader(own!.kind, new URL(repo.url).host);
  try {
    return await read(http, config);
  } catch (err) {
    if (err instanceof OwnCliRefused) throw new ForgeReadError("unauthenticated", err.message);
    if (err instanceof ForgeHttpError) throw readFailure(err, config.kind, repo, Boolean(ctx.addedRepos?.get(repo.id)?.connection));
    throw err;
  }
}
