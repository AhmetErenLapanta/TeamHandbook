import { join } from "node:path";
import { Hono } from "hono";
import type { ProjectFacts } from "../shared/projects.js";
import { AccountError } from "./accounts.js";
import { OrchestratorError } from "./errors.js";
import type { OrchestratorContext } from "./app.js";
import { publicRepo } from "./app.js";
import { manages } from "./auth.js";
import type { OrchestratorEnv, Principal } from "./auth.js";
import { addMachineProject, connectRepo, PERSONAL_TEAM, setSkillsFrom } from "./connect.js";
import { recordEvent } from "./events.js";
import { localRepoPath } from "./forge/local.js";
import { localMode } from "./mode.js";
import { askMachine, homePath } from "./machine-folders.js";
import { folderRefusalStatus, homeReal, machineFolderOf, machineProjectUrl, projectFacts, projectFolder, shownProjects } from "./projects.js";
import { route } from "./route-scopes.js";
import { inPlaceFolder, projectTrust } from "./tasks/folder-trust.js";
import { workingCopies } from "../runner/workspace.js";
import type { RepoRecord } from "./store.js";

/** Which project was opened last, so the first screen comes back to it: one person's own on a team's or the cloud's. */
const LAST_PROJECT = "project.last";
const lastProjectKey = (user: Principal) => (localMode() ? LAST_PROJECT : `${LAST_PROJECT}.${user.id}`);
const NAME_MAX = 80;

/** An id from a folder's name, the first one free: `app`, then `app-2`, `app-3`. */
function freeId(name: string, taken: ReadonlySet<string>): string {
  const base = name.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "project";
  for (let n = 1; ; n++) {
    const id = n === 1 ? base : `${base}-${n}`;
    if (!taken.has(id)) return id;
  }
}

/** A path project's facts, read now; a machine project's, as its machine listed the folder when it was opened; a repository on a forge has none. */
async function factsOf(ctx: OrchestratorContext, repo: RepoRecord): Promise<ProjectFacts | null> {
  const added = ctx.addedRepos?.get(repo.id);
  if (added?.machine) return { git: added.machine.git, origin: null, name: added.machine.name, kind: added.kind, empty: false, ...(added.machine.repos ? { repos: added.machine.repos } : {}) };
  const path = localRepoPath(repo.url);
  return path ? projectFacts(path, { dataDir: ctx.dataDir }) : null;
}

/** A project as the screen shows it: its facts, and for one on a machine, which machine and where from its home. */
async function viewOf(ctx: OrchestratorContext, repo: RepoRecord) {
  const machine = machineFolderOf(repo.url);
  // Whether the person trusts the folder's own settings, for a project worked on in place; null for one the orchestrator clones.
  return { ...publicRepo(ctx, repo), facts: await factsOf(ctx, repo), machine: machine ? { id: machine.machineId, path: machine.path } : null, trust: await projectTrust(ctx, repo) };
}

/**
 * Opens a folder of this machine as a project: by the one folder rule, with its name, kind and git
 * state read off it and nothing asked. A folder already open comes back as it is, never twice.
 */
export async function openProject(ctx: OrchestratorContext, actor: Principal, path: unknown): Promise<{ project: RepoRecord; facts: ProjectFacts; existing: boolean }> {
  if (typeof path !== "string" || !path.trim()) throw new AccountError("give the folder's full path", 400, "not-absolute");
  const at = await projectFolder(path.trim(), { dataDir: ctx.dataDir });
  if ("refused" in at) throw new AccountError(at.message, folderRefusalStatus(at.refused), at.refused);
  const facts = await projectFacts(at.real, { dataDir: ctx.dataDir });
  const repos = await ctx.store.listRepos(ctx.tenant);
  const open = repos.find((r) => r.url === at.real);
  let project = open;
  if (!project) {
    const taken = new Set([...repos.map((r) => r.id), ...(ctx.configured ?? [])]);
    project = await connectRepo(ctx, actor, { forge: "path", url: at.real, id: freeId(facts.name, taken), name: facts.name, kind: facts.kind, team: PERSONAL_TEAM });
    await recordEvent(ctx, actor, "repo.connected", { repoId: project.id, subject: `repo:${project.id}`, detail: `opened the folder ${facts.name} as a project, ${facts.git === "none" ? "worked on in place" : "a git repository"}` });
  }
  await ctx.store.setSetting(ctx.tenant, lastProjectKey(actor), project.id);
  return { project, facts, existing: Boolean(open) };
}

/** The folder a project names, which a person picks on their machine's list: a path from its home, never the home itself. */
const machineFolder = (path: unknown): path is string => homePath(path) && path !== "~";

/**
 * Opens a folder of the person's own machine as a project: the machine lists the folder's parent
 * by its own rule, so the folder is one it would work in, and its name, kind and git state come
 * from that list. A folder already open comes back as it is.
 */
export async function openMachineProject(ctx: OrchestratorContext, actor: Principal, machineId: unknown, path: unknown): Promise<{ project: RepoRecord; facts: ProjectFacts; existing: boolean }> {
  const machine = typeof machineId === "string" ? (await ctx.store.listMachines(ctx.tenant, actor.id)).find((m) => m.id === machineId && m.userId === actor.id && !m.revokedAt) : undefined;
  if (!machine) throw new AccountError("unknown machine", 404, "unknown-machine");
  if (!machineFolder(path)) throw new AccountError(path === "~" ? "that is the machine's home folder itself; open a folder inside it" : "give the folder as a path from ~/", 400, path === "~" ? "home-itself" : "not-absolute");
  const url = machineProjectUrl(machine.id, path);
  const repos = await ctx.store.listRepos(ctx.tenant);
  const open = repos.find((r) => r.url === url);
  let project = open;
  let facts: ProjectFacts;
  if (open) facts = (await factsOf(ctx, open))!;
  else {
    const parent = path.slice(0, path.lastIndexOf("/")) || "~";
    const asked = await askMachine(ctx, machine, { under: parent, q: null });
    if (!("list" in asked)) throw new OrchestratorError(asked.code, asked.error, asked.status);
    const entry = asked.list.folders.find((f) => f.path === path);
    if (!entry) throw new AccountError(`${machine.name} lists no folder at ${path}`, 404, "not-found");
    facts = { git: entry.git, origin: null, name: entry.name, kind: entry.markers.includes(".claude-plugin") ? "skills" : "code", empty: false };
    const taken = new Set([...repos.map((r) => r.id), ...(ctx.configured ?? [])]);
    project = await addMachineProject(ctx, actor, { id: freeId(entry.name, taken), name: entry.name, team: actor.ownedTeams.length === 1 ? actor.ownedTeams[0]! : PERSONAL_TEAM, kind: facts.kind, machine: { id: machine.id, path, name: entry.name, git: entry.git, ...(entry.repos ? { repos: entry.repos } : {}) } });
    await recordEvent(ctx, actor, "repo.connected", { repoId: project.id, subject: `repo:${project.id}`, detail: `opened the folder ${entry.name} on ${machine.name} as a project` });
  }
  await ctx.store.setSetting(ctx.tenant, lastProjectKey(actor), project!.id);
  return { project: project!, facts, existing: Boolean(open) };
}

/** Opening a folder, listing the projects with what each is now, and naming one; a local orchestrator's owner alone opens a folder. */
export function projectRoutes(ctx: OrchestratorContext): Hono<OrchestratorEnv> {
  const app = new Hono<OrchestratorEnv>();
  const owner = (user: Principal) => !user.key && manages(user);
  const refused = (err: unknown) => {
    if (err instanceof OrchestratorError) return { body: { error: err.message, code: err.code }, status: err.status };
    throw err;
  };

  // A local orchestrator's owner opens a folder of this machine; on a team's or the cloud's, a
  // person opens a folder of their own machine.
  route(app, "POST /api/projects", async (c) => {
    const user = c.get("user");
    const body = (await c.req.json().catch(() => ({}))) as { path?: unknown; machineId?: unknown };
    if (!localMode() && body.machineId === undefined) return c.json({ error: "not found" }, 404);
    if (localMode() && body.machineId !== undefined) return c.json({ error: "a local orchestrator opens the folders of this machine; leave machineId out", code: "not-a-machine-project" }, 400);
    if (localMode() && !owner(user)) return c.json({ error: "only this machine's owner opens its folders" }, 403);
    if (!localMode() && (user.key || user.id.startsWith("service:") || user.role === "viewer")) return c.json({ error: "unknown machine", code: "unknown-machine" }, 404);
    try {
      const { project, facts, existing } = localMode() ? await openProject(ctx, user, body.path) : await openMachineProject(ctx, user, body.machineId, body.path);
      return c.json({ project: { ...(await viewOf(ctx, project)), facts }, existing });
    } catch (err) {
      const { body: answer, status } = refused(err);
      return c.json(answer, status);
    }
  });

  route(app, "GET /api/projects", async (c) => {
    const repos = await shownProjects(ctx, c.get("user"), await ctx.store.listRepos(ctx.tenant));
    const projects = await Promise.all(repos.map((repo) => viewOf(ctx, repo)));
    const last = await ctx.store.getSetting(ctx.tenant, lastProjectKey(c.get("user")));
    // The home a path project's folder is shown from as ~; a machine project's path is from its own machine's home already.
    return c.json({ projects, last: last && repos.some((r) => r.id === last) ? last : null, home: localMode() ? await homeReal() : null });
  });

  // The repositories a folder holds, as a task there finds them: by path, with the requests open on each, for the folder's
  // page; none for a folder on a machine, which only that machine reads (its count is in the project's facts). A
  // repository's requests are kept under the hidden record a task there made for it, found by its path.
  route(app, "GET /api/projects/:id/repositories", async (c) => {
    const repo = await ctx.store.getRepo(ctx.tenant, c.req.param("id") ?? "");
    if (!repo || !(await shownProjects(ctx, c.get("user"), [repo])).length) return c.json({ error: "unknown project" }, 404);
    const folder = await inPlaceFolder(repo);
    if (!folder) return c.json({ repositories: null });
    const found = await workingCopies(folder).catch(() => [] as string[]);
    if (!Array.isArray(found)) return c.json({ repositories: null, tooMany: true });
    const records = new Map((await ctx.store.listRepos(ctx.tenant)).filter((r) => r.id.startsWith(`${repo.id}--`)).map((r) => [r.url, r.id]));
    const open = (await ctx.store.listRequests(ctx.tenant)).filter((r) => r.status === "open");
    const openOn = (id: string | undefined) => (id ? open.filter((r) => r.repoId === id).length : 0);
    return c.json({ repositories: found.map((path) => ({ path, name: path, openRequests: openOn(records.get(join(folder, path))) })) });
  });

  // A project's name, and for a code project the skills project its tasks read; either or both.
  route(app, "PATCH /api/projects/:id", async (c) => {
    if (!owner(c.get("user"))) return c.json({ error: "only an owner or an admin changes a project" }, 403);
    let repo = await ctx.store.getRepo(ctx.tenant, c.req.param("id") ?? "");
    if (!repo) return c.json({ error: "unknown project" }, 404);
    const body = (await c.req.json().catch(() => ({}))) as { name?: unknown; skillsFrom?: unknown };
    if (body.name === undefined && body.skillsFrom === undefined) return c.json({ error: "give a name, a skillsFrom, or both", code: "nothing-to-change" }, 400);
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (body.name !== undefined && (!name || name.length > NAME_MAX || /[\u0000-\u001f\u007f]/.test(name))) return c.json({ error: `a project's name is 1 to ${NAME_MAX} characters, with no control characters`, code: "bad-name" }, 400);
    try {
      if (body.skillsFrom !== undefined) await setSkillsFrom(ctx, repo.id, body.skillsFrom);
    } catch (err) {
      const { body: answer, status } = refused(err);
      return c.json(answer, status);
    }
    if (body.name !== undefined) repo = await ctx.store.upsertRepo({ tenant: ctx.tenant, id: repo.id, team: repo.team, name, url: repo.url });
    return c.json({ project: await viewOf(ctx, repo) });
  });

  return app;
}
