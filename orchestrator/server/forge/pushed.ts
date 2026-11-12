import { join } from "node:path";
import type { OrchestratorContext } from "../app.js";
import { mirrorDir, syncRepo } from "../app.js";
import { gitConfigEnv, pinnedGitSettings } from "../connect.js";
import { gitAsync, gitAsyncMaybe, orchestratorCommitter } from "../git.js";
import { redactLine } from "../log.js";
import { localForge, providerFor, teamAssignment } from "../propose.js";
import type { RepoRecord } from "../store.js";
import type { Principal } from "../auth.js";
import { OrchestratorError } from "../errors.js";
import { recordEvent } from "../events.js";
import { FORGES, recognizeForge } from "../../shared/forge-def.js";
import type { HostedForge } from "../../shared/forge-def.js";
import { checkBranch, ForgeHttpError } from "./http.js";
import { ForgeRefusal, localRepoPath, readLocalDescription, safeRepoPath } from "./local.js";
import { createOwnCliForge, hasOwnCli, ownCliReady, ownCredentialConfig, OwnCliRefused } from "./own-cli.js";
import type { CliForge, CliRun } from "./own-cli.js";
import type { BranchUpdate, OpenedRequest, PushedBranch, RequestRecord } from "./types.js";
import { ownCliHere } from "./own-cli-here.js";
import { DEVICE_ENDPOINTS, personForgeToken } from "./device-sign-in.js";
import { DRIVERS } from "./registry.js";

/** The CLI a person signs in to each forge with, as the request's page names it. */
const OWN_CLI: Record<HostedForge, string> = { github: "gh", gitlab: "glab", gitea: "tea" };

/** A request opened on a forge for a pushed branch, or the forge's page that opens it and why nothing here did. */
export type OriginRequest = { opened: OpenedRequest } | { createUrl: string; reason: string };

/**
 * The request for a pushed branch. A repository read by path has its own, on the local forge; the
 * GitLab or GitHub its clone's origin is gets one only when the person presses for it. A repository
 * on a forge has its request there, or the forge's page that opens it.
 */
export type PushedRequest = { opened: OpenedRequest } | { createUrl: string; reason: string };

/**
 * The request for a branch a runner on the person's machine pushed. A repository read by path
 * records it on the local forge; one on GitLab or GitHub has it opened by the person's own
 * signed-in gh or glab. Where neither is there, the forge's own page that opens it comes back,
 * filled in, for the person to press: the branch is theirs and stays as it was pushed.
 */
export async function requestForPushedBranch(ctx: OrchestratorContext, repo: RepoRecord, pushed: PushedBranch, run?: CliRun): Promise<PushedRequest> {
  // Nothing leaves the machine at a task's end: a branch of a repository read by path reaches its origin only from originRequest, which a person presses.
  if (localRepoPath(repo.url)) return { opened: await localForge(ctx).openForBranch!(repo, pushed) };
  const config = await ctx.store.getForgeConfig(repo.tenant, repo.id);
  if (!config) throw new ForgeRefusal(`${repo.name} has nowhere to open a request; an owner or an admin connects it again under Projects with its GitLab or GitHub address`);
  let reason = `the orchestrator has no ${OWN_CLI[config.kind]} sign-in to open the request on ${FORGES[config.kind].label}`;
  const provider = await providerFor(ctx, repo);
  if (provider?.openForBranch) {
    try {
      return { opened: await provider.openForBranch(repo, pushed) };
    } catch (err) {
      // The branch is on the forge already, so a request the forge refuses is one the person can still open there.
      if (!(err instanceof OwnCliRefused || err instanceof ForgeHttpError)) throw err;
      reason = err.message;
    }
  }
  const target = ((await gitAsyncMaybe(["symbolic-ref", "--short", "HEAD"], mirrorDir(ctx, repo.id))) ?? "").trim() || "main";
  return { createUrl: FORGES[config.kind].newRequestUrl(new URL(repo.url).origin, config.project, pushed.branch, target), reason };
}

/** A clone's origin as the orchestrator reaches it: its forge's web address and the project's path, never the user or token it was written with. */
export function originOf(remote: string): { web: string; host: string; project: string; overHttp: boolean } | null {
  const scp = /^(?:ssh:\/\/)?[^@/\s]+@([^:/\s]+)(?::\d+)?[:/]([^\s]+?)(?:\.git)?\/?$/.exec(remote);
  if (scp && !/^https?:/i.test(remote)) return { web: `https://${scp[1]}`, host: scp[1]!, project: scp[2]!, overHttp: false };
  const url = URL.canParse(remote) ? new URL(remote) : null;
  if (!url || (url.protocol !== "https:" && url.protocol !== "http:")) return null;
  const project = url.pathname.replace(/^\/+|\/+$/g, "").replace(/\.git$/, "");
  return { web: url.origin, host: url.host, project, overHttp: true };
}

/** The GitLab or GitHub a remote is on, as a screen names the request it opens there; null for any other remote. */
export function remoteForge(ctx: Pick<OrchestratorContext, "forgeApps">, remote: string): "gitlab" | "github" | null {
  const at = originOf(remote);
  const ownGitLab = ctx.forgeApps?.gitlab ? [new URL(ctx.forgeApps.gitlab.webUrl).hostname] : [];
  const kind = at && at.project.split("/").length >= 2 ? recognizeForge(`${at.web}/`, { gitlab: ownGitLab }) : null;
  return kind === "gitlab" || kind === "github" ? kind : null;
}

/** The forge a path repository's clone has as its origin, when the person's own CLI opens requests there; null otherwise. */
async function originForge(ctx: OrchestratorContext, path: string): Promise<{ kind: CliForge; at: { web: string; host: string; project: string; overHttp: boolean } } | null> {
  const remote = (await gitAsyncMaybe(["remote", "get-url", "origin"], path))?.trim();
  const at = remote ? originOf(remote) : null;
  const ownGitLab = ctx.forgeApps?.gitlab ? [new URL(ctx.forgeApps.gitlab.webUrl).hostname] : [];
  const kind = at ? recognizeForge(`${at.web}/`, { gitlab: ownGitLab }) : null;
  return at && at.project.split("/").length >= 2 && hasOwnCli(kind) ? { kind, at } : null;
}

/**
 * The request on the forge a path repository's clone has as its origin, in local mode alone, when
 * the person asks for it: the branch pushed there by git with the person's own gh or glab sign-in,
 * held to the address judged for the forge as a fetch is, and the request opened by that CLI. Null
 * when the origin is no forge with a CLI. Nothing here takes back the local request or the branch.
 */
export async function originRequest(ctx: OrchestratorContext, path: string, repo: RepoRecord, pushed: PushedBranch, run?: CliRun): Promise<OriginRequest | null> {
  if (!(await ownCliHere(ctx))) return null;
  const origin = await originForge(ctx, path);
  if (!origin) return null;
  const { kind, at } = origin;
  const label = FORGES[kind].label;
  const target = ((await gitAsyncMaybe(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], path)) ?? "").trim().replace(/^origin\//, "") || "main";
  const page = (reason: string): OriginRequest => ({ createUrl: FORGES[kind].newRequestUrl(at.web, at.project, pushed.branch, target), reason });
  if (!at.overHttp) return page(`the clone's origin on ${at.host} is reached over ssh, which the orchestrator does not push to; push it with \`git push origin ${pushed.branch}\`, then open it there`);
  const url = new URL(`${at.web}/${at.project}.git`);
  try {
    await ownCliReady(kind, at.host, run);
    const pinned = await pinnedGitSettings(ctx, url).catch((err: Error) => {
      throw new OwnCliRefused(err.message);
    });
    const env = gitConfigEnv(url, [...pinned, ...ownCredentialConfig(kind)]);
    // No force: a branch of that name already on the forge makes git refuse rather than lose it.
    await gitAsync(["push", "--porcelain", url.href, `refs/heads/${pushed.branch}:refs/heads/${pushed.branch}`], path, undefined, undefined, { env }).catch((err: Error & { stderr?: string }) => {
      throw new OwnCliRefused(`git did not push ${pushed.branch} to ${label}: ${redactLine((err.stderr || err.message).replace(/\p{C}+/gu, " ").trim().slice(0, 300))}; push it with \`git push origin ${pushed.branch}\`, then open it there`);
    });
    const forge = createOwnCliForge({ repoId: repo.id, kind, apiUrl: FORGES[kind].apiUrlFor(new URL(at.web)), project: at.project }, join(ctx.dataDir, "work"), () => path, async () => env, run);
    return { opened: await forge.openForBranch!({ ...repo, url: url.href }, { ...pushed, target }) };
  } catch (err) {
    if (err instanceof OwnCliRefused || err instanceof ForgeRefusal) return page(err.message);
    throw err;
  }
}

/**
 * The same push and request with the token the person signed in with through the orchestrator's own
 * application (device-sign-in.ts), where their own CLI is not used here: only on the forge's public
 * host and over https, git held to the address judged as a fetch is, the token sent as git's
 * header for that origin alone and as the REST call's own. The caller has made sure the person
 * pressing is the one who started the task and the one the token belongs to.
 */
async function originRequestAsPerson(ctx: OrchestratorContext, path: string, repo: RepoRecord, pushed: PushedBranch, token: string, send: typeof fetch = fetch): Promise<OriginRequest | null> {
  const origin = await originForge(ctx, path);
  if (!origin || (origin.kind !== "github" && origin.kind !== "gitlab")) return null;
  const kind = origin.kind;
  const { at } = origin;
  if (at.host !== DEVICE_ENDPOINTS[kind].host) return null;
  const target = ((await gitAsyncMaybe(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], path)) ?? "").trim().replace(/^origin\//, "") || "main";
  const page = (reason: string): OriginRequest => ({ createUrl: FORGES[kind].newRequestUrl(at.web, at.project, pushed.branch, target), reason });
  if (!at.overHttp) return page(`the clone's origin on ${at.host} is reached over ssh, which the orchestrator does not push to; push it with \`git push origin ${pushed.branch}\`, then open it there`);
  const url = new URL(`${at.web}/${at.project}.git`);
  try {
    const pinned = await pinnedGitSettings(ctx, url).catch((err: Error) => {
      throw new ForgeRefusal(err.message);
    });
    const header = `Authorization: Basic ${Buffer.from(`${FORGES[kind].gitUser}:${token}`).toString("base64")}`;
    const env = gitConfigEnv(url, [...pinned, [`http.${url.origin}/.extraHeader`, header]]);
    // No force: a branch of that name already on the forge makes git refuse rather than lose it.
    await gitAsync(["push", "--porcelain", url.href, `refs/heads/${pushed.branch}:refs/heads/${pushed.branch}`], path, undefined, undefined, { env }).catch((err: Error & { stderr?: string }) => {
      throw new ForgeRefusal(`git did not push ${pushed.branch} to ${FORGES[kind].label}: ${redactLine((err.stderr || err.message).replace(/\p{C}+/gu, " ").trim().slice(0, 300))}`);
    });
    const forge = DRIVERS[kind].provider({ repoId: repo.id, kind, apiUrl: FORGES[kind].apiUrlFor(new URL(at.web)), project: at.project }, token, send, true);
    return { opened: await forge.openForBranch!({ ...repo, url: url.href }, { ...pushed, target }) };
  } catch (err) {
    if (err instanceof ForgeRefusal || err instanceof ForgeHttpError) return page(err.message);
    throw err;
  }
}

const onForgeKey = (repoId: string, number: number) => `request.on-forge.${repoId}.${number}`;

/** Whether a path repository's request opens on its clone's forge when the person presses for it, and where it opened once pressed. */
export interface OnForge {
  forge: CliForge | null;
  url: string | null;
  number: number | null;
}

/** The request a press opened on the forge, as the screen names it: its number there and its address. */
export interface OnForgeRequest {
  number: number;
  url: string;
}

/** A press that opened nothing on the forge: why, and the forge's own page that opens it, filled in, when there is one. */
export class OnForgeRefused extends OrchestratorError {
  constructor(code: string, message: string, status: 400 | 409, readonly createUrl?: string) {
    super(code, message, status);
  }
}

const keptOnForge = async (ctx: OrchestratorContext, repo: RepoRecord, number: number): Promise<OnForgeRequest | null> => {
  const kept = await ctx.store.getSetting(ctx.tenant, onForgeKey(repo.id, number));
  return kept ? (JSON.parse(kept) as OnForgeRequest) : null;
};

export async function requestOnForge(ctx: OrchestratorContext, repo: RepoRecord, number: number, user?: Pick<Principal, "id" | "email">): Promise<OnForge> {
  const path = localRepoPath(repo.url);
  const origin = path ? await originForge(ctx, path) : null;
  const request = user ? await ctx.store.getRequest(ctx.tenant, repo.id, number) : null;
  // Offered with the person's own CLI here, or with the sign-in of the person who started the task, to them alone.
  const own = origin ? await ownCliHere(ctx) : false;
  const asPerson = !own && origin && user && request && request.createdBy === user.email && (origin.kind === "github" || origin.kind === "gitlab") && origin.at.host === DEVICE_ENDPOINTS[origin.kind].host && (await personForgeToken(ctx, user.id, origin.kind));
  const forge = own || asPerson ? (origin?.kind ?? null) : null;
  const opened = await keptOnForge(ctx, repo, number);
  return { forge, url: opened?.url ?? null, number: opened?.number ?? null };
}

/**
 * Opens a path repository's request on its clone's GitLab or GitHub because the person pressed for
 * it: the branch, as the orchestrator checked it, is pushed with their own CLI and opened there. A
 * second press answers the first one's address and pushes nothing again.
 */
export async function openRequestOnForge(ctx: OrchestratorContext, repo: RepoRecord, request: RequestRecord, user: Principal, run?: CliRun, send: typeof fetch = fetch): Promise<OnForgeRequest> {
  const kept = await keptOnForge(ctx, repo, request.number);
  if (kept) return kept;
  const path = localRepoPath(repo.url);
  if (!path || request.provider !== "local") throw new OnForgeRefused("no-origin", `${repo.name} is not read by path, so its request is already on its forge`, 400);
  if (request.status !== "open") throw new OnForgeRefused("not-open", `request #${request.number} is ${request.status}; only an open request opens on its forge`, 409);
  const own = await ownCliHere(ctx);
  // Without the person's own CLI here, only the task's own starter pushes, and only with the sign-in that is theirs.
  const origin = own ? null : await originForge(ctx, path);
  const token = !own && origin && (origin.kind === "github" || origin.kind === "gitlab") && request.createdBy === user.email ? await personForgeToken(ctx, user.id, origin.kind) : null;
  if (!own && !token) throw new OnForgeRefused("not-one-person", request.createdBy === user.email ? "sign in to GitHub or GitLab on its card first; your own gh or glab is not used on an orchestrator more than one person reaches" : "only the person who started the task opens its request on the forge", 409);
  // Only what the orchestrator checked leaves the machine: a branch moved since is read again first.
  const head = (await gitAsyncMaybe(["rev-parse", "--verify", "--quiet", `refs/heads/${request.branch}^{commit}`], path))?.trim();
  const base = head && head === (request.checkedHead ?? request.headSha) ? (await gitAsyncMaybe(["merge-base", "HEAD", head], path))?.trim() : null;
  if (!base) throw new OnForgeRefused("moved", `${request.branch} moved since the orchestrator checked it; read the request again`, 409);
  const pushed = { title: request.title, body: (await readLocalDescription(repo, request.branch)) ?? "", branch: request.branch, baseSha: base, assignment: await teamAssignment(ctx, repo, user) };
  const answer = token ? await originRequestAsPerson(ctx, path, repo, pushed, token, send) : await originRequest(ctx, path, repo, pushed, run);
  if (!answer) throw new OnForgeRefused("no-origin", `${repo.name} has no origin on GitLab or GitHub to open its request on`, 400);
  if (!("opened" in answer)) throw new OnForgeRefused("not-opened", answer.reason, 409, answer.createUrl);
  const opened = { number: answer.opened.number, url: answer.opened.url };
  await ctx.store.setSetting(ctx.tenant, onForgeKey(repo.id, request.number), JSON.stringify(opened));
  await recordEvent(ctx, user, "request.opened", { repoId: repo.id, subject: `request:${request.number}`, detail: `"${request.title}" on ${request.branch}, pushed to its origin and opened there as #${opened.number} as its person pressed` });
  return opened;
}

/**
 * A new commit on an open request's branch, on top of the head it was prepared on, through the
 * forge the repository is on: the local forge's branch, the forge's REST API with the
 * orchestrator's access, or a push with the person's own gh or glab sign-in. A branch that moved
 * meanwhile is refused (ForgeRefusal) and keeps what moved it. `held`, for a task a runner leases,
 * is asked first: a runner that lost its task changes nothing.
 */
export async function updateRequestBranch(ctx: OrchestratorContext, repo: RepoRecord, branch: string, update: BranchUpdate, held?: () => Promise<boolean>): Promise<{ headSha: string }> {
  if (held && !(await held())) throw new ForgeRefusal("the runner no longer holds the task, so its branch is not updated");
  const provider = await providerFor(ctx, repo);
  if (!provider?.updateBranch) throw new ForgeRefusal(`the orchestrator has no access to ${repo.name}'s forge to update ${branch}`);
  return provider.updateBranch(repo, branch, update);
}


export type DropRefusal = { refused: string; code: "moved" | "not-on-branch" | "refused" };

const SHA = /^[0-9a-f]{40}$/;

/**
 * One file taken out of an open request: a single commit on its branch, by the orchestrator, that
 * puts the file back as the task's base held it, or removes it where the base had none. The file
 * is compared at the base and at the branch's head first, so a path the branch does not change gets
 * no commit, on any forge. A branch that moved since `expectedHead` is refused, never forced.
 */
export async function dropFromRequest(ctx: OrchestratorContext, repo: RepoRecord, drop: { branch: string; path: string; baseSha: string; expectedHead: string }): Promise<{ head: string } | DropRefusal> {
  const { branch, path, baseSha, expectedHead } = drop;
  const refused = (why: string, code: DropRefusal["code"] = "refused"): DropRefusal => ({ refused: why, code });
  try {
    safeRepoPath("/repository", path);
  } catch {
    return refused(`${JSON.stringify(path)} is not a path inside the repository`);
  }
  // A folder is named .git in any case on a file system that ignores case, as macOS's does.
  if (path.split("/").some((part) => part.toLowerCase() === ".git")) return refused(`${JSON.stringify(path)} is not a path inside the repository`);
  if (!SHA.test(baseSha) || !SHA.test(expectedHead)) return refused("the task's base and the request's head are full commit ids");
  try {
    checkBranch(branch);
  } catch (err) {
    return refused((err as Error).message);
  }
  const own = localRepoPath(repo.url);
  const copy = own ?? mirrorDir(ctx, repo.id);
  const has = async (sha: string) => (await gitAsyncMaybe(["cat-file", "-e", `${sha}^{commit}`], copy)) !== null;
  // A repository read by path holds the branch itself, so a branch that moved is told before anything is compared.
  if (own) {
    const tip = (await gitAsyncMaybe(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}^{commit}`], own))?.trim();
    if (!tip) return refused(`${branch} is not in ${repo.name}; read the request again`);
    if (tip !== expectedHead) return refused(`${branch} moved since it was read; read the request again`, "moved");
  }
  // The request's head comes into the orchestrator's copy with a sync; one is asked for when it is not there yet.
  if (!own && !(await has(expectedHead))) await syncRepo(ctx, repo.id);
  if (!(await has(baseSha))) return refused(`the task's base is not in the orchestrator's copy of ${repo.name}`);
  if (!(await has(expectedHead))) return refused(`${branch} moved since it was read; read the request again`, "moved");
  const entry = async (sha: string) => (await gitAsyncMaybe(["ls-tree", sha, "--", path], copy))?.trim() || null;
  const [atBase, atHead] = await Promise.all([entry(baseSha), entry(expectedHead)]);
  if (atBase === atHead) return refused(`${branch} does not change ${path}`, "not-on-branch");
  const [mode, type] = (atBase ?? "").split(/\s+/);
  if (atBase && (type !== "blob" || mode === "120000")) return refused(`${path} is ${type === "tree" ? "a folder" : "a link"} at the task's base; take it out on the forge`);
  const content = atBase ? await gitAsync(["show", `${baseSha}:${path}`], copy) : null;
  // A file kept as text: one whose bytes are no UTF-8 text would not come back as it was.
  if (content !== null && (content.includes("\u0000") || content.includes("\uFFFD"))) return refused(`${path} is not text; take it out on the forge`);
  try {
    const { headSha } = await updateRequestBranch(ctx, repo, branch, { files: [{ path, content }], title: `Drop ${path} from the request`, author: orchestratorCommitter(), expectedHead });
    return { head: headSha };
  } catch (err) {
    if (!(err instanceof ForgeRefusal)) throw err;
    if (/moved since/.test(err.message)) return refused(err.message, "moved");
    if (/does not alter the repository/.test(err.message)) return refused(`${branch} does not change ${path}`, "not-on-branch");
    return refused(err.message);
  }
}
