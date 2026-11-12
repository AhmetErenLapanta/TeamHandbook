import { watchedForge } from "./integrations/health.js";
import { connectionToken, forgettingRefused } from "./forge/oauth-access.js";
import { DRIVERS } from "./forge/registry.js";
import { removesAgentCredits, withoutAgentCredits } from "./forge/agent-credits.js";
import { cliConfig, createOwnCliForge } from "./forge/own-cli.js";
import { gitAccess } from "./connect.js";
import { forgeApp } from "./forge/oauth.js";
import { existsSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { OrchestratorError } from "./errors.js";
import { join, resolve } from "node:path";
import type { OrchestratorContext } from "./app.js";
import { inConfiguration, mirrorDir, syncRepo } from "./app.js";
import type { Principal } from "./auth.js";
import { createLocalForge, deleteLocalBranch, inLocalTurn, localDescriptionRef, localRepoPath, mergeLocalBranch } from "./forge/local.js";
import { isGitFolder } from "./projects.js";
import { recheckRequest } from "./tasks/pushed-check.js";
import type { ChangeRequest, ForgeConfig, ForgeProvider, RequestAssignment, RequestRecord, RequestStatus } from "./forge/types.js";
import { ORCHESTRATOR_BRANCH_PREFIX } from "./branches.js";
import type { BuiltChange } from "./changes.js";
import { orchestratorCommitter, eachAtMost, gitAsync, gitAsyncMaybe, oneAtATime, turnKey } from "./git.js";
import { assignmentRecordProblem, TEAM_PREFIX_FILE } from "./plugin.js";
import { ORCHESTRATOR_ACTOR, recordEvent } from "./events.js";
import type { EventActor } from "./events.js";
import type { RepoRecord } from "./store.js";
import { readSecret } from "./vault.js";
import { ownCliHere } from "./forge/own-cli-here.js";

/**
 * A token is kept under the repository and the origin it was entered for. The provider looks
 * it up by the origin it is about to call, so a forge address changed afterwards, by any path,
 * finds no token rather than receiving the one meant for the old address.
 */
export function forgeTokenName(config: Pick<ForgeConfig, "repoId" | "apiUrl">): string {
  return `forge-token:${config.repoId}@${new URL(config.apiUrl).origin}`;
}

/**
 * The provider a repository's changes go through. A repository the orchestrator reaches by path
 * uses the local forge; one on GitLab or GitHub gets its provider once an admin has set its
 * project and a token, which is opened from the vault for this one call and kept nowhere else.
 */
export async function providerFor(ctx: OrchestratorContext, repo: RepoRecord): Promise<ForgeProvider | null> {
  if (localRepoPath(repo.url)) return localForge(ctx);
  const own = await ownCliProvider(ctx, repo);
  if (own) return watchedForge(ctx, repo, own);
  const access = await repoForgeAccess(ctx, repo);
  if (!access) return null;
  const { config, token, send, oauth } = access;
  return watchedForge(ctx, repo, DRIVERS[config.kind].provider(config, token, send, oauth));
}

export function localForge(ctx: OrchestratorContext): ForgeProvider {
  return createLocalForge(join(ctx.dataDir, "work"), {
    nextNumber: (tenant, id) => ctx.store.nextRequestNumber(tenant, id),
    request: (tenant, id, number) => ctx.store.getRequest(tenant, id, number),
  });
}

/**
 * For a repository connected with no token on one person's own orchestrator: their own gh or glab
 * opens its requests. Null for any other, and once a second account is here, asked at each use:
 * one member's task is never pushed and opened with the machine owner's sign-in.
 */
export async function ownCliProvider(ctx: OrchestratorContext, repo: RepoRecord): Promise<ForgeProvider | null> {
  if (!ctx.addedRepos?.get(repo.id)?.viaOwnCli || !(await ownCliHere(ctx))) return null;
  const own = cliConfig(await ctx.store.getForgeConfig(repo.tenant, repo.id));
  return own && createOwnCliForge(own, join(ctx.dataDir, "work"), (r) => mirrorDir(ctx, r.id), async (r) => (await gitAccess(ctx, r))?.env ?? null);
}

/**
 * How the orchestrator reaches a repository's forge for this one call: its settings, the token, and
 * the fetch to send with. One reached through the org's connection takes a token the connection
 * renews, never one sealed beside the repository; an org's own GitLab is reached only at the
 * address judged for it now. Null until the repository has forge settings and a token.
 */
export async function repoForgeAccess(ctx: OrchestratorContext, repo: RepoRecord): Promise<{ config: ForgeConfig; token: string; send: typeof fetch; oauth: boolean; headers: Record<string, string> } | null> {
  const config = await ctx.store.getForgeConfig(repo.tenant, repo.id);
  if (!config) return null;
  const connection = ctx.addedRepos?.get(repo.id)?.connection;
  const token = connection ? await connectionToken(ctx, connection) : await readSecret(ctx.store, ctx.vault ?? null, repo.tenant, forgeTokenName(config));
  if (!token) return null;
  const app = connection === "gitlab" ? await forgeApp(ctx, "gitlab") : null;
  const oauth = Boolean(connection);
  const headers = DRIVERS[config.kind].authHeaders(token, oauth);
  const base = app?.send ?? fetch;
  return { config, token, send: connection ? forgettingRefused(ctx, connection, token, base) : base, oauth, headers };
}

/** Open a change as a request and keep its record. The change never reaches the default branch here. */
/**
 * Who a request to this repository asks to review and how it is labelled, as the team
 * recorded it, with the person who opened it as the assignee when the orchestrator knows their
 * forge login. The same record the plugin reads when it opens a request from a laptop.
 */
export async function teamAssignment(ctx: OrchestratorContext, repo: RepoRecord, user: Principal): Promise<RequestAssignment> {
  const text = repo.head ? await gitAsyncMaybe(["show", `${repo.head}:${TEAM_PREFIX_FILE}`], mirrorDir(ctx, repo.id)) : null;
  let json: { reviewers?: unknown; labels?: unknown } = {};
  try {
    json = text ? (JSON.parse(text) as typeof json) : {};
  } catch {
    json = {};
  }
  // The file is written by whoever can push to the team repository, so each entry passes the
  // plugin's own rule before it reaches a forge, the way the plugin reads it: a list longer
  // than the rule allows is used not at all, an entry that fails is left out, a leading @ is dropped.
  const usable = (kind: "reviewers" | "labels"): string[] => {
    const value = json[kind];
    // A list of plain names the same length fails only on its length.
    if (!Array.isArray(value) || assignmentRecordProblem({ [kind]: value.map(() => "a") }) !== null) return [];
    return value.filter((entry): entry is string => typeof entry === "string" && assignmentRecordProblem({ [kind]: [entry] }) === null).map((entry) => entry.trim().replace(/^@/, ""));
  };
  return { reviewers: usable("reviewers"), labels: usable("labels"), ...(user.forgeLogin ? { assignee: user.forgeLogin } : {}) };
}

/**
 * A request's turn on one repository, from the version raise to the opened request. Two
 * requests prepared at the same moment both read the branches before either was opened and
 * claimed one number, measured in the lab as 0.1.20 twice; in one turn the second reads the
 * first one's branch. The mirror is synced first, so a teammate's share pushed since the last
 * sync counts too, as it does for the plugin, which reads the branches live with ls-remote. A
 * sync that fails leaves the mirror as it was, and the request is prepared from that.
 *
 * The turn is this orchestrator's; orchestrators of two tenants on one database that reach the same team
 * repository take it in turn as well, held by the store under the repository's address - 0.1.31
 * twice in the lab before. A teammate's share pushed between this sync and the request still
 * races it, as two teammates' shares race each other.
 */
export function inRequestTurn<T>(ctx: OrchestratorContext, repoId: string, work: () => Promise<T>): Promise<T> {
  return oneAtATime(`${mirrorDir(ctx, repoId)}.requests`, async () => {
    const turn = async () => {
      await syncRepo(ctx, repoId);
      return work();
    };
    const repo = ctx.store.holdRepository ? await ctx.store.getRepo(ctx.tenant, repoId) : null;
    return repo && ctx.store.holdRepository ? ctx.store.holdRepository(repositoryAddress(repo.url), turn) : turn();
  });
}

/**
 * A team repository's address as every orchestrator reaching it shares it, however it was written:
 * `git@host:org/repo.git`, `ssh://git@host:22/org/repo` and `https://user:token@Host:443/Org/Repo/`
 * are all `host/org/repo`. No scheme, user, token, default port or `.git`, and in lower case, as
 * forges match paths; a local one by its real path. Two tenants given different addresses and
 * tokens for one repository then take one turn.
 */
export function repositoryAddress(url: string): string {
  const local = localRepoPath(url);
  if (local) return `file://${turnKey(local)}`;
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(url);
  const rest = url.slice(scheme?.[0].length ?? 0).replace(/^[^@/]*@/, "");
  // scp-like `host:org/repo` has no scheme; its colon separates the host from the path.
  const [hostPart = "", ...path] = scheme ? rest.split("/") : rest.replace(":", "/").split("/");
  const host = hostPart.replace(/:(22|80|443)$/, "");
  return [host, ...path].join("/").toLowerCase().replace(/\/+$/, "").replace(/\.git$/, "");
}

export async function propose(ctx: OrchestratorContext, repo: RepoRecord, user: Principal, change: Omit<ChangeRequest, "author" | "baseSha">): Promise<RequestRecord> {
  const provider = await providerFor(ctx, repo);
  if (!provider) throw new Error(`no forge is configured for ${repo.name}`);
  if (!repo.head) throw new Error(`${repo.name} has not been read yet`);
  const opened = await provider.open(repo, {
    assignment: await teamAssignment(ctx, repo, user),
    ...change,
    // A forge that squashes with the description writes it into history; a team can keep the agent's credit lines out of it.
    ...((await removesAgentCredits(ctx, repo.id)) ? { body: withoutAgentCredits(change.body) } : {}),
    baseSha: repo.head,
    author: { name: user.name, email: user.email },
  });
  const record: RequestRecord = {
    ...opened,
    tenant: repo.tenant,
    repoId: repo.id,
    title: change.title,
    status: "open",
    provider: provider.kind,
    createdAt: new Date().toISOString(),
    createdBy: user.email,
  };
  try {
    await ctx.store.saveRequest(record);
  } catch (err) {
    if (provider.kind === "local") await deleteLocalBranch(repo, opened.branch);
    throw err;
  }
  const paths = change.files.map((f) => f.path);
  await recordEvent(ctx, user, "request.opened", {
    repoId: repo.id,
    subject: `request:${record.number}`,
    detail: `"${record.title}" on ${record.branch}, changing ${paths.slice(0, 5).join(", ")}${paths.length > 5 ? ` and ${paths.length - 5} more` : ""}`,
  });
  // The mirror takes the new branch now, so the next request's version raise sees what this
  // one claims instead of claiming the same number.
  await syncRepo(ctx, repo.id);
  return record;
}

export class RequestRefused extends OrchestratorError {
  constructor(message: string) {
    super("request-refused", message, 409);
  }
}

/**
 * A person merging a request opened on the local forge. Everything happens in the
 * repository's turn: the request is read again there, git merges, and only then is the
 * request recorded as merged. A second merge sent at the same moment waits its turn and finds
 * the request merged; a merge git refuses, or one cut off by a stop, leaves the request open,
 * never recorded as merged while the default branch has not moved. If the process dies after
 * git and before the record, the start that follows reads the branch's ancestry and records
 * what happened (`reconcileLocalRequests`).
 */
export async function mergeRequest(ctx: OrchestratorContext, repo: RepoRecord, number: number, user: Principal): Promise<RequestRecord> {
  const request = await localRequest(ctx, repo, number, "merge");
  await inLocalTurn(repo, async () => {
    // Read again in the repository's turn: a check that held the request or passed a later head since counts.
    const now = await localRequest(ctx, repo, number, "merge");
    if (now.heldHead) throw new RequestRefused(now.heldReason || "this request is held until a later push passes its check");
    // Only the head the check last passed merges; a request no task opened has none and merges as it stands.
    await mergeLocalBranch(join(ctx.dataDir, "work"), repo, now.branch, { name: user.name, email: user.email }, now.checkedHead);
    await ctx.store.transitionRequest(repo.tenant, repo.id, number, "open", "merged");
  });
  await recordEvent(ctx, user, "request.merged", { repoId: repo.id, subject: `request:${number}`, detail: `merged "${request.title}" on the local forge` });
  await syncRepo(ctx, repo.id);
  return { ...request, status: "merged" };
}

/** One bare repository however its records spell its URL, so two records of it are seen as one. */
function repositoryPath(url: string): string | null {
  const path = localRepoPath(url);
  if (!path) return null;
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

const RECONCILE_AT_ONCE = 8;

/**
 * What a start does before it serves anyone, to undo what an orchestrator that died mid-write left:
 *
 * - a request recorded as merged whose branch is not in the default branch goes back to open,
 *   and one recorded as open whose branch is in it is recorded as merged, so the record says
 *   what the repository holds;
 * - a branch the orchestrator named (`handbook/orchestrator-...`) and committed, that no request names,
 *   is moved out of the branch list - with its description - to
 *   `refs/orchestrator/orphaned/<time>/`, where `git update-ref` brings it back. Nothing is deleted:
 *   a repository can be connected twice (an id changed in orchestrator.json leaves the old record
 *   behind), so "no request names it" is judged against every request of every record and
 *   tenant that reaches the same repository, and even then the orchestrator moves what it cannot
 *   prove is its own rather than lose it;
 * - the scratch repositories a change or a merge was assembled in are deleted.
 *
 * The data directory's lock is held by then, so no other orchestrator is using any of it.
 */
export async function reconcileLocalRequests(ctx: OrchestratorContext): Promise<string[]> {
  const said: string[] = [];
  const work = join(ctx.dataDir, "work");
  for (const name of existsSync(work) ? readdirSync(work) : []) {
    if (!/^(change|merge|read)-/.test(name)) continue;
    rmSync(join(work, name), { recursive: true, force: true });
    said.push(`removed the scratch directory ${name} a stopped orchestrator left`);
  }
  // Every request on record names its branch, whatever repository record it belongs to: one
  // whose record was disconnected, or renamed in the configuration, has no path left to be
  // matched by. An orchestrator branch name carries a random part, so a name keeps only its own branch.
  const named = new Set((await ctx.store.allRequests()).map((r) => r.branch));
  const committer = `<${orchestratorCommitter().email}>`;
  const swept = new Set<string>();
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  // Repositories side by side, each in its own turn: one after another, a company's worth of
  // them held the start before anyone was served.
  await eachAtMost(await ctx.store.listRepos(ctx.tenant), RECONCILE_AT_ONCE, async (repo) => {
    const bare = localRepoPath(repo.url);
    const path = repositoryPath(repo.url);
    // A repository the file no longer lists is not changed, its team's repository included. A
    // folder without git, worked on in place, has no branches to settle.
    if (!inConfiguration(ctx, repo.id) || !bare || !path || !existsSync(bare) || !(await isGitFolder(bare))) return;
    await inLocalTurn(repo, async () => {
      const target = (await gitAsync(["symbolic-ref", "--short", "HEAD"], bare)).trim();
      // Two listings per repository rather than two git processes per request: a team with
      // thousands of requests on record otherwise held the start for minutes.
      const active = (await ctx.store.listRequests(ctx.tenant, repo.id)).filter((r) => r.provider === "local" && r.status !== "closed");
      const [branches, inTarget] = active.length
        ? await Promise.all([branchNames(bare), branchNames(bare, `--merged=refs/heads/${target}`)])
        : [new Set<string>(), new Set<string>()];
      for (const request of active) {
        if (!branches.has(request.branch)) continue;
        const truth = inTarget.has(request.branch) ? "merged" : "open";
        if (truth !== request.status && (await ctx.store.transitionRequest(repo.tenant, repo.id, request.number, request.status, truth))) {
          said.push(`${repo.id} request #${request.number} was recorded ${request.status} but its branch is ${truth === "merged" ? "" : "not "}in ${target}; now ${truth}`);
          await recordEvent(ctx, ORCHESTRATOR_ACTOR, `request.${truth === "open" ? "reopened" : truth}`, { repoId: repo.id, subject: `request:${request.number}`, detail: said.at(-1)! });
        }
      }
      if (swept.has(path)) return;
      swept.add(path);
      // A branch the orchestrator made carries its description under refs/notes/orchestrator/<branch>,
      // whatever the team's naming made of its name; one from before descriptions, the
      // orchestrator's own prefix. A teammate's branch has neither, whoever committed its tip.
      const described = new Set(
        (await gitAsync(["for-each-ref", "--format=%(refname)", "refs/notes/orchestrator/"], bare)).split("\n").filter(Boolean).map((ref) => ref.slice("refs/notes/orchestrator/".length)),
      );
      const refs = (await gitAsync(["for-each-ref", "--format=%(refname)%00%(committeremail)%00%(objectname)", "refs/heads/"], bare)).split("\n").filter(Boolean);
      for (const line of refs) {
        const [ref, email, sha] = line.split("\0");
        const branch = ref?.slice("refs/heads/".length);
        if (!branch || !sha || named.has(branch) || email !== committer) continue;
        if (!branch.startsWith(ORCHESTRATOR_BRANCH_PREFIX) && !described.has(branch)) continue;
        const aside = `refs/orchestrator/orphaned/${stamp}`;
        await gitAsync(["update-ref", `${aside}/heads/${branch}`, sha], bare);
        const note = (await gitAsyncMaybe(["rev-parse", "--verify", "--quiet", localDescriptionRef(branch)], bare))?.trim();
        if (note) await gitAsync(["update-ref", `${aside}/notes/${branch}`, note], bare);
        await gitAsync(["update-ref", "-d", `refs/heads/${branch}`, sha], bare);
        if (note) await gitAsync(["update-ref", "-d", localDescriptionRef(branch), note], bare);
        const back = [`git update-ref refs/heads/${branch} ${aside}/heads/${branch}`, ...(note ? [`git update-ref ${localDescriptionRef(branch)} ${aside}/notes/${branch}`] : [])];
        said.push(`${repo.id}: ${branch} is a branch the orchestrator made that no request names; moved to ${aside}/heads/${branch}${note ? " with its description" : ""} (in the repository, ${back.join(" && ")} brings it back)`);
        await recordEvent(ctx, ORCHESTRATOR_ACTOR, "branch.moved", { repoId: repo.id, subject: `branch:${branch}`, detail: said.at(-1)! });
      }
    });
  });
  return said;
}

/** The repository's branch names, full ref names read so a tag of the same name cannot stand in for one; `filter` narrows them, as `--merged` does. */
async function branchNames(bare: string, filter?: string): Promise<Set<string>> {
  const refs = await gitAsync(["for-each-ref", "--format=%(refname)", ...(filter ? [filter] : []), "refs/heads/"], bare);
  return new Set(refs.split("\n").filter(Boolean).map((ref) => ref.slice("refs/heads/".length)));
}

/** Closing takes the same turn, so it cannot land between a merge's git and its record. */
export async function closeRequest(ctx: OrchestratorContext, repo: RepoRecord, number: number, by: Principal | EventActor = ORCHESTRATOR_ACTOR): Promise<RequestRecord> {
  const request = await localRequest(ctx, repo, number, "close");
  await inLocalTurn(repo, async () => {
    await localRequest(ctx, repo, number, "close");
    await ctx.store.transitionRequest(repo.tenant, repo.id, number, "open", "closed");
  });
  await recordEvent(ctx, by, "request.closed", { repoId: repo.id, subject: `request:${number}`, detail: `closed "${request.title}" on the local forge` });
  return { ...request, status: "closed" };
}

async function localRequest(ctx: OrchestratorContext, repo: RepoRecord, number: number, verb: string): Promise<RequestRecord> {
  const request = await ctx.store.getRequest(repo.tenant, repo.id, number);
  if (!request) throw new RequestRefused(`there is no request #${number}`);
  if (request.provider !== "local") throw new RequestRefused(`request #${number} lives on ${request.provider}; ${verb} it there`);
  if (request.status !== "open") throw new RequestRefused(`request #${number} is ${request.status}`);
  return request;
}

/** Where a request on a hosted forge stands now; a merge there is read back into the mirror. */
export async function refreshRequest(ctx: OrchestratorContext, repo: RepoRecord, number: number, by: Principal | EventActor = ORCHESTRATOR_ACTOR, how = "read when this person refreshed it"): Promise<RequestRecord> {
  const request = await ctx.store.getRequest(repo.tenant, repo.id, number);
  if (!request) throw new RequestRefused(`there is no request #${number}`);
  const provider = await providerFor(ctx, repo);
  if (!provider?.status || provider.kind !== request.provider) return request;
  const forge = await provider.status(repo, number);
  // A request a task opened is held to the team's rules at every head it moves to, read here as on a webhook.
  if (forge.headSha && forge.status === "open" && request.status === "open") void recheckRequest(ctx, repo, request, forge.headSha).catch((err: Error) => console.error(`check of ${repo.id} #${number} at ${forge.headSha!.slice(0, 7)}: ${err.message}`));
  const status = forge.status;
  if (status === request.status) return request;
  // A forge that gives no time for the merge is read as merged when the orchestrator learned it.
  const mergedAt = status === "merged" ? (forge.mergedAt ?? new Date().toISOString()) : null;
  // Recorded in the repository's turn, which a disconnect holds from its checks to its last
  // delete; a repository disconnected while the forge answered takes no reopened request.
  const recorded = await oneAtATime(mirrorDir(ctx, repo.id), async () => {
    if (!(await ctx.store.getRepo(repo.tenant, repo.id))) return false;
    await ctx.store.setRequestStatus(repo.tenant, repo.id, number, status, mergedAt);
    return true;
  });
  if (!recorded) throw new RequestRefused(`${repo.name} was disconnected while its forge was asked about request #${number}`);
  // The forge says who merged or closed it; the orchestrator knows only who asked and what the forge answered.
  await recordEvent(ctx, by, `request.${status === "open" ? "reopened" : status}`, {
    repoId: repo.id,
    subject: `request:${number}`,
    detail: `${provider.kind === "local" ? "the orchestrator" : DRIVERS[provider.kind].definition.label} says "${request.title}" is ${status === "open" ? "open again" : status}; ${how}`,
  });
  if (status === "merged") await syncRepo(ctx, repo.id);
  const { mergedAt: _was, ...rest } = request;
  return { ...rest, status, ...(mergedAt ? { mergedAt } : {}) };
}

/**
 * The team file with `usage.endpoint` set, or with `usage` taken out when `endpoint` is null,
 * every other key and its order kept. This is the team half of the consent: merged, it asks
 * each teammate's plugin to report; each teammate still has to agree on their own machine
 * before anything is sent.
 */
export function teamFileWithUsage(existing: string | null, endpoint: string | null): string {
  let json: Record<string, unknown> = {};
  if (existing !== null) {
    const parsed: unknown = JSON.parse(existing);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${TEAM_PREFIX_FILE} is not a JSON object`);
    json = parsed as Record<string, unknown>;
  }
  const next: Record<string, unknown> = { ...json, usage: { endpoint } };
  if (endpoint === null) delete next.usage;
  return JSON.stringify(next, null, 2) + "\n";
}

/** What a usage request does: ask a team to report, move its reports to a new address, or stop asking. */
export type UsageAction = "ask" | "rotate" | "stop";

export const USAGE_REQUESTS: Record<UsageAction, { proposal: string; topic: string; body: string[] }> = {
  ask: {
    proposal: "chore: ask teammates' TeamHandbook to report skill-use counts",
    topic: "usage",
    body: [
      `Sets usage.endpoint in ${TEAM_PREFIX_FILE}. Once this is merged, a teammate's TeamHandbook offers to report`,
      "which of this repository's skills they used, by name and hour. It sends nothing until that",
      "teammate agrees on their own machine, and it never sends a skill from outside this repository,",
      "the skill's arguments, a path, or who used it.",
    ],
  },
  rotate: {
    proposal: "chore: give teammates' TeamHandbook a new address for skill-use counts",
    topic: "usage-address",
    body: [
      `Gives usage.endpoint in ${TEAM_PREFIX_FILE} a new address. The orchestrator stopped accepting the old one when this`,
      "request was opened. A teammate's agreement covers one exact address, so once this is merged each",
      "teammate's TeamHandbook asks them again before it sends anything to the new one.",
    ],
  },
  stop: {
    proposal: "chore: stop asking teammates' TeamHandbook for skill-use counts",
    topic: "usage-stop",
    body: [`Takes usage out of ${TEAM_PREFIX_FILE}. Once this is merged, no teammate's TeamHandbook reports skill use for this repository.`],
  },
};

/**
 * A usage request's change to the team file at `head`, every other key kept. Built by the
 * orchestrator, since only it knows the endpoint, then prepared like any other change - the
 * person's message, the version raise.
 */
export async function usageChange(ctx: OrchestratorContext, repo: RepoRecord, head: string, action: UsageAction, endpoint: string | null): Promise<BuiltChange> {
  const existing = await gitAsyncMaybe(["show", `${head}:${TEAM_PREFIX_FILE}`], mirrorDir(ctx, repo.id));
  const { proposal, topic, body } = USAGE_REQUESTS[action];
  return { proposal, body, topic, files: [{ path: TEAM_PREFIX_FILE, content: teamFileWithUsage(existing, endpoint) }] };
}
