import { isIP } from "node:net";
import { rm } from "node:fs/promises";
import { Hono } from "hono";
import type { Context } from "hono";
import type { OrchestratorContext } from "./app.js";
import { disconnectRepo, mirrorDir, publicRepo, syncRepo } from "./app.js";
import { AccountError } from "./accounts.js";
import { manages } from "./auth.js";
import type { OrchestratorEnv, Principal } from "./auth.js";
import { ChangeRefused } from "./changes.js";
import { cleanForgeConfig, saveForgeAccess } from "./editing.js";
import type { ForgeConfig } from "./forge/types.js";
import { recordEvent } from "./events.js";
import { forgeTokenName } from "./propose.js";
import { connectionToken } from "./forge/oauth-access.js";
import { forgeApp } from "./forge/oauth.js";
import type { AppForge } from "./forge/oauth.js";
import { hasOwnCli, ownCredentialConfig } from "./forge/own-cli.js";
import { FORGES, HOSTED_FORGES, isHostedForge } from "../shared/forge-def.js";
import type { HostedForge } from "../shared/forge-def.js";
import { hookSecretName, removeForgeHook } from "./forge/bootstrap.js";
import type { RepoRecord } from "./store.js";
import type { CodeTarget } from "./tasks/config.js";
import { ownNetworkAddress, publicAddress, systemResolver } from "./tasks/egress.js";
import { outsideReposRoot } from "./local.js";
import { cloudMode } from "./mode.js";
import { folderRefusalStatus, isGitFolder, machineProjectUrl, projectFacts, projectFolder } from "./projects.js";
import type { GitState } from "../shared/projects.js";
import { gitAsyncMaybe } from "./git.js";
import { NO_VAULT, readSecret, storeSecret } from "./vault.js";
import { ownCliHere } from "./forge/own-cli-here.js";

/**
 * Repositories an owner or an admin connects from the screen, beside those the configuration
 * file lists. The file stays the source of truth for what it lists: an id it names cannot be
 * connected here, and a repository connected here that the file comes to list becomes the
 * file's. A repository on GitLab or GitHub is fetched with a token sealed in the vault, handed to
 * git as an HTTP header for the clone address's own origin only, so it is written to no URL,
 * argument or mirror config. One the orchestrator reads by path is taken only under a folder the
 * operator named for it.
 */
export type ConnectForge = HostedForge | "path" | "machine";

/** The team a repository goes to when nobody named one and the person owns no single team: their own. */
export const PERSONAL_TEAM = "Mine";

export interface AddedRepo {
  id: string;
  forge: ConnectForge;
  kind: "skills" | "code";
  /** For a code repository: the skills repository its tasks read skills from. */
  skillsFrom: string | null;
  /** The origin the fetch token is bound to; null for a path. */
  gitOrigin: string | null;
  /** What teammates add the repository by: its clone address, which carries no credential. */
  memberUrl: string | null;
  /** Set when the repository is reached through the org's forge connection rather than a token of its own. */
  connection?: AppForge;
  /** Set in local mode for a repository reached with the person's own gh or glab sign-in, with no token here. */
  viaOwnCli?: boolean;
  /** A project on a folder of a person's machine: the machine, and what it said of the folder when it was opened. */
  /** `repos`: the working copies under a folder that is no repository itself, as the machine counted them when it was opened. */
  machine?: { id: string; path: string; name: string; git: GitState; repos?: number };
  addedBy: string;
  addedAt: string;
}

const ADDED_PREFIX = "repo.added.";
const ID = /^[a-z0-9][a-z0-9-]{0,62}$/;
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

export function gitTokenName(id: string, origin: string): string {
  return `repo-git-token:${id}@${origin}`;
}

export async function loadAddedRepos(store: OrchestratorContext["store"], tenant: string): Promise<Map<string, AddedRepo>> {
  return new Map((await store.listSettings(tenant, ADDED_PREFIX)).map((row) => [row.key.slice(ADDED_PREFIX.length), JSON.parse(row.value) as AddedRepo]));
}

/**
 * Each repository connected here that the configuration file now lists is the file's from this
 * start: its record and fetch token here go, and the file's entry is what the start reads.
 */
export async function yieldToFile(ctx: OrchestratorContext, listed: ReadonlySet<string>): Promise<string[]> {
  const yielded: string[] = [];
  for (const [id, added] of await loadAddedRepos(ctx.store, ctx.tenant)) {
    if (!listed.has(id)) continue;
    await forget(ctx, id, added);
    yielded.push(id);
  }
  return yielded;
}

async function forget(ctx: OrchestratorContext, id: string, added: AddedRepo): Promise<void> {
  await ctx.store.deleteSetting(ctx.tenant, `${ADDED_PREFIX}${id}`);
  if (added.gitOrigin) await ctx.store.deleteSecret(ctx.tenant, gitTokenName(id, added.gitOrigin));
  await ctx.store.deleteSecret(ctx.tenant, hookSecretName(id));
  await ctx.store.deleteSetting(ctx.tenant, hookSecretName(id));
  ctx.addedRepos?.delete(id);
}

/**
 * What git needs to fetch a repository connected here: the sealed token, opened for this one
 * fetch, as an Authorization header bound to the clone address's origin, with redirects and
 * every protocol but the one asked for turned off. Nothing for a repository the file lists.
 */
/**
 * The forges a screen offers to connect a repository on. Gitea is driven like the others but few
 * teams run it, so it is offered only where the operator asks for it with ORCHESTRATOR_FORGE_GITEA=1
 * or a Gitea repository is already connected here.
 */
export function offeredForges(ctx: Pick<OrchestratorContext, "addedRepos">, env: Record<string, string | undefined> = process.env): HostedForge[] {
  const gitea = env.ORCHESTRATOR_FORGE_GITEA === "1" || [...(ctx.addedRepos?.values() ?? [])].some((added) => added.forge === "gitea");
  return HOSTED_FORGES.filter((kind) => kind !== "gitea" || gitea);
}

/**
 * The address git is held to for a forge's host. The name is resolved here, and every address it
 * gives is outside this machine, its private networks and a cloud's metadata service, unless the
 * operator named the host in ORCHESTRATOR_INTERNAL_FORGE_HOSTS: an owner or an admin enters the
 * address, and the orchestrator fetches it from its own network, with the token.
 */
export async function forgeDestination(ctx: Pick<OrchestratorContext, "internalForgeHosts" | "resolveHost" | "privateNetworkForges">, url: URL): Promise<string> {
  const addresses = await (ctx.resolveHost ?? systemResolver)(url.hostname.replace(/^\[|\]$/g, "")).catch(() => [] as string[]);
  if (!addresses.length) throw new AccountError(`${url.hostname} does not resolve from where the orchestrator runs; check the address, and if it is right, whoever runs the orchestrator checks its network`, 400, "address-does-not-resolve");
  // An orchestrator one person runs for themselves reaches their own network, as their git does; never link-local, where a cloud's metadata answers.
  if (ctx.privateNetworkForges && !addresses.every(ownNetworkAddress)) {
    throw new AccountError(`${url.host} leads to a link-local, multicast or unspecified address, which the orchestrator never reaches; enter the address the repository's Clone button shows`, 403, "address-link-local");
  }
  if (!ctx.privateNetworkForges && !ctx.internalForgeHosts?.has(url.host) && !addresses.every(publicAddress)) {
    throw new AccountError(`${url.host} leads to this machine or a network inside it; whoever runs the orchestrator allows it by adding ${url.host} to ORCHESTRATOR_INTERNAL_FORGE_HOSTS`, 403, "address-leads-inside");
  }
  return addresses[0]!;
}

/**
 * What git needs to fetch a repository connected here: its host held to the address judged
 * now, so a second lookup cannot send the fetch elsewhere; redirects and every protocol but the
 * one asked for turned off; and the sealed token, opened for this one fetch, as an Authorization
 * header bound to the clone address's origin. Nothing for a repository the file lists.
 */
/** git's settings that hold it to the address judged now for `url`'s host, with redirects off. */
export async function pinnedGitSettings(ctx: Pick<OrchestratorContext, "internalForgeHosts" | "resolveHost" | "privateNetworkForges">, url: URL): Promise<[string, string][]> {
  const address = await forgeDestination(ctx, url);
  const port = url.port || (url.protocol === "https:" ? "443" : "80");
  return [
    ["http.followRedirects", "false"],
    ["http.curloptResolve", `${url.hostname}:${port}:${isIP(address) === 6 ? `[${address}]` : address}`],
  ];
}

/** Settings as git's GIT_CONFIG_* environment, with every protocol but `url`'s turned off. */
export function gitConfigEnv(url: URL, settings: [string, string][]): Record<string, string> {
  return {
    GIT_CONFIG_COUNT: String(settings.length),
    ...Object.fromEntries(settings.flatMap(([key, value], n) => [[`GIT_CONFIG_KEY_${n}`, key], [`GIT_CONFIG_VALUE_${n}`, value]])),
    GIT_ALLOW_PROTOCOL: url.protocol.replace(":", ""),
  };
}

export async function gitAccess(ctx: Pick<OrchestratorContext, "store" | "tenant" | "vault" | "addedRepos" | "internalForgeHosts" | "resolveHost" | "forgeApps">, repo: RepoRecord): Promise<{ env: Record<string, string>; secrets: string[] } | null> {
  const added = ctx.addedRepos?.get(repo.id);
  if (!added?.gitOrigin || !isHostedForge(added.forge)) return null;
  const url = new URL(repo.url);
  const settings = await pinnedGitSettings(ctx, url);
  // The person's own CLI answers git for credentials; the orchestrator holds none for such a repository.
  if (added.viaOwnCli && hasOwnCli(added.forge)) settings.push(...ownCredentialConfig(added.forge));
  const token = added.viaOwnCli ? null : added.connection ? await connectionToken(ctx, added.connection) : await readSecret(ctx.store, ctx.vault ?? null, ctx.tenant, gitTokenName(repo.id, added.gitOrigin));
  const user = FORGES[added.forge].gitUser;
  if (token) settings.push([`http.${added.gitOrigin}/.extraHeader`, `Authorization: Basic ${Buffer.from(`${user}:${token}`).toString("base64")}`]);
  return { env: gitConfigEnv(url, settings), secrets: token ? [token] : [] };
}

/** What a task on a code repository connected here changes and reads skills from; null for a skills repository. */
export function addedCodeTarget(ctx: Pick<OrchestratorContext, "addedRepos">, id: string): CodeTarget | null {
  const added = ctx.addedRepos?.get(id);
  return added?.kind === "code" ? { skillsFrom: added.skillsFrom, naming: {} } : null;
}

interface Cleaned {
  id: string;
  name: string;
  team: string;
  url: string;
  forge: ConnectForge;
  /** Null when it was not given: read from the repository once it is read, from its plugin manifest. */
  kind: "skills" | "code" | null;
  skillsFrom: string | null;
  gitOrigin: string | null;
  forgeConfig: ForgeConfig | null;
  memberUrl: string | null;
}

function text(value: unknown, what: string, max = 120): string {
  const t = typeof value === "string" ? value.trim() : "";
  if (!t || t.length > max) throw new AccountError(`enter the ${what}`);
  return t;
}

/** An https address on a forge, with no credential in it; plain http only on this machine. */
function forgeAddress(raw: string, forge: HostedForge): { url: URL; project: string } {
  if (raw.startsWith("-")) throw new AccountError("that is not a repository address; enter the repository's https address, as its Clone button shows it");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new AccountError("enter the repository's https address, as its Clone button shows it");
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACK.has(url.hostname))) throw new AccountError("a repository address is https (plain http only on this machine); enter the https address its Clone button shows");
  if (url.username || url.password) throw new AccountError("leave the token out of the address; enter it in the token field, where it is sealed");
  if (url.search || url.hash) throw new AccountError("a repository address has no query or fragment; enter it as its Clone button shows it");
  const project = decodeURIComponent(url.pathname).replace(/^\/+|\/+$/g, "").replace(/\.git$/, "");
  if (!project.includes("/")) throw new AccountError(`enter the ${FORGES[forge].projectShape} address`, 400, "address-has-no-project");
  if (!FORGES[forge].allowsHost(url.hostname)) throw new AccountError(`a ${FORGES[forge].label} repository is on ${FORGES[forge].homeHosts.join(" or ")}`);
  return { url, project };
}

/**
 * A folder by the one rule a project opens on, with the folder for paths in the home's place: on a
 * local orchestrator that is the home, so this route and opening a project refuse the same folders
 * alike, and an agent working in place never works in the home itself, a hidden folder, Library or
 * around the orchestrator's data.
 */
async function localPath(raw: string, root: string | null | undefined, dataDir: string): Promise<string> {
  if (!root) throw new AccountError("repositories read by path are connected only under the folder ORCHESTRATOR_LOCAL_REPOS_ROOT names; whoever runs the orchestrator sets it, or lists the repository in the configuration file", 409);
  const at = await projectFolder(raw, { home: root, dataDir });
  if (!("refused" in at)) return at.real;
  const named = Boolean(process.env.ORCHESTRATOR_LOCAL_REPOS_ROOT?.trim());
  const message = at.refused === "outside-home" ? outsideReposRoot(process.env, raw) : at.refused === "home-itself" && named ? "that is the folder ORCHESTRATOR_LOCAL_REPOS_ROOT names; connect a repository inside it" : at.message;
  throw new AccountError(message, folderRefusalStatus(at.refused), at.refused);
}

/**
 * Records a project on a folder of its person's machine, as the machine listed it. Nothing is
 * read or mirrored here: its tasks run on that machine, which checks the folder again first.
 */
export async function addMachineProject(ctx: OrchestratorContext, actor: Principal, project: { id: string; name: string; team: string; kind: "skills" | "code"; machine: NonNullable<AddedRepo["machine"]> }): Promise<RepoRecord> {
  const added: AddedRepo = { id: project.id, forge: "machine", kind: project.kind, skillsFrom: null, gitOrigin: null, memberUrl: null, machine: project.machine, addedBy: actor.email, addedAt: new Date().toISOString() };
  const repo = await ctx.store.upsertRepo({ tenant: ctx.tenant, id: project.id, team: project.team, name: project.name, url: machineProjectUrl(project.machine.id, project.machine.path) });
  await ctx.store.setSetting(ctx.tenant, `${ADDED_PREFIX}${project.id}`, JSON.stringify(added));
  ctx.addedRepos?.set(project.id, added);
  return repo;
}

/** A skills repository connected here, which a code repository's tasks read their skills from. */
async function skillsSource(ctx: OrchestratorContext, id: string): Promise<string> {
  const from = await ctx.store.getRepo(ctx.tenant, id);
  if (!from || ctx.addedRepos?.get(id)?.kind === "code") throw new AccountError(`${id} is not a skills repository here`, 400, "not-a-skills-project");
  return from.id;
}

/**
 * Changes which skills repository a code repository connected here reads its skills from, or
 * clears it with null. One the configuration file lists is changed there.
 */
export async function setSkillsFrom(ctx: OrchestratorContext, id: string, skillsFrom: unknown): Promise<void> {
  const added = ctx.addedRepos?.get(id);
  if (!added) throw new AccountError(`the configuration file lists ${id}; whoever runs the orchestrator changes it there`, 409, "configured-in-file");
  if (added.kind !== "code") throw new AccountError(`${id} is a skills repository; only a code repository reads skills from another`, 400, "not-a-code-project");
  if (skillsFrom !== null && (typeof skillsFrom !== "string" || !skillsFrom)) throw new AccountError("pick a skills repository to read skills from, or none", 400, "not-a-skills-project");
  if (skillsFrom === id) throw new AccountError("a repository does not read skills from itself", 400, "not-a-skills-project");
  const changed: AddedRepo = { ...added, skillsFrom: skillsFrom === null ? null : await skillsSource(ctx, skillsFrom) };
  await ctx.store.setSetting(ctx.tenant, `${ADDED_PREFIX}${id}`, JSON.stringify(changed));
  ctx.addedRepos!.set(id, changed);
}

async function clean(ctx: OrchestratorContext, actor: Principal, input: Record<string, unknown>): Promise<Cleaned> {
  const forge = input.forge;
  if (forge !== "path" && !isHostedForge(forge)) throw new AccountError(`a repository is on ${HOSTED_FORGES.map((kind) => FORGES[kind].label).join(", ")}, or read by path; pick one`);
  const kind = input.kind === undefined ? null : input.kind === "skills" || input.kind === "code" ? input.kind : undefined;
  if (kind === undefined) throw new AccountError('a repository is a skills repository or a code repository');
  const raw = text(input.url, "repository's address", 2000);
  let url: string;
  let gitOrigin: string | null = null;
  let forgeConfig: ForgeConfig | null = null;
  // A cloud orchestrator's machine is not an organization's to read from.
  if (forge === "path" && cloudMode()) throw new AccountError("a cloud orchestrator connects repositories on GitLab or GitHub, not by a path on its machine", 403);
  if (forge === "path") {
    url = await localPath(raw, ctx.localReposRoot, ctx.dataDir);
    // One folder is one project: two would each take their own lock and run in it at once.
    const open = (await ctx.store.listRepos(ctx.tenant)).find((r) => r.url === url);
    if (open) throw new AccountError(`that folder is already connected as ${open.id}`, 409, "already-connected");
  }
  else {
    const address = forgeAddress(raw, forge);
    await forgeDestination(ctx, address.url);
    url = address.url.toString();
    gitOrigin = address.url.origin;
    const project = typeof input.project === "string" && input.project.trim() ? input.project.trim() : address.project;
    const apiUrl = FORGES[forge].apiUrlFor(address.url);
    try {
      forgeConfig = cleanForgeConfig("", { kind: forge, apiUrl, project });
    } catch (err) {
      if (err instanceof ChangeRefused) throw new AccountError(err.message);
      throw err;
    }
  }
  const fallback = (forgeConfig?.project ?? url).split("/").pop()!.toLowerCase().replace(/\.git$/, "").replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  const id = typeof input.id === "string" && input.id.trim() ? input.id.trim() : fallback;
  if (!ID.test(id)) throw new AccountError(`the id "${id}" is lowercase letters, digits and dashes`);
  if (ctx.configured?.has(id)) throw new AccountError(`the configuration file lists ${id}; whoever runs the orchestrator changes it there`, 409);
  if (await ctx.store.getRepo(ctx.tenant, id)) throw new AccountError(`a repository called ${id} is already connected`, 409);
  const skillsFrom = kind === "code" && typeof input.skillsFrom === "string" && input.skillsFrom ? await skillsSource(ctx, input.skillsFrom) : null;
  // Not asked for: the person's one team when they own one, and their own otherwise.
  const team = input.team === undefined ? (actor.ownedTeams.length === 1 ? actor.ownedTeams[0]! : PERSONAL_TEAM) : text(input.team, "team");
  return { id, name: typeof input.name === "string" && input.name.trim() ? input.name.trim().slice(0, 120) : id, team, url, forge, kind, skillsFrom, gitOrigin, forgeConfig: forgeConfig && { ...forgeConfig, repoId: id }, memberUrl: forge === "path" ? null : url };
}

/**
 * Connects a repository and reads it at once. A read that fails leaves nothing behind - no
 * record, token or copy - and says why, masked of the token: a repository half connected would
 * show on every screen as broken.
 */
export async function connectRepo(ctx: OrchestratorContext, actor: Principal, input: Record<string, unknown>, through?: AppForge): Promise<RepoRecord> {
  if (actor.key || !manages(actor)) throw new AccountError("only an owner or an admin signed in to the orchestrator connects repositories", 403);
  const c = await clean(ctx, actor, input);
  // A folder read by path that is no git repository is a project worked on in place: nothing to mirror.
  const plain = c.forge === "path" && !(await isGitFolder(c.url));
  const token = input.token;
  // Whether it is one person's is asked now, not at start: an orchestrator that gained a second account since takes a token.
  const ownHere = c.forge !== "path" && (await ownCliHere(ctx));
  if (c.forge !== "path") {
    if (!ctx.vault) throw new AccountError(NO_VAULT, 409);
    if (!through && !ownHere && (typeof token !== "string" || !token.trim())) throw new AccountError(ctx.ownForgeCli ? "this orchestrator is reached by more than one person, so a repository is connected with a token here, not with your own gh or glab; enter a token" : "enter a token that reads the repository and opens requests on it");
  }
  // Through the org's connection the repository has to be on the forge the connection reaches, or its token would go elsewhere.
  if (through && (c.forge !== through || c.forgeConfig?.apiUrl !== (await forgeApp(ctx, through))?.apiUrl)) throw new AccountError(`that repository is not on the ${FORGES[through].label} the organization is connected to; connect it with a token instead`);
  // On one person's own orchestrator, a repository given no token is reached with their own CLI sign-in.
  const ownCli = !through && ownHere && hasOwnCli(c.forge) && !(typeof token === "string" && token.trim());
  const added: AddedRepo = { id: c.id, forge: c.forge, kind: c.kind ?? (plain ? (await projectFacts(c.url, { dataDir: ctx.dataDir })).kind : "skills"), skillsFrom: c.skillsFrom, gitOrigin: c.gitOrigin, memberUrl: c.memberUrl, addedBy: actor.email, addedAt: new Date().toISOString(), ...(through ? { connection: through } : {}), ...(ownCli ? { viaOwnCli: true } : {}) };
  const undo = async () => {
    await forget(ctx, c.id, added);
    const config = await ctx.store.getForgeConfig(ctx.tenant, c.id);
    if (config) await ctx.store.deleteSecret(ctx.tenant, forgeTokenName(config));
    await ctx.store.deleteForgeConfig(ctx.tenant, c.id);
    await ctx.store.removeRepo(ctx.tenant, c.id);
    await rm(mirrorDir(ctx, c.id), { recursive: true, force: true });
  };
  try {
    if (through || ownCli) await ctx.store.setForgeConfig(ctx.tenant, c.forgeConfig!);
    else if (c.forge !== "path") {
      await saveForgeAccess(ctx.store, ctx.vault ?? null, ctx.tenant, c.forgeConfig!, (token as string).trim(), actor.email);
      await storeSecret(ctx.store, ctx.vault ?? null, ctx.tenant, gitTokenName(c.id, c.gitOrigin!), (token as string).trim(), actor.email);
    }
    await ctx.store.upsertRepo({ tenant: ctx.tenant, id: c.id, team: c.team, name: c.name, url: c.url });
    await ctx.store.setSetting(ctx.tenant, `${ADDED_PREFIX}${c.id}`, JSON.stringify(added));
    ctx.addedRepos?.set(c.id, added);
  } catch (err) {
    await undo();
    if (err instanceof ChangeRefused) throw new AccountError(err.message);
    throw err;
  }
  if (plain) return (await ctx.store.getRepo(ctx.tenant, c.id))!;
  const read = await syncRepo(ctx, c.id);
  if ("error" in read) {
    await undo();
    throw new AccountError(`reading ${c.id} failed, so it is not connected: ${read.error}; check the address and the token, then connect it again`, 409);
  }
  if (c.kind === null) {
    // What the repository says it is, by its own files at the commit just read.
    const manifest = async (file: string) => (await gitAsyncMaybe(["cat-file", "-e", `${read.head}:.claude-plugin/${file}`], mirrorDir(ctx, c.id))) !== null;
    const kind = (await manifest("marketplace.json")) || (await manifest("plugin.json")) ? "skills" : "code";
    if (kind !== added.kind) {
      const detected = { ...added, kind } as AddedRepo;
      await ctx.store.setSetting(ctx.tenant, `${ADDED_PREFIX}${c.id}`, JSON.stringify(detected));
      ctx.addedRepos?.set(c.id, detected);
    }
  }
  return (await ctx.store.getRepo(ctx.tenant, c.id))!;
}

/** Removes a repository connected here, as Disconnect does, refused (DisconnectRefused) while a request is open or a task runs. */
export async function removeAddedRepo(ctx: OrchestratorContext, actor: Principal, id: string): Promise<void> {
  if (actor.key || !manages(actor)) throw new AccountError("only an owner or an admin signed in to the orchestrator removes repositories", 403);
  const added = (await loadAddedRepos(ctx.store, ctx.tenant)).get(id);
  const repo = await ctx.store.getRepo(ctx.tenant, id);
  if (!added || !repo) throw new AccountError(ctx.configured?.has(id) ? `the configuration file lists ${id}; whoever runs the orchestrator removes it there` : "no repository was connected here under that id", 404);
  // Out of the orchestrator's own list first, so the disconnect that follows treats it as no longer configured.
  ctx.addedRepos?.delete(id);
  try {
    await disconnectRepo(ctx, repo);
  } catch (err) {
    ctx.addedRepos?.set(id, added);
    throw err;
  }
  if (added.connection) await removeForgeHook(ctx, id);
  await forget(ctx, id, added);
}

function failure(c: Context, err: unknown) {
  if (err instanceof AccountError) return c.json({ error: err.message, code: err.code }, err.status);
  throw err;
}

export function connectRoutes(ctx: OrchestratorContext): Hono<OrchestratorEnv> {
  const app = new Hono<OrchestratorEnv>();

  app.post("/api/repos", async (c) => {
    try {
      const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
      const repo = await connectRepo(ctx, c.get("user"), body);
      const added = ctx.addedRepos?.get(repo.id);
      await recordEvent(ctx, c.get("user"), "repo.connected", { repoId: repo.id, subject: `repo:${repo.id}`, detail: `${repo.name} of team ${repo.team}, ${added?.kind ?? "skills"}, ${!added || !isHostedForge(added.forge) ? "read by path" : `on ${FORGES[added.forge].label} with a sealed token`}` });
      // What was decided without being asked, so the screen says so and where to change it.
      return c.json({ repo: publicRepo(ctx, repo), detected: { name: repo.name, kind: ctx.addedRepos?.get(repo.id)?.kind ?? "skills", team: repo.team } });
    } catch (err) {
      return failure(c, err);
    }
  });

  return app;
}
