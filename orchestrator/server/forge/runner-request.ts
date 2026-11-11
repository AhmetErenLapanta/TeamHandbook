import type { OrchestratorContext } from "../app.js";
import { repoForgeAccess } from "../propose.js";
import type { RepoRecord } from "../store.js";
import { FORGES } from "../../shared/forge-def.js";
import type { HostedForge } from "../../shared/forge-def.js";
import { giteaRunnerSeen } from "./gitea.js";
import { forgeHttp, ForgeHttpError } from "./http.js";
import { cliConfig, ownCliReader, OwnCliRefused } from "./own-cli.js";
import type { ForgeHttp } from "./http.js";
import type { ForgeConfig } from "./types.js";
import { shownUrl } from "./types.js";
import { ownCliHere } from "./own-cli-here.js";

/**
 * A request a person's own machine opened for a task, recognised by the orchestrator. The local
 * runner pushes and opens it with the person's own git identity, so the orchestrator never hands its
 * forge access to that machine; what the runner or a webhook says about the request is only a
 * number to look up. The orchestrator reads the request itself, with its own access, and takes it as
 * the task's only when the forge says it is the task's branch, from the team's own repository,
 * opened by the person who started the task.
 */
export interface RunnerRequestExpectation {
  repo: RepoRecord;
  /** The one branch the orchestrator named for the task when it was taken. */
  branch: string;
  /** Who started the task, as the task records them. */
  starterEmail: string;
  /** The commit the runner says it pushed; a delivery names its own and leaves this out. */
  headSha?: string;
  /**
   * Whether the runner that reports the request still holds the task's lease. Asked before the
   * forge is read and again once it answered: a runner that lost its task, to an expired lease or
   * another machine, has its request refused rather than taken for a task it no longer runs.
   */
  held(): Promise<boolean>;
}

export interface RecognisedRequest {
  number: number;
  url: string;
  headSha: string;
}

/**
 * `unverified` is set when the orchestrator could not read the forge at all, rather than read it
 * and find the request is not the task's: the request is shown as opened, not verified, and the
 * task does not move to review on it.
 */
export type RunnerRequestMatch = { ok: true; request: RecognisedRequest } | { ok: false; reason: string; unverified?: true };

interface Unread {
  reason: string;
  unverified?: true;
}

interface Seen {
  sourceBranch: string;
  fromFork: boolean;
  author: string;
  headSha: string;
  url: string | null;
  open: boolean;
}

const READERS: Record<HostedForge, (http: ForgeHttp, config: ForgeConfig, number: number) => Promise<Seen>> = {
  async gitlab(http, config, number) {
    const mr = await http.request<{ source_branch?: unknown; source_project_id?: unknown; target_project_id?: unknown; author?: { username?: unknown }; sha?: unknown; web_url?: unknown; state?: unknown }>("GET", `/projects/${encodeURIComponent(config.project)}/merge_requests/${number}`);
    return { sourceBranch: String(mr.source_branch ?? ""), fromFork: mr.source_project_id !== mr.target_project_id, author: String(mr.author?.username ?? ""), headSha: String(mr.sha ?? ""), url: shownUrl(mr.web_url), open: mr.state === "opened" };
  },
  async github(http, config, number) {
    const [owner, name] = config.project.split("/").map(encodeURIComponent);
    const pr = await http.request<{ head?: { ref?: unknown; sha?: unknown; repo?: { full_name?: unknown } | null }; base?: { repo?: { full_name?: unknown } }; user?: { login?: unknown }; html_url?: unknown; state?: unknown }>("GET", `/repos/${owner}/${name}/pulls/${number}`);
    return { sourceBranch: String(pr.head?.ref ?? ""), fromFork: !pr.head?.repo || pr.head.repo.full_name !== pr.base?.repo?.full_name, author: String(pr.user?.login ?? ""), headSha: String(pr.head?.sha ?? ""), url: shownUrl(pr.html_url), open: pr.state === "open" };
  },
  gitea: giteaRunnerSeen,
};

/**
 * The request as the forge has it, read with the orchestrator's own access; in local mode, with no
 * token here, through the person's own gh or glab on this same machine, reading only.
 */
async function read(ctx: OrchestratorContext, repo: RepoRecord, number: number): Promise<Seen | Unread> {
  const access = await repoForgeAccess(ctx, repo);
  const own = !access && (await ownCliHere(ctx)) ? cliConfig(await ctx.store.getForgeConfig(repo.tenant, repo.id)) : null;
  if (!access && !own) return { reason: "the orchestrator has no access to this repository's forge to recognize the request", unverified: true };
  const config = access?.config ?? own!;
  const http = access ? forgeHttp(FORGES[config.kind].label, config.apiUrl, access.token, access.headers, access.send) : ownCliReader(own!.kind, new URL(repo.url).host);
  try {
    return await READERS[config.kind](http, config, number);
  } catch (err) {
    if (err instanceof OwnCliRefused) return { reason: err.message, unverified: true };
    if (err instanceof ForgeHttpError) return { reason: err.status === 404 ? `the forge has no request ${number} in ${repo.name}` : err.message };
    throw err;
  }
}

/** The starter's forge login as the forges match one, whatever its case; one that two accounts carry names nobody. */
async function starterLogin(ctx: OrchestratorContext, email: string): Promise<string | { reason: string }> {
  const users = await ctx.store.listUsers(ctx.tenant);
  const login = users.find((u) => u.email === email)?.forgeLogin?.toLowerCase();
  if (!login) return { reason: `${email} has no forge login in the orchestrator, so a request opened as them cannot be told from anyone's` };
  if (users.filter((u) => u.forgeLogin?.toLowerCase() === login).length > 1) return { reason: `${login} is the forge login of more than one orchestrator user` };
  return login;
}

async function judge(ctx: OrchestratorContext, expected: Omit<RunnerRequestExpectation, "held">, number: number, seen: Seen): Promise<RunnerRequestMatch> {
  const login = await starterLogin(ctx, expected.starterEmail);
  if (typeof login !== "string") return { ok: false, ...login };
  if (!seen.open) return { ok: false, reason: `request ${number} is not open` };
  if (seen.fromFork) return { ok: false, reason: `request ${number} comes from a fork, not from ${expected.repo.name} itself` };
  if (seen.sourceBranch !== expected.branch) return { ok: false, reason: `request ${number} is from ${seen.sourceBranch}, not the task's branch ${expected.branch}` };
  if (seen.author.toLowerCase() !== login) return { ok: false, reason: `request ${number} was opened by ${seen.author}, not by the person who started the task` };
  if (expected.headSha !== undefined && seen.headSha !== expected.headSha) return { ok: false, reason: `request ${number} is at another commit than the runner reported` };
  if (!seen.url || !/^[0-9a-f]{40}$/.test(seen.headSha)) return { ok: false, reason: `the forge gave request ${number} no address or commit` };
  return { ok: true, request: { number, url: seen.url, headSha: seen.headSha } };
}

const NOT_HELD: RunnerRequestMatch = { ok: false, reason: "the runner no longer holds the task, so its request is not taken" };

/** Whether request `number` on the task's repository is the one the task's runner opened: the runner's report, checked. */
export async function matchRunnerRequest(ctx: OrchestratorContext, expected: RunnerRequestExpectation, number: number): Promise<RunnerRequestMatch> {
  if (!Number.isInteger(number) || number < 1) return { ok: false, reason: "a request is named by its number" };
  // Asked first: without a login to hold the request to, the forge has nothing to answer.
  const login = await starterLogin(ctx, expected.starterEmail);
  if (typeof login !== "string") return { ok: false, ...login };
  if (!(await expected.held())) return NOT_HELD;
  const seen = await read(ctx, expected.repo, number);
  if ("reason" in seen) return { ok: false, ...seen };
  const match = await judge(ctx, expected, number, seen);
  return match.ok && !(await expected.held()) ? NOT_HELD : match;
}

/**
 * The unfinished task a delivered request belongs to: a webhook names only the request, so the
 * orchestrator reads it once and holds it to the task whose branch it comes from, under the same
 * checks as a runner's report. Null when it is no task's; the reason is what the event log keeps.
 */
export async function taskOfDeliveredRequest(ctx: OrchestratorContext, repo: RepoRecord, number: number): Promise<{ taskId: string; request: RecognisedRequest } | { reason: string }> {
  if (!Number.isInteger(number) || number < 1) return { reason: "a request is named by its number" };
  const seen = await read(ctx, repo, number);
  if ("reason" in seen) return { reason: seen.reason };
  for (const task of await ctx.store.unfinishedTasks(ctx.tenant)) {
    const part = [{ repoId: task.repoId, branch: task.branch }, ...task.targets].find((t) => t.repoId === repo.id && t.branch === seen.sourceBranch);
    if (!part) continue;
    const record = await ctx.store.getTask(ctx.tenant, task.id);
    if (!record) continue;
    const match = await judge(ctx, { repo, branch: part.branch!, starterEmail: record.createdBy }, number, seen);
    return match.ok ? { taskId: task.id, request: match.request } : { reason: match.reason };
  }
  return { reason: `request ${number} is from ${seen.sourceBranch}, which no unfinished task named` };
}
