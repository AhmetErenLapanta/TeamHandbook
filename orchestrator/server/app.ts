import { rm, stat } from "node:fs/promises";
import type { FolderCandidate } from "./tasks/routing.js";
import { taskShareRoutes } from "./task-shares.js";
import { taskSuggestionRoutes } from "./task-suggestion-routes.js";
import { machineRoutes, runnerOpenRoutes } from "./machines.js";
import { runnerRoutes } from "./runner-routes.js";
import { isGitFolder, localFolderRoutes, machineFolderOf, shownProjects } from "./projects.js";
import { machineFolderRoutes } from "./machine-folders.js";
import { updateRoutes } from "./update-routes.js";
import { taskToolRoutes } from "./task-tools.js";
import { lessonRoutes } from "./lessons.js";
import type { LessonPlace } from "./lessons.js";
import { taskBoardRoutes } from "./task-board.js";
import { skillOutcomeRoutes } from "./skill-outcomes.js";
import { teamRoutes } from "./team-routes.js";
import { projectRoutes } from "./project-routes.js";
import { verifyRoutes } from "./tasks/verify-routes.js";
import { projectGitRoutes } from "./forge/project-git-routes.js";
import { bodyLimit } from "hono/body-limit";
import { CALL_BYTES } from "../shared/runner-wire.js";
import { OrchestratorError, errorAnswer, errorCodes } from "./errors.js";
import { basename, join, relative } from "node:path";
import { Hono } from "hono";
import type { Context, MiddlewareHandler } from "hono";
import { accountRoutes, authRoutes } from "./accounts.js";
import { activityRoutes, seesTeam, usageBreakdown } from "./activity.js";
import { allowedHosts, authMode, canEditTeam, orchestratorAuth, hostGuard, manages, secureOrchestrator } from "./auth.js";
import { keyRoutes } from "./keys.js";
import { directoryRoutes } from "./directory.js";
import { domainRoutes } from "./domains.js";
import { taskSecretRoutes } from "./task-secrets.js";
import { scimAdminRoutes, scimRoutes } from "./scim.js";
import type { TxtResolver } from "./domains.js";
import { privacyRoutes } from "./privacy.js";
import { editRoutes } from "./editing.js";
import { inviteRoutes, joinRoutes } from "./invites.js";
import { policyRoutes } from "./policy-routes.js";
import { removalRoutes } from "./removal.js";
import { memberConfigRoutes } from "./member-config.js";
import { aiRequestRoutes } from "./ai-requests.js";
import { analyticsRoutes } from "./analytics.js";
import { organizationRoutes } from "./organization.js";
import { registryRoutes } from "./mcp-registry.js";
import { metrics } from "./metrics.js";
import { proposedBranch, teamNaming } from "./branches.js";
import type { OrchestratorEnv, Principal } from "./auth.js";
import type { OidcClient } from "./oidc.js";
import { localRepoPath, readLocalDescription } from "./forge/local.js";
import type { RequestStatus } from "./forge/types.js";
import { eachAtMost, gitAsync, gitAsyncMaybe, oneAtATime, RepositoryGone, stoppedFromOutside } from "./git.js";
import { skillOverlaps } from "./overlaps.js";
import { readHistory, readInventory, readTeamRecordAsync, syncMirror } from "./inventory.js";
import { eventRoutes, recordEvent } from "./events.js";
import { joinMessage, scaffoldRefresh } from "./setup.js";
import { forgeTokenName, inRequestTurn, propose, USAGE_REQUESTS, usageChange } from "./propose.js";
import type { UsageAction } from "./propose.js";
import { ChangeRefused, MCP_FILE, prepareBuilt } from "./changes.js";
import { commitMessagePrefix, commitSubject, declaredServers } from "./plugin.js";
import { ensureIngestId, ingestUrl, newIngestId, usageAddressFinding, usageRoutes } from "./usage.js";
import type { RepoRecord, RequestCursor, Store } from "./store.js";
import { taskRoutes } from "./tasks/routes.js";
import { reviewRoutes } from "./tasks/review.js";
import { triggerRoutes } from "./tasks/triggers.js";
import type { RepoJobs } from "./tasks/triggers.js";
import type { TaskRunner } from "./tasks/runner.js";
import type { RunnerService } from "./runner-service.js";
import { maskSecrets } from "./vault.js";
import type { Vault } from "./vault.js";
import type { Audit } from "./integrations/audit.js";
import type { ApiKeyResolver } from "./integrations/keys.js";
import { noteHealth } from "./integrations/health.js";
import { personalMcpRoutes } from "./integrations/personal-mcp.js";
import { teamMcpRoutes } from "./integrations/team-mcp.js";
import { issuePreviewRoutes } from "./integrations/issue-preview.js";
import { WORK_DEPS, workRoutes } from "./work/routes.js";
import { integrationRoutes } from "./integrations/routes.js";
import { mcpRoutes } from "./mcp/server.js";
import { orchestratorRoutes } from "./tasks/orchestrator.js";
import { connectRoutes, gitAccess, removeAddedRepo } from "./connect.js";
import type { AddedRepo } from "./connect.js";
import type { Resolver } from "./tasks/egress.js";
import { forgeConnectRoutes } from "./forge/oauth-routes.js";
import { forgeReadRoutes } from "./forge/read-routes.js";
import { onForgeRoutes } from "./forge/on-forge-routes.js";
import { handbookRoutes } from "./forge/handbook-routes.js";
import { requestReader, seesRequest } from "./forge/request-access.js";
import { forgeHostRoutes } from "./forge/hosts.js";
import { agentCreditRoutes } from "./forge/agent-credits.js";
import type { ForgeApps } from "./forge/oauth.js";
import type { OrchestratorMode } from "./mode.js";
import { attachmentDownloadRoutes, attachmentRoutes } from "./attachments.js";

export interface OrchestratorContext {
  store: Store;
  /** How the orchestrator runs; left out, self-hosted. */
  mode?: OrchestratorMode;
  dataDir: string;
  tenant: string;
  /** The address teammates' machines reach this orchestrator at; used in the usage endpoint a team file carries. */
  publicUrl?: string;
  /** The task runner; without one the orchestrator offers no tasks. */
  tasks?: TaskRunner;
  /** The folders a one-person orchestrator's person works in, the newest first: where a task with no project named is sent. */
  workFolders?: (user: Principal) => Promise<FolderCandidate[]>;
  /** Each repository's jobs and the secret its forge's comment deliveries are checked with. */
  jobs?: (repo: RepoRecord) => RepoJobs;
  /** The one-time code that lets the first admin of an empty tenant be created. */
  setupCode?: string;
  oidc?: OidcClient | null;
  /** Seals forge tokens; null when ORCHESTRATOR_SECRET_KEY is unset, and then none can be stored. */
  vault?: Vault | null;
  /** Host names the orchestrator answers to; null answers any. Left out, the auth mode decides. */
  allowedHosts?: string[] | null;
  /** Proxies whose X-Forwarded-For names the client a sign-in limit counts. */
  trustedProxies?: string[];
  /**
   * The repositories the configuration file lists at this start. One the orchestrator still holds
   * that the file no longer lists is kept, readable, and not synced. The orchestrator always sets
   * it, empty when no file is used; left out, as in a context a test builds, every repository
   * counts as listed.
   */
  configured?: ReadonlySet<string>;
  /** Each repository's `memberUrl` from the configuration file, for those that give one. */
  memberUrls?: ReadonlyMap<string, string>;
  /** Each repository's `testCommand` from the configuration file, which a task runs with no approval. */
  testCommands?: ReadonlyMap<string, string>;
  /** Where the web app shows this org, `/<tenant>/`; left out for the first org, shown at `/`. */
  webBase?: string;
  /** Writes one row of the event log; without it the orchestrator's MCP server runs nothing. */
  audit?: Audit;
  /** Who an API key belongs to; without it the orchestrator's MCP server lets nobody in. */
  apiKeys?: ApiKeyResolver | null;
  /** Looks up DNS TXT records when a domain is verified; left out, the system resolver. */
  resolveTxt?: TxtResolver;
  /** Lets a person's own MCP server, and its sign-in, be on this machine over http: the lab's stand-ins. */
  localMcp?: boolean;
  /** The MCP Registry servers are read from, from ORCHESTRATOR_MCP_REGISTRY_URL; left out, no registry is read. */
  mcpRegistry?: string | null;
  /** The repositories an owner or an admin connected from the screen, read at start and kept current as they change. */
  addedRepos?: Map<string, AddedRepo>;
  /** On a local orchestrator, writes the sign-in page a new one-time address after each sign-in, so another browser on this machine signs in from it too. */
  localSignedIn?: () => Promise<void>;
  /** The folder repositories read by path are connected under, from ORCHESTRATOR_LOCAL_REPOS_ROOT; left out, none are. */
  localReposRoot?: string | null;
  /** Where a task's lesson is written: the person's own queue on a local orchestrator, their machine on a team's. */
  lessons?: LessonPlace | null;
  /** Hosts (`host` or `host:port`) inside the orchestrator's network a repository connected from the screen is fetched from, by the operator's leave. */
  internalForgeHosts?: ReadonlySet<string>;
  /**
   * Set in local mode, where one person runs the orchestrator on their own machine: a forge on their
   * private network or this machine is reached as their git reaches it. Link-local addresses
   * stay out of reach in every mode.
   */
  privateNetworkForges?: boolean;
  /**
   * Set in local mode: a repository on GitLab or GitHub is connected with no token, its branches
   * pushed and its requests opened by the person's own signed-in gh or glab, which the
   * orchestrator asks nothing of but to do it.
   */
  ownForgeCli?: boolean;
  /** Resolves a forge's host before a fetch from it; left out, the system resolver. */
  resolveHost?: Resolver;
  /** The GitLab OAuth application and GitHub App the operator registered; left out, repositories are connected with tokens alone. */
  forgeApps?: ForgeApps;
  /** The calls a runner makes, its own on a local orchestrator and a machine's over HTTP; left out, no runner reaches this organization. */
  runnerService?: RunnerService;
  /** Aborted when the process begins to stop, so a waiting poll answers before it takes a lease. */
  closing?: AbortSignal;
}

export function inConfiguration(ctx: OrchestratorContext, id: string): boolean {
  return !ctx.configured || ctx.configured.has(id) || Boolean(ctx.addedRepos?.has(id));
}

/** The address teammates add the repository by, or null when the configuration gives none. */
export function memberUrl(ctx: OrchestratorContext, id: string): string | null {
  return ctx.memberUrls?.get(id) ?? ctx.addedRepos?.get(id)?.memberUrl ?? null;
}

/** A repository connected but not read yet: what to do about it, not only that it is so. */
export const NOT_READ_YET = "The orchestrator has not read this repository yet. Press Sync again on its page, or wait for the next read.";

export const NOT_CONFIGURED = "this repository is no longer in the orchestrator's configuration, so it is not synced or changed; put it back in ORCHESTRATOR_CONFIG, or disconnect it";

const ID = /^[a-z0-9][a-z0-9-]{0,62}$/;

export function mirrorDir(ctx: OrchestratorContext, id: string): string {
  return join(ctx.dataDir, "mirrors", ctx.tenant, `${id}.git`);
}

/**
 * Text with the user and password of every URL in it replaced: `scheme://***@host`. A
 * repository URL is kept whole in the store, because git needs it to fetch, and passes
 * through this on every way out of the orchestrator.
 */
export function maskUrl(text: string): string {
  return text.replace(/(\w+:\/\/)[^/@\s]+@/g, "$1***@");
}

/** A repository as the API shows it, to an admin as to anyone: its URL masked, and whether the configuration still lists it. */
export function publicRepo(ctx: OrchestratorContext, repo: RepoRecord): RepoRecord & { configured: boolean; kind: "skills" | "code"; skillsFrom: string | null; source: "file" | "orchestrator" } {
  // A code repository is a place tasks change, with no skills, scaffold or setup to show.
  const code = ctx.tasks?.codeTarget(repo) ?? null;
  return { ...repo, url: maskUrl(repo.url), error: repo.error === null ? null : maskUrl(repo.error), configured: inConfiguration(ctx, repo.id), kind: code ? "code" : "skills", skillsFrom: code?.skillsFrom ?? null, source: ctx.addedRepos?.has(repo.id) ? "orchestrator" : "file" };
}

/**
 * The first line git wrote, with any credential in a URL masked. A sync failure is shown
 * to whoever opens the orchestrator, and a URL like https://user:token@host is exactly what a
 * clone error repeats back.
 */
export function syncError(err: unknown): string {
  const stderr = (err as { stderr?: unknown })?.stderr;
  const text = typeof stderr === "string" && stderr.trim() ? stderr : String((err as Error)?.message ?? err);
  const line = text.split("\n").map((l) => l.trim()).find(Boolean) ?? "git failed";
  return maskUrl(line).slice(0, 300);
}

export async function syncRepo(ctx: OrchestratorContext, id: string): Promise<{ head: string } | { error: string }> {
  const repo = await ctx.store.getRepo(ctx.tenant, id);
  if (!repo) return { error: "unknown repository" };
  // Not fetched, so a URL taken out of the file - with the token it carried - is not used again;
  // the record keeps the last real sync's state.
  if (!inConfiguration(ctx, id)) return { error: NOT_CONFIGURED };
  // A folder that is no git repository is worked on in place and has no history to mirror; nothing
  // is recorded on it, so it never reads as broken. It is read again once it becomes one. A path
  // with nothing there is no such folder: its sync fails and says so.
  // A folder on a person's machine is read there, never here.
  if (machineFolderOf(repo.url)) return { error: ON_A_MACHINE };
  const path = localRepoPath(repo.url);
  if (path && (await stat(path).catch(() => null))?.isDirectory() && !(await isGitFolder(path))) return { error: FOLDER_WITHOUT_GIT };
  let result: { head: string } | { error: string };
  let access: Awaited<ReturnType<typeof gitAccess>> = null;
  try {
    access = await gitAccess(ctx, repo);
    result = { head: await syncMirror(repo.url, mirrorDir(ctx, id), access?.env) };
  } catch (err) {
    // A sync the orchestrator's own stop cut off read nothing: recorded, it would show a working repository as broken.
    if (stoppedFromOutside(err)) throw err;
    result = { error: maskSecrets(syncError(err), access?.secrets ?? []) };
  }
  await ctx.store.recordSync(ctx.tenant, id, result);
  if ("error" in result) metrics.syncFailed(ctx.tenant);
  await noteHealth(ctx, { kind: "sync", repoId: id }, "error" in result ? { ok: false, detail: result.error } : { ok: true });
  return result;
}

export interface RepoSummary {
  skills: number;
  mcpServers: number;
  commands: number;
  /** Requests the orchestrator opened on it that wait for a review. */
  waiting: number;
  /** The setup panel's worst finding: fine, something to look at, or something that stops teammates; null until the repository is read. */
  health: "fine" | "attention" | "problem" | null;
}

const summaries = new Map<string, { head: string; counts: Omit<RepoSummary, "waiting"> }>();

/** A repository's summary for the list, read once for each commit it is at. */
export async function repoSummary(ctx: OrchestratorContext, repo: RepoRecord, waiting: number): Promise<RepoSummary> {
  // A repository whose last sync failed shows what it held when it was last read, as a problem.
  if (repo.error) return { skills: 0, mcpServers: 0, commands: 0, ...summaries.get(mirrorDir(ctx, repo.id))?.counts, waiting, health: "problem" };
  if (!repo.head) return { skills: 0, mcpServers: 0, commands: 0, waiting, health: null };
  const mirror = mirrorDir(ctx, repo.id);
  let kept = summaries.get(mirror);
  if (kept?.head !== repo.head) {
    const read = await readInventory(mirror, repo.head).catch(() => null);
    if (!read) return { skills: 0, mcpServers: 0, commands: 0, waiting, health: "problem" };
    const worst = read.setup.some((f) => f.level === "problem") ? "problem" : read.setup.some((f) => f.level === "attention") ? "attention" : "fine";
    kept = { head: repo.head, counts: { skills: read.skills.length, mcpServers: read.mcpServers.length, commands: read.commands.length, health: worst } };
    summaries.set(mirror, kept);
  }
  return { ...kept.counts, waiting };
}

/** What a sync says of a project on a person's machine, which it leaves alone. */
export const ON_A_MACHINE = "this folder is on a person's machine; its tasks work in it there, with nothing to sync here";

/** What a sync says of a folder without git, which it leaves alone. */
export const FOLDER_WITHOUT_GIT = "this folder is not a git repository; its tasks work in it in place, with nothing to sync";

export const MIRROR_GONE = "the orchestrator's copy of this repository is missing; syncing the repository, or the orchestrator's next start, reads it again";
export const MIRROR_GONE_UNCONFIGURED = "the orchestrator's copy of this repository is missing, and it is not read again while the repository is out of the orchestrator's configuration";

export const REQUESTS_PER_PAGE = 50;
const REQUEST_STATUSES = ["open", "merged", "closed"] as const;

export class DisconnectRefused extends OrchestratorError {
  constructor(message: string) {
    super("disconnect-refused", message, 409);
  }
}

/**
 * Removes a repository the configuration no longer lists, for good: its mirror (whose git
 * config holds the URL and any token in it), its forge access and sealed token, and the
 * ingest id its team's usage endpoint carries. The team's own repository is never touched,
 * and the orchestrator's records of it - requests, tasks, skill-use counts, request numbers - stay
 * readable; connecting the same id again picks them up and keeps numbering after them.
 *
 * Refused while the file still lists it (the next start would connect it again), while a
 * request is open (nothing would merge or close it after), and while a task is queued or
 * running on it.
 */
export async function disconnectRepo(ctx: OrchestratorContext, repo: RepoRecord): Promise<void> {
  if (inConfiguration(ctx, repo.id)) throw new DisconnectRefused("remove it from ORCHESTRATOR_CONFIG first; a repository the file lists is connected again at the next start");
  const mirror = mirrorDir(ctx, repo.id);
  // In the repository's turn, from the checks to the last delete: a refresh that finds a
  // request reopened on its forge records it in the same turn, before the checks or after the
  // repository is gone, never in between where it would leave an open request nobody can close.
  await oneAtATime(mirror, async () => {
    const open = (await ctx.store.listRequests(ctx.tenant, repo.id)).filter((r) => r.status === "open").length;
    if (open) throw new DisconnectRefused(`it has ${open} open request${open === 1 ? "" : "s"}; merge or close ${open === 1 ? "it" : "them"} first (one on a forge is closed there and refreshed here)`);
    if ((await ctx.store.taskPage(ctx.tenant, { repoId: repo.id, statuses: ["queued", "running", "interrupted"] }, null, 1)).tasks.length) {
      throw new DisconnectRefused("a task is running on it; cancel the task first");
    }
    const forge = await ctx.store.getForgeConfig(ctx.tenant, repo.id);
    if (forge) await ctx.store.deleteSecret(ctx.tenant, forgeTokenName(forge));
    await ctx.store.deleteForgeConfig(ctx.tenant, repo.id);
    await rm(mirror, { recursive: true, force: true });
    await ctx.store.removeRepo(ctx.tenant, repo.id);
  });
}

/** A `next` this orchestrator handed out, or undefined for anything else. */
function readCursor(text: string): RequestCursor | undefined {
  try {
    const { createdAt, repoId, number } = JSON.parse(Buffer.from(text, "base64url").toString("utf8")) as Partial<RequestCursor>;
    if (typeof createdAt === "string" && createdAt.length <= 40 && typeof repoId === "string" && ID.test(repoId) && Number.isInteger(number) && number! > 0) return { createdAt, repoId, number: number! };
  } catch {
    return undefined;
  }
  return undefined;
}

/** How many repositories a start syncs at once: enough to overlap their network waits, few enough not to crowd out the requests being served. */
export const SYNCS_AT_ONCE = 4;

/**
 * Syncs each repository, `atOnce` at a time, after the orchestrator has begun to serve: a start
 * with many repositories answers at once, and a repository not read yet says so until its
 * turn comes. A failure is recorded on its repository and the rest go on. Once `signal` is
 * aborted no further sync begins, so a stop waits only for the ones under way.
 */
export async function syncRepos(ctx: OrchestratorContext, ids: string[], signal?: AbortSignal, atOnce = SYNCS_AT_ONCE, sync = syncRepo): Promise<void> {
  await eachAtMost(ids, atOnce, (id) => sync(ctx, id).then(() => undefined, (err: Error) => console.error(`sync ${id}: ${err.message}`)), signal);
}

export function createApp(ctx: OrchestratorContext, auth: MiddlewareHandler<OrchestratorEnv> = orchestratorAuth(ctx.store, ctx.tenant, authMode(), secureOrchestrator(ctx.publicUrl))): Hono<OrchestratorEnv> {
  const app = new Hono<OrchestratorEnv>();
  // A read whose browser went away ends with git's abort; that is the request being let go,
  // not a fault, and logging its stack would let any client fill the log. Anything else is.
  app.onError((err, c) => {
    if (c.req.raw.signal.aborted && (err as { name?: unknown }).name === "AbortError") return new Response(null, { status: 499 });
    // A team repository is named by the path its configuration gave; the orchestrator's own copy
    // is not, since its folder means nothing to whoever reads the screen and a sync restores it.
    if (err instanceof OrchestratorError) return errorAnswer(c, err);
    if (err instanceof RepositoryGone) {
      console.error(err.message);
      const mirrors = join(ctx.dataDir, "mirrors", ctx.tenant);
      if (relative(mirrors, err.path).startsWith("..")) return c.json({ error: err.message }, 409);
      return c.json({ error: inConfiguration(ctx, basename(err.path, ".git")) ? MIRROR_GONE : MIRROR_GONE_UNCONFIGURED }, 409);
    }
    console.error(err);
    return c.text("Internal Server Error", 500);
  });
  app.use("/api/*", errorCodes());
  const hosts = ctx.allowedHosts === undefined ? allowedHosts(authMode()) : ctx.allowedHosts;
  if (hosts) app.use("*", hostGuard(hosts));

  // Liveness: the process answers, and nothing more to whoever asks. Whether it can serve, and
  // the release it runs, is /api/health/ready, which the org router answers.
  app.get("/api/health", (c) => c.json({ ok: true }));
  app.route("/", usageRoutes({ ...ctx, usage: ctx.store }));
  app.route("/", authRoutes(ctx, { ...(ctx.setupCode ? { setupCode: ctx.setupCode } : {}), oidc: ctx.oidc ?? null, trustedProxies: ctx.trustedProxies ?? [] }));
  app.route("/", mcpRoutes(ctx));
  const personalMcp = personalMcpRoutes(ctx);
  app.route("/", personalMcp.open);
  const forgeConnect = forgeConnectRoutes(ctx);
  app.route("/", forgeConnect.open);
  app.route("/", joinRoutes(ctx, ctx.trustedProxies ?? []));
  // Before the orchestrator's own sign-in: the directory calls with its SCIM token and nothing else.
  app.route("/", scimRoutes(ctx));
  // Before the session check: a forge delivers with its signature, not a signed-in person.
  if (ctx.tasks && ctx.jobs) app.route("/", triggerRoutes(ctx, ctx.tasks, ctx.jobs));
  // Before the session check: a task's agent calls with its task's token, never a person's session.
  if (ctx.tasks) app.route("/", orchestratorRoutes(ctx, ctx.tasks));
  // A signed attachment address carries its own credential and answers before the session check.
  app.route("/", attachmentDownloadRoutes(ctx));
  // A machine's body is read for its signature before anything else proves who sent it, so its
  // size is held first: a call past CALL_BYTES is refused unread.
  app.use("/api/runner/*", bodyLimit({ maxSize: CALL_BYTES, onError: (c) => c.json({ error: `a runner's call carries at most ${CALL_BYTES} bytes` }, 413) }));
  // A machine says who it talks to and claims its code before it holds any credential.
  app.route("/", runnerOpenRoutes(ctx));
  // A machine's calls carry its token and signature, never a person's session.
  app.route("/", runnerRoutes(ctx));
  app.use("/api/*", auth);
  app.route("/", machineRoutes(ctx));
  app.route("/", localFolderRoutes(ctx));
  app.route("/", machineFolderRoutes(ctx));
  app.route("/", updateRoutes(ctx));
  app.route("/", taskToolRoutes(ctx));
  app.route("/", lessonRoutes(ctx, ctx.lessons ?? null));
  // Before the task routes, whose /api/tasks/:id would read "board" as a task's id.
  app.route("/", taskBoardRoutes(ctx));
  app.route("/", skillOutcomeRoutes(ctx));
  app.route("/", teamRoutes(ctx));
  app.route("/", projectRoutes(ctx));
  app.route("/", verifyRoutes(ctx));
  app.route("/", projectGitRoutes(ctx));
  app.route("/", accountRoutes(ctx));
  app.route("/", integrationRoutes(ctx));
  app.route("/", personalMcp.signedIn);
  app.route("/", forgeConnect.signedIn);
  app.route("/", forgeReadRoutes(ctx));
  app.route("/", onForgeRoutes(ctx));
  app.route("/", handbookRoutes(ctx));
  app.route("/", forgeHostRoutes(ctx));
  app.route("/", agentCreditRoutes(ctx));
  app.route("/", teamMcpRoutes(ctx));
  app.route("/", issuePreviewRoutes(ctx));
  app.route("/", workRoutes(ctx));
  app.route("/", inviteRoutes(ctx));
  app.route("/", keyRoutes(ctx));
  app.route("/", directoryRoutes(ctx));
  app.route("/", domainRoutes(ctx, ctx.resolveTxt));
  app.route("/", taskSecretRoutes(ctx));
  app.route("/", attachmentRoutes(ctx));
  app.route("/", taskShareRoutes(ctx));
  app.route("/", connectRoutes(ctx));
  app.route("/", scimAdminRoutes(ctx));
  app.route("/", privacyRoutes(ctx));
  app.route("/", editRoutes(ctx));
  app.route("/", activityRoutes(ctx));
  app.route("/", policyRoutes(ctx));
  app.route("/", removalRoutes(ctx));
  app.route("/", memberConfigRoutes(ctx));
  app.route("/", analyticsRoutes(ctx));
  app.route("/", aiRequestRoutes(ctx));
  app.route("/", organizationRoutes(ctx));
  app.route("/", registryRoutes(ctx));
  app.route("/", eventRoutes(ctx));

  // Each repository with what a lead reads it for: how much it shares, what waits in it, and
  // whether its setup asks for anything.
  app.get("/api/repos", async (c) => {
    const repos = await shownProjects(ctx, c.get("user"), await ctx.store.listRepos(ctx.tenant));
    const open = new Map<string, number>();
    for (const r of await ctx.store.listRequests(ctx.tenant)) if (r.status === "open") open.set(r.repoId, (open.get(r.repoId) ?? 0) + 1);
    return c.json({ repos: await Promise.all(repos.map(async (r) => ({ ...publicRepo(ctx, r), summary: await repoSummary(ctx, r, open.get(r.id) ?? 0) }))) });
  });

  app.post("/api/repos/:id/sync", async (c) => {
    const id = c.req.param("id");
    const repo = ID.test(id) ? await ctx.store.getRepo(ctx.tenant, id) : null;
    if (!repo) return c.json({ error: "unknown repository" }, 404);
    // Fetching the repository again changes what the orchestrator holds and reaches its remote;
    // it takes the same rights as every other write.
    if (!canEditTeam(c.get("user"), repo.team)) return c.json({ error: `only an admin or an owner of ${repo.team} can sync this repository` }, 403);
    if (!inConfiguration(ctx, id)) return c.json({ error: NOT_CONFIGURED }, 409);
    const result = await syncRepo(ctx, id);
    return "error" in result ? c.json(result, 502) : c.json(result);
  });

  app.get("/api/repos/:id/inventory", async (c) => {
    const id = c.req.param("id");
    const repo = ID.test(id) ? await ctx.store.getRepo(ctx.tenant, id) : null;
    if (!repo) return c.json({ error: "unknown repository" }, 404);
    if (!repo.head) return c.json({ error: repo.error ? maskUrl(repo.error) : NOT_READ_YET }, 409);
    const read = await readInventory(mirrorDir(ctx, id), "HEAD", c.req.raw.signal);
    // Started here so the answer is usually ready by the time the page asks for it.
    void skillOverlaps(mirrorDir(ctx, id), read.head, async () => read.skills).catch(() => undefined);
    const usage = usageAddressFinding(read.team?.usageEndpoint, ctx.publicUrl, await ctx.store.ingestId(ctx.tenant, id), id);
    // Whether a task gets each server is the task runner's rule, the one its setup and its
    // readiness check apply; an orchestrator that runs no tasks says nothing about it.
    const inTasks = ctx.tasks ? ctx.tasks.mcpInTasks(repo, declaredServers(await gitAsyncMaybe(["show", `${read.head}:${MCP_FILE}`], mirrorDir(ctx, id)))) : null;
    const inventory = {
      ...read,
      setup: usage ? [...read.setup, usage] : read.setup,
      mcpServers: inTasks ? read.mcpServers.map((m) => (inTasks[m.name] ? { ...m, inTasks: inTasks[m.name] } : m)) : read.mcpServers,
    };
    return c.json({
      repo: publicRepo(ctx, repo),
      inventory,
      join: joinMessage(memberUrl(ctx, id), inventory.plugin, inventory.marketplace),
      refresh: scaffoldRefresh({ tasks: Boolean(ctx.tasks), configured: inConfiguration(ctx, id), memberUrl: memberUrl(ctx, id) }),
    });
  });

  // Which skills answer the same requests, apart from the inventory: worked out once for each
  // head and in slices, so the inventory and every other request answer while it runs.
  app.get("/api/repos/:id/overlaps", async (c) => {
    const id = c.req.param("id");
    const repo = ID.test(id) ? await ctx.store.getRepo(ctx.tenant, id) : null;
    if (!repo) return c.json({ error: "unknown repository" }, 404);
    if (!repo.head) return c.json({ error: NOT_READ_YET }, 409);
    const mirror = mirrorDir(ctx, id);
    const head = (await gitAsync(["rev-parse", "HEAD"], mirror)).trim();
    return c.json({ head, overlaps: await skillOverlaps(mirror, head, async () => (await readInventory(mirror, head)).skills) });
  });

  app.get("/api/repos/:id/history", async (c) => {
    const id = c.req.param("id");
    const repo = ID.test(id) ? await ctx.store.getRepo(ctx.tenant, id) : null;
    if (!repo?.head) return c.json({ error: "unknown repository" }, 404);
    const path = c.req.query("path");
    // A path is handed to git after "--", so it can never be read as an option; it still
    // has to be a plain relative path inside the repository.
    if (path !== undefined && (path.startsWith("/") || path.split("/").includes(".."))) {
      return c.json({ error: "invalid path" }, 400);
    }
    return c.json({ history: await readHistory(mirrorDir(ctx, id), path, 50, c.req.raw.signal) });
  });

  app.get("/api/usage", async (c) => {
    const days = Math.min(Math.max(Number(c.req.query("days") ?? 30) || 30, 1), 365);
    const since = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 13);
    const asked = c.req.query("repo");
    const repoId = asked && ID.test(asked) ? asked : undefined;
    // The same rule as Activity's usage: only the teams this person sees, under the privacy setting.
    const repos = await ctx.store.listRepos(ctx.tenant);
    const seen = await usageBreakdown(ctx, c.get("user"), repos);
    const teamOf = new Map(repos.map((r) => [r.id, r.team]));
    const usage = (await ctx.store.usage(ctx.tenant, since, repoId)).filter((u) => seesTeam(seen, teamOf.get(u.repoId) ?? u.repoId));
    return c.json({ days, usage, shown: repoId ? seesTeam(seen, teamOf.get(repoId) ?? repoId) : seen !== null });
  });

  // Two steps, like every other change: the orchestrator proposes the commit message, the person
  // confirms or rewrites it, and only then is the request opened.
  const usageRepo = async (c: Context<OrchestratorEnv>): Promise<{ repo: RepoRecord; action: UsageAction; body: Record<string, unknown> } | Response> => {
    const id = c.req.param("id") ?? "";
    const repo = ID.test(id) ? await ctx.store.getRepo(ctx.tenant, id) : null;
    if (!repo) return c.json({ error: "unknown repository" }, 404);
    if (!canEditTeam(c.get("user"), repo.team)) return c.json({ error: "only an admin or this team's owner can propose this" }, 403);
    if (!inConfiguration(ctx, id)) return c.json({ error: NOT_CONFIGURED }, 409);
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const action = body.action ?? "ask";
    if (action !== "ask" && action !== "rotate" && action !== "stop") return c.json({ error: "a usage request asks, gives a new address, or stops" }, 400);
    // Stopping writes no address, so it is the one usage request an orchestrator without a public address can open.
    if (!ctx.publicUrl && action !== "stop") return c.json({ error: "set ORCHESTRATOR_PUBLIC_URL to the address teammates reach this orchestrator at" }, 409);
    if (!repo.head) return c.json({ error: "this repository has not been read yet" }, 409);
    if (action !== "ask" && !(await readTeamRecordAsync(mirrorDir(ctx, id), repo.head))?.usageEndpoint) return c.json({ error: "this team is not asked to report skill use" }, 409);
    return { repo, action, body };
  };

  app.post("/api/repos/:id/usage/proposal", async (c) => {
    const asked = await usageRepo(c);
    if (asked instanceof Response) return asked;
    const naming = await teamNaming(mirrorDir(ctx, asked.repo.id), asked.repo.head!);
    const { proposal, topic } = USAGE_REQUESTS[asked.action];
    return c.json({ proposal: commitSubject(commitMessagePrefix(naming.commitPrefix), proposal), branch: proposedBranch(topic, naming) });
  });

  app.post("/api/repos/:id/usage/propose", async (c) => {
    const asked = await usageRepo(c);
    if (asked instanceof Response) return asked;
    const { repo, action, body } = asked;
    if (body.baseSha !== repo.head) return c.json({ error: "the repository changed since this page was opened; reload and ask again" }, 409);
    try {
      // A new id is issued only once the request carrying it is open, so a request refused on
      // the way leaves the address teammates use today working.
      const rotated = action === "rotate" ? newIngestId() : null;
      const ingest = action === "ask" ? await ensureIngestId(ctx.store, ctx.tenant, repo.id) : rotated;
      const endpoint = ingest === null ? null : ingestUrl(ctx.publicUrl!, ingest, repo.id);
      const user = c.get("user");
      const mirror = mirrorDir(ctx, repo.id);
      const head = repo.head!;
      const request = await inRequestTurn(ctx, repo.id, async () => {
        const prepared = await prepareBuilt(mirror, head, await usageChange(ctx, repo, head, action, endpoint), body.message, user.name, await teamNaming(mirror, head), body.branch);
        return propose(ctx, repo, user, prepared);
      });
      if (rotated) {
        await ctx.store.setIngestId(ctx.tenant, repo.id, rotated);
        await recordEvent(ctx, user, "usage.address.replaced", { repoId: repo.id, subject: "usage", detail: `the old skill-use address stopped counting; request #${request.number} carries the new one` });
      }
      // A teammate's copy that has not fetched the merged request yet keeps sending; once the
      // team is asked to stop, the orchestrator stops counting, as it does for a replaced address.
      if (action === "stop") {
        await ctx.store.dropIngestId(ctx.tenant, repo.id);
        await recordEvent(ctx, user, "usage.address.dropped", { repoId: repo.id, subject: "usage", detail: `the skill-use address stopped counting; request #${request.number} asks the team to stop reporting` });
      }
      return c.json({ request });
    } catch (err) {
      if (err instanceof ChangeRefused) return c.json({ error: err.message }, 400);
      return c.json({ error: (err as Error).message }, 409);
    }
  });

  if (ctx.tasks) app.route("/", taskRoutes(ctx, ctx.tasks));
  if (ctx.tasks) app.route("/", taskSuggestionRoutes(ctx, ctx.tasks));
  if (ctx.tasks) app.route("/", reviewRoutes(ctx));

  // The request's description as the forge holds it: the local forge keeps it beside the
  // branch, a hosted forge on the request itself, which the orchestrator links to instead.
  app.get("/api/repos/:id/requests/:number/description", async (c) => {
    const id = c.req.param("id");
    const number = Number(c.req.param("number"));
    const repo = ID.test(id) ? await ctx.store.getRepo(ctx.tenant, id) : null;
    const request = ID.test(id) && Number.isInteger(number) && number > 0 ? await ctx.store.getRequest(ctx.tenant, id, number) : null;
    const user = c.get("user");
    // A request whose repository is gone has no team left to read it by: its opener and the org's managers still learn why.
    const visible = request && (repo ? await seesRequest(ctx, user, repo, number, request) : manages(user) || request.createdBy === user.email || request.createdBy === user.id);
    if (!request || !visible) return c.json({ error: "unknown request" }, 404);
    if (!repo) return c.json({ error: "this request's repository is disconnected; its description stays with the request in that repository" }, 409);
    return c.json({ description: request.provider === "local" ? await readLocalDescription(repo, request.branch) : null, url: request.url });
  });

  // A page at a time: a company's orchestrator holds thousands of requests, and the screen that
  // listed them all drew tens of thousands of elements. `after` is the `next` of the page
  // before, handed back as it was given.
  app.delete("/api/repos/:id", async (c) => {
    if (!manages(c.get("user"))) return c.json({ error: "only an owner or an admin disconnects a repository" }, 403);
    const id = c.req.param("id");
    const repo = ID.test(id) ? await ctx.store.getRepo(ctx.tenant, id) : null;
    if (!repo) return c.json({ error: "unknown repository" }, 404);
    try {
      if (ctx.addedRepos?.has(repo.id)) {
        await removeAddedRepo(ctx, c.get("user"), repo.id);
        await recordEvent(ctx, c.get("user"), "repo.removed", { repoId: repo.id, subject: `repo:${repo.id}`, detail: `removed ${repo.name} (${maskUrl(repo.url)}) of ${repo.team}, connected from the orchestrator; its sealed token is deleted` });
        return c.json({ disconnected: repo.id });
      }
      await disconnectRepo(ctx, repo);
      await recordEvent(ctx, c.get("user"), "repo.disconnected", { repoId: repo.id, subject: `repo:${repo.id}`, detail: `disconnected ${repo.name} (${maskUrl(repo.url)}) of ${repo.team}` });
      return c.json({ disconnected: repo.id });
    } catch (err) {
      if (err instanceof DisconnectRefused) return c.json({ error: err.message }, 409);
      throw err;
    }
  });

  app.get("/api/requests", async (c) => {
    const repoId = c.req.query("repo");
    const status = c.req.query("status");
    if (status !== undefined && !(REQUEST_STATUSES as readonly string[]).includes(status)) return c.json({ error: `status is one of ${REQUEST_STATUSES.join(", ")}` }, 400);
    const given = c.req.query("after");
    const after = given === undefined ? null : readCursor(given);
    if (after === undefined) return c.json({ error: "after is not a page this orchestrator handed out" }, 400);
    // Kept to what this person reads in the store itself, so a page stays full, by the rule a request's
    // own page is read by: one a task opened as that task, any other by its team's readers and its
    // opener. An owner or an admin reads every team's, a disconnected repository's too.
    const user = c.get("user");
    const seenBy = manages(user) ? undefined : requestReader(user, await ctx.store.listRepos(ctx.tenant));
    const found = await ctx.store.requestPage(ctx.tenant, { ...(repoId && ID.test(repoId) ? { repoId } : {}), ...(status ? { status: status as RequestStatus } : {}), ...(seenBy ? { seenBy } : {}) }, after, REQUESTS_PER_PAGE);
    return c.json({ ...found, next: found.next && Buffer.from(JSON.stringify(found.next)).toString("base64url"), pageSize: REQUESTS_PER_PAGE });
  });

  // The page fallback serves the app for every other path; an API path the orchestrator does not
  // have answers as an API, so a screen can tell "not offered here" from a broken reply.
  app.all("/api/*", (c) => c.json({ error: "not found" }, 404));

  return app;
}
