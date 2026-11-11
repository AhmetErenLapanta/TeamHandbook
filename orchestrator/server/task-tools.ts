import { readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { Hono } from "hono";
import type { Context } from "hono";
import type { OrchestratorContext } from "./app.js";
import { canEditTeam, manages } from "./auth.js";
import { canStartOnTeam } from "./tasks/guards.js";
import { skillSource, teamSkills } from "./tasks/targets.js";
import type { OrchestratorEnv, Principal } from "./auth.js";
import { recordEvent } from "./events.js";
import { fetchSkillSource, readSkillSource, skillSourceAddress } from "./forge/skill-source.js";
import { oneAtATime } from "./git.js";
import { newId } from "./ids.js";
import { localMode } from "./mode.js";
import { ChangeRefused } from "./changes.js";
import { remoteUrl } from "./integrations/remote.js";
import { auditServer, parseSkillFrontmatter, refusalSummary } from "./plugin.js";
import { homeReal, projectFolder } from "./projects.js";
import { route } from "./route-scopes.js";
import type { RepoRecord } from "./store.js";
import type { TaskToolChoice } from "./tasks/types.js";
import { NO_VAULT, readSecret, storeSecret } from "./vault.js";
import type { MachineMcpServer } from "../runner/machine-mcp.js";

/*
 * What a project gives the tasks that run in it beside the person's own Claude Code setup: skill
 * sources, a folder of this machine or a git address, and MCP servers. The person's own ~/.claude
 * is never written; a task is handed these as a skill directory and an --mcp-config of its own.
 * An MCP server's secret values stay in the vault, the record names them only.
 */

export interface SkillSourceSkill {
  name: string;
  description: string;
}

export type SkillSource =
  | { id: string; kind: "folder"; path: string; name: string; skills: SkillSourceSkill[]; readAt: string }
  | { id: string; kind: "git"; url: string; name: string; head: string; skills: SkillSourceSkill[]; readAt: string };

export type TaskMcpServer =
  | { id: string; name: string; transport: "stdio"; command: string; args: string[]; env: string[] }
  | { id: string; name: string; transport: "http"; url: string; headers: string[] };

export interface TaskTools {
  skillSources: SkillSource[];
  mcpServers: TaskMcpServer[];
}

const KEY = (projectId: string) => `project.tools.${projectId}`;
const MCP_NAME = /^[A-Za-z0-9_-]{1,64}$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const HEADER_NAME = /^[A-Za-z0-9-]{1,64}$/;
const VALUE_MAX = 4000;
const SOURCES_MAX = 20;
const SERVERS_MAX = 20;
const SKILLS_MAX = 200;
const controls = /[\u0000-\u001f\u007f]/;

/** Where a git source's mirror is kept in the orchestrator's data. */
export const skillSourceDir = (ctx: Pick<OrchestratorContext, "dataDir" | "tenant">, id: string) => join(ctx.dataDir, "skill-sources", ctx.tenant, `${id}.git`);
/** The vault name of one value an MCP server is given. */
export const taskMcpSecret = (projectId: string, serverId: string, name: string) => `taskmcp:${projectId}:${serverId}:${name}`;

class Refused extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: 400 | 403 | 404 | 409 | 502 = 400,
  ) {
    super(message);
  }
}

export async function readTaskTools(ctx: Pick<OrchestratorContext, "store" | "tenant">, projectId: string): Promise<TaskTools> {
  const raw = await ctx.store.getSetting(ctx.tenant, KEY(projectId));
  const parsed = raw ? (JSON.parse(raw) as Partial<TaskTools>) : {};
  return { skillSources: parsed.skillSources ?? [], mcpServers: parsed.mcpServers ?? [] };
}

/** Changes a project's record one change at a time, so two added at once are both kept. */
function changing<T>(ctx: OrchestratorContext, projectId: string, change: (tools: TaskTools) => Promise<{ tools: TaskTools; result: T }>): Promise<T> {
  return oneAtATime(join(ctx.dataDir, "task-tools", ctx.tenant, projectId), async () => {
    const { tools, result } = await change(await readTaskTools(ctx, projectId));
    await ctx.store.setSetting(ctx.tenant, KEY(projectId), JSON.stringify(tools));
    return result;
  });
}

/** The skills a folder holds: itself as one, or each folder in it, or in its skills/, with a SKILL.md. */
async function folderSkills(real: string): Promise<SkillSourceSkill[]> {
  const read = async (dir: string) => {
    const md = await readFile(join(dir, "SKILL.md"), "utf8").catch(() => null);
    return md ? parseSkillFrontmatter(md.replace(/\r\n/g, "\n")) : null;
  };
  const own = await read(real);
  if (own) return [{ name: own.name, description: own.description }];
  const skills: SkillSourceSkill[] = [];
  for (const under of [join(real, "skills"), real]) {
    for (const entry of await readdir(under, { withFileTypes: true }).catch(() => [])) {
      if (skills.length >= SKILLS_MAX || !entry.isDirectory() || entry.name.startsWith(".")) continue;
      const found = await read(join(under, entry.name));
      if (found && !skills.some((s) => s.name === found.name)) skills.push({ name: found.name, description: found.description });
    }
    if (skills.length) break;
  }
  return skills;
}

/** A folder named from this machine's home, by the folder rule a project opens on. */
async function realFolder(ctx: OrchestratorContext, path: string): Promise<string> {
  if (path !== "~" && !path.startsWith("~/")) throw new Refused("not-absolute", "give the folder as a path from ~/");
  const home = await homeReal();
  const at = await projectFolder(path === "~" ? home : join(home, path.slice(2)), { dataDir: ctx.dataDir });
  if ("refused" in at) throw new Refused(at.refused, at.message, at.refused === "not-found" ? 404 : 400);
  return at.real;
}

async function readSource(ctx: OrchestratorContext, source: SkillSource): Promise<SkillSource> {
  const readAt = new Date().toISOString();
  if (source.kind === "folder") {
    const skills = await folderSkills(await realFolder(ctx, source.path));
    if (!skills.length) throw new Refused("no-skills", `${source.path} holds no folder with a SKILL.md`);
    return { ...source, skills, readAt };
  }
  const fetched = await fetchSkillSource(ctx, source.url, skillSourceDir(ctx, source.id));
  if ("error" in fetched) throw new Refused(fetched.code, fetched.error, fetched.status);
  const inventory = await readSkillSource(skillSourceDir(ctx, source.id));
  const skills = inventory.skills.slice(0, SKILLS_MAX).map((s) => ({ name: s.name, description: s.description }));
  if (!skills.length) throw new Refused("no-skills", `${source.url} holds no skill at ${fetched.head.slice(0, 7)}`);
  return { ...source, head: fetched.head, skills, readAt };
}

/** A new source of skills, read once before it is kept: one that cannot be read is not kept. */
async function addSource(ctx: OrchestratorContext, projectId: string, body: { folder?: unknown; url?: unknown }): Promise<SkillSource> {
  const id = newId("ssr");
  let source: SkillSource;
  if (typeof body.folder === "string") {
    if (!localMode()) throw new Refused("not-on-this-machine", "a folder is a skill source on a local orchestrator; name a git address here");
    source = { id, kind: "folder", path: body.folder.trim(), name: body.folder.trim().split("/").pop() || "~", skills: [], readAt: "" };
  } else if (typeof body.url === "string") {
    const address = skillSourceAddress(ctx, body.url);
    if ("error" in address) throw new Refused(address.code, address.error, address.status);
    source = { id, kind: "git", url: address.url, name: address.url.replace(/\.git$/, "").split(/[/:]/).pop() || address.host, head: "", skills: [], readAt: "" };
  } else throw new Refused("bad-source", "a skill source is a folder (~/…) or a git address");
  return changing(ctx, projectId, async (tools) => {
    const same = tools.skillSources.find((s) => (s.kind === "folder" && source.kind === "folder" ? s.path === source.path : s.kind === "git" && source.kind === "git" && s.url === source.url));
    if (same) throw new Refused("already-added", `${same.name} is already a skill source here`, 409);
    if (tools.skillSources.length >= SOURCES_MAX) throw new Refused("too-many", `a project takes at most ${SOURCES_MAX} skill sources`, 409);
    let read: SkillSource;
    try {
      read = await readSource(ctx, source);
    } catch (err) {
      if (source.kind === "git") await rm(skillSourceDir(ctx, id), { recursive: true, force: true });
      throw err;
    }
    return { tools: { ...tools, skillSources: [...tools.skillSources, read] }, result: read };
  });
}

/** An MCP server for this project's tasks, its secret values sealed apart from its definition. */
async function addServer(ctx: OrchestratorContext, actor: Principal, projectId: string, body: Record<string, unknown>): Promise<TaskMcpServer> {
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!MCP_NAME.test(name)) throw new Refused("bad-name", "an MCP server's name is letters, digits, - and _, up to 64");
  const values = (raw: unknown, pattern: RegExp, what: string): Record<string, string> => {
    if (raw === undefined) return {};
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Refused("bad-values", `${what} are names and their values`);
    const entries = Object.entries(raw as Record<string, unknown>);
    if (entries.length > 32 || !entries.every(([k, v]) => pattern.test(k) && typeof v === "string" && v.length > 0 && v.length <= VALUE_MAX)) throw new Refused("bad-values", `${what} are up to 32 names, each with a value of at most ${VALUE_MAX} characters`);
    return Object.fromEntries(entries) as Record<string, string>;
  };
  const id = newId("mcp");
  let server: TaskMcpServer;
  let sealed: Record<string, string>;
  if (typeof body.command === "string") {
    // A command runs as whoever starts the task, on their machine or on this orchestrator: on a
    // team's or the cloud's, only its owners and admins add one, as only they merge a team's servers.
    if (!localMode() && !manages(actor)) throw new Refused("command-owners-only", "only the organization's owners and admins add an MCP server that runs a command", 403);
    const command = body.command.trim();
    const args = body.args === undefined ? [] : body.args;
    if (!command || command.length > 500 || controls.test(command)) throw new Refused("bad-command", "a command is one line of at most 500 characters");
    if (!Array.isArray(args) || args.length > 50 || !args.every((a) => typeof a === "string" && a.length <= 1000 && !controls.test(a))) throw new Refused("bad-command", "args are at most 50 lines of text");
    sealed = values(body.env, ENV_NAME, "env");
    server = { id, name, transport: "stdio", command, args: args as string[], env: Object.keys(sealed) };
  } else if (typeof body.url === "string") {
    if (URL.canParse(body.url.trim()) && (new URL(body.url.trim()).username || new URL(body.url.trim()).password)) throw new Refused("carries-credential", "leave the user and token out of the address; give them as a header");
    let url: string;
    try {
      // The rule a person's own MCP server is held to: https to a public host, this machine only where it is the person's own.
      url = remoteUrl(body.url, "an MCP server's address", localMode() || Boolean(ctx.localMcp)).toString();
    } catch (err) {
      if (err instanceof ChangeRefused) throw new Refused("bad-url", err.message);
      throw err;
    }
    sealed = values(body.headers, HEADER_NAME, "headers");
    server = { id, name, transport: "http", url, headers: Object.keys(sealed) };
  } else throw new Refused("bad-server", "an MCP server is a command to run or an address to reach");
  // Held to the rule a team's servers travel by: a credential in its definition, not in a sealed value, refuses it.
  const definition = server.transport === "stdio" ? { command: server.command, args: server.args } : { type: "http", url: server.url };
  const audit = auditServer(definition);
  if (!audit.migratable) throw new Refused("carries-credential", `${name}: ${refusalSummary(audit)}; give it as an env value or a header, which is sealed`);
  if (Object.keys(sealed).length && !ctx.vault) throw new Refused("no-vault", NO_VAULT, 409);
  return changing(ctx, projectId, async (tools) => {
    if (tools.mcpServers.some((s) => s.name === name)) throw new Refused("name-taken", `this project has an MCP server called ${name}`, 409);
    if (tools.mcpServers.length >= SERVERS_MAX) throw new Refused("too-many", `a project takes at most ${SERVERS_MAX} MCP servers`, 409);
    for (const [key, value] of Object.entries(sealed)) await storeSecret(ctx.store, ctx.vault ?? null, ctx.tenant, taskMcpSecret(projectId, id, key), value, actor.email);
    return { tools: { ...tools, mcpServers: [...tools.mcpServers, server] }, result: server };
  });
}

const PICKS_MAX = 20;

/**
 * What a task's start picks of its project's skill sources and MCP servers, each one of the
 * project's own; a git source at the head read last. A server with sealed values is picked for a
 * task on a person's machine, which gets it as a template its own environment fills, so no secret
 * value goes to a machine; it is held back only where tasks run on this orchestrator, which does
 * not carry sealed values yet.
 */
export async function toolChoiceOf(ctx: Pick<OrchestratorContext, "store" | "tenant">, projectId: string, projectSkills: unknown, mcpServers: unknown, confirmed: unknown = []): Promise<TaskToolChoice | { error: string; code: string }> {
  if (projectSkills === undefined && mcpServers === undefined) return { skills: [], mcpServers: [] };
  const tools = await readTaskTools(ctx, projectId);
  const skills: TaskToolChoice["skills"] = [];
  if (projectSkills !== undefined) {
    if (!Array.isArray(projectSkills) || projectSkills.length > PICKS_MAX) return { error: `projectSkills names at most ${PICKS_MAX} skills, each by its source and name`, code: "bad-project-skills" };
    for (const pick of projectSkills as { source?: unknown; name?: unknown }[]) {
      const source = tools.skillSources.find((s) => s.id === pick?.source);
      if (!source || !source.skills.some((s) => s.name === pick.name)) return { error: `${String(pick?.name)} is not a skill of this project's sources`, code: "unknown-project-skill" };
      if (!skills.some((s) => s.source === source.id && s.name === pick.name)) skills.push({ source: source.id, name: pick.name as string, head: source.kind === "git" ? source.head : null });
    }
  }
  const servers: string[] = [];
  if (mcpServers !== undefined) {
    if (!Array.isArray(mcpServers) || mcpServers.length > PICKS_MAX) return { error: `mcpServers names at most ${PICKS_MAX} servers by id`, code: "bad-mcp-servers" };
    for (const id of mcpServers) {
      const server = tools.mcpServers.find((s) => s.id === id);
      if (!server) return { error: `${String(id)} is not one of this project's MCP servers`, code: "unknown-mcp-server" };
      // A task on a person's machine gets the server as a template their own environment fills; a run on this orchestrator does not carry sealed values yet.
      if (!localMode() && process.env.ORCHESTRATOR_SERVER_TASKS === "1" && (server.transport === "stdio" ? server.env : server.headers).length) return { error: `${server.name} holds sealed values, and a run on this orchestrator does not carry them yet; start the task on your machine`, code: "sealed-on-server" };
      if (server.transport === "stdio" && !localMode()) {
        // On this orchestrator a command runs only where a container holds it; on a person's machine only once they saw it.
        if (process.env.ORCHESTRATOR_SERVER_TASKS === "1") {
          if (process.env.ORCHESTRATOR_TASK_ISOLATION !== "container") return { error: `${server.name} runs a command, and this orchestrator runs it only in a task's container`, code: "command-needs-container" };
        } else if (!Array.isArray(confirmed) || !confirmed.includes(server.id)) return { error: `${server.name} runs \`${[server.command, ...server.args].join(" ")}\` on your machine; confirm it to start the task`, code: "command-not-confirmed" };
      }
      if (!servers.includes(server.id)) servers.push(server.id);
    }
  }
  return { skills, mcpServers: servers };
}

/**
 * An MCP server's definition as a task's --mcp-config takes it, its sealed values read back: the
 * one place they leave the vault, for a run on this orchestrator.
 */
export async function mcpConfigOf(ctx: Pick<OrchestratorContext, "store" | "tenant" | "vault">, projectId: string, server: TaskMcpServer): Promise<Record<string, unknown>> {
  const sealed = async (names: string[]) => Object.fromEntries(await Promise.all(names.map(async (n) => [n, (await readSecret(ctx.store, ctx.vault ?? null, ctx.tenant, taskMcpSecret(projectId, server.id, n))) ?? ""])));
  return server.transport === "stdio" ? { command: server.command, args: server.args, env: await sealed(server.env) } : { type: "http", url: server.url, headers: await sealed(server.headers) };
}

/**
 * The variable a sealed value of an MCP server is read from on a person's machine, in the form a
 * machine reads: an env entry's own name, a header's after its server's name, so two
 * servers' Authorization headers never ask for one variable.
 */
export function machineVariable(server: TaskMcpServer, key: string): string {
  const name = (server.transport === "stdio" ? key : `${server.name}_${key}`).toUpperCase().replace(/[^A-Z0-9_]/g, "_");
  return /^[0-9]/.test(name) ? `_${name}` : name;
}

/**
 * A project's MCP server as a machine task's lease carries it: each sealed value only as the
 * `${NAME}` its person's own environment fills there, so no value leaves the vault.
 */
export function machineMcpServerOf(server: TaskMcpServer): MachineMcpServer {
  const templates = (keys: string[]) => Object.fromEntries(keys.map((key) => [key, `\${${machineVariable(server, key)}}`]));
  return server.transport === "stdio" ? { type: "stdio", command: server.command, args: server.args, env: templates(server.env) } : { type: "http", url: server.url, headers: templates(server.headers) };
}

/** A project's skill sources and MCP servers for its tasks; a local orchestrator's owner, or whoever edits the project's team, changes them. */
export function taskToolRoutes(ctx: OrchestratorContext): Hono<OrchestratorEnv> {
  const app = new Hono<OrchestratorEnv>();
  const failed = (c: Context<OrchestratorEnv>, err: unknown) => {
    if (err instanceof Refused) return c.json({ error: err.message, code: err.code }, err.status);
    throw err;
  };
  /** The project, for a person allowed to change what its tasks are given; the refusal otherwise. */
  const projectFor = async (c: Context<OrchestratorEnv>): Promise<RepoRecord | Response> => {
    const user = c.get("user");
    const repo = await ctx.store.getRepo(ctx.tenant, c.req.param("id") ?? "");
    if (!repo) return c.json({ error: "unknown project", code: "not-found" }, 404);
    const allowed = !user.key && !user.id.startsWith("service:") && (localMode() ? manages(user) : canEditTeam(user, repo.team));
    return allowed ? repo : c.json({ error: localMode() ? "only this machine's owner changes what its tasks are given" : `only an owner or an admin, or ${repo.team}'s owner, changes what its tasks are given`, code: "not-allowed" }, 403);
  };

  // What a task in the project can be given, for the task form: the team's skills and the project's own; the person's own come from their machine.
  route(app, "GET /api/projects/:id/task-skills", async (c) => {
    const user = c.get("user");
    const repo = await ctx.store.getRepo(ctx.tenant, c.req.param("id") ?? "");
    if (!repo || !canStartOnTeam(user, repo.team)) return c.json({ error: "unknown project", code: "not-found" }, 404);
    const from = skillSource(repo, (r) => ctx.tasks?.codeTarget(r) ?? null);
    const team = (await teamSkills(ctx, from ? [from] : [])).map(({ name, description }) => ({ name, description }));
    const project = (await readTaskTools(ctx, repo.id)).skillSources.flatMap((source) => source.skills.map((skill) => ({ source: source.id, ...skill })));
    return c.json({ team, project });
  });

  route(app, "GET /api/projects/:id/task-tools", async (c) => {
    const repo = await projectFor(c);
    return repo instanceof Response ? repo : c.json(await readTaskTools(ctx, repo.id));
  });

  route(app, "POST /api/projects/:id/skill-sources", async (c) => {
    const repo = await projectFor(c);
    if (repo instanceof Response) return repo;
    try {
      const source = await addSource(ctx, repo.id, (await c.req.json().catch(() => ({}))) as Record<string, unknown>);
      await recordEvent(ctx, c.get("user"), "project.skills.added", { repoId: repo.id, subject: `repo:${repo.id}`, detail: `added ${source.name} (${source.skills.length} skill(s)) for the tasks in ${repo.name}` });
      return c.json({ source });
    } catch (err) {
      return failed(c, err);
    }
  });

  route(app, "POST /api/projects/:id/skill-sources/:sourceId/refresh", async (c) => {
    const repo = await projectFor(c);
    if (repo instanceof Response) return repo;
    try {
      // A read that fails keeps what was read before: the source and its head stay as they were.
      const source = await changing(ctx, repo.id, async (tools) => {
        const at = tools.skillSources.findIndex((s) => s.id === c.req.param("sourceId"));
        if (at < 0) throw new Refused("not-found", "unknown skill source", 404);
        const read = await readSource(ctx, tools.skillSources[at]!);
        return { tools: { ...tools, skillSources: tools.skillSources.map((s, i) => (i === at ? read : s)) }, result: read };
      });
      return c.json({ source });
    } catch (err) {
      return failed(c, err);
    }
  });

  route(app, "DELETE /api/projects/:id/skill-sources/:sourceId", async (c) => {
    const repo = await projectFor(c);
    if (repo instanceof Response) return repo;
    try {
      const gone = await changing(ctx, repo.id, async (tools) => {
        const source = tools.skillSources.find((s) => s.id === c.req.param("sourceId"));
        if (!source) throw new Refused("not-found", "unknown skill source", 404);
        return { tools: { ...tools, skillSources: tools.skillSources.filter((s) => s !== source) }, result: source };
      });
      if (gone.kind === "git") await rm(skillSourceDir(ctx, gone.id), { recursive: true, force: true });
      await recordEvent(ctx, c.get("user"), "project.skills.removed", { repoId: repo.id, subject: `repo:${repo.id}`, detail: `removed ${gone.name} from the tasks in ${repo.name}` });
      return c.body(null, 204);
    } catch (err) {
      return failed(c, err);
    }
  });

  route(app, "POST /api/projects/:id/mcp-servers", async (c) => {
    const repo = await projectFor(c);
    if (repo instanceof Response) return repo;
    try {
      const server = await addServer(ctx, c.get("user"), repo.id, (await c.req.json().catch(() => ({}))) as Record<string, unknown>);
      await recordEvent(ctx, c.get("user"), "project.mcp.added", { repoId: repo.id, subject: `repo:${repo.id}`, detail: `added the MCP server ${server.name} for the tasks in ${repo.name}` });
      return c.json({ server });
    } catch (err) {
      return failed(c, err);
    }
  });

  route(app, "DELETE /api/projects/:id/mcp-servers/:serverId", async (c) => {
    const repo = await projectFor(c);
    if (repo instanceof Response) return repo;
    try {
      const gone = await changing(ctx, repo.id, async (tools) => {
        const server = tools.mcpServers.find((s) => s.id === c.req.param("serverId"));
        if (!server) throw new Refused("not-found", "unknown MCP server", 404);
        return { tools: { ...tools, mcpServers: tools.mcpServers.filter((s) => s !== server) }, result: server };
      });
      for (const name of gone.transport === "stdio" ? gone.env : gone.headers) await ctx.store.deleteSecret(ctx.tenant, taskMcpSecret(repo.id, gone.id, name));
      await recordEvent(ctx, c.get("user"), "project.mcp.removed", { repoId: repo.id, subject: `repo:${repo.id}`, detail: `removed the MCP server ${gone.name} from the tasks in ${repo.name}` });
      return c.body(null, 204);
    } catch (err) {
      return failed(c, err);
    }
  });

  return app;
}

