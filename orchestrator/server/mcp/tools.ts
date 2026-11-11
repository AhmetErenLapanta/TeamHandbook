import type { OrchestratorContext } from "../app.js";
import { inConfiguration, maskUrl, mirrorDir, NOT_CONFIGURED } from "../app.js";
import { canEditTeam } from "../auth.js";
import type { Principal } from "../auth.js";
import { proposedBranch, teamNaming } from "../branches.js";
import { buildChange, ChangeRefused, prepareChange } from "../changes.js";
import { ForgeRefusal } from "../forge/local.js";
import type { RequestStatus } from "../forge/types.js";
import { gitAsyncMaybe, RepositoryGone } from "../git.js";
import { readInventory } from "../inventory.js";
import { commitMessagePrefix, commitSubject, TEAM_PREFIX_FILE } from "../plugin.js";
import { inRequestTurn, propose, RequestRefused } from "../propose.js";
import { shownProjects } from "../projects.js";
import type { RepoRecord } from "../store.js";
import { allows } from "../keys.js";
import type { Resource } from "../keys.js";
import { startTask } from "../tasks/routes.js";
import { PERMISSION_MODES } from "../../shared/permission-mode.js";

/** A refusal said to the caller as the tool's answer, the way the orchestrator's own screens say it. */
export class ToolRefused extends Error {}

type Schema = Record<string, unknown>;

export interface Tool {
  name: string;
  description: string;
  inputSchema: Schema;
  /** A tool that opens a request or starts a task; offered only to someone who can change a team's repository. */
  writes: boolean;
  /** What an API key's scopes have to give for the tool to be offered and run. */
  needs: [Resource, "read" | "write"];
  run(args: Record<string, unknown>, ctx: OrchestratorContext, user: Principal): Promise<unknown>;
}

const ID = /^[a-z0-9][a-z0-9-]{0,62}$/;
const STATUSES: RequestStatus[] = ["open", "merged", "closed"];
/** What a request from an MCP client may change: skills and MCP servers, never the team's naming or reviewers. */
export const MCP_CHANGE_KINDS = ["skill.add", "skill.edit", "skill.delete", "mcp.add", "mcp.edit", "mcp.remove"];
const LIST_MAX = 50;

const REPO_ARG = { type: "string", description: "The repository's id, as list_repositories gives it." };
const CHANGE_ARG = {
  type: "object",
  description: "One change. skill.add and skill.edit take slug and content (the whole SKILL.md); skill.delete takes slug; mcp.add and mcp.edit take name and config (the server's .mcp.json entry); mcp.remove takes name.",
  properties: {
    kind: { type: "string", enum: MCP_CHANGE_KINDS },
    slug: { type: "string" },
    content: { type: "string" },
    name: { type: "string" },
    config: { type: "object" },
  },
  required: ["kind"],
};

async function repoOf(ctx: OrchestratorContext, args: Record<string, unknown>): Promise<RepoRecord> {
  const id = typeof args.repo === "string" ? args.repo : "";
  const repo = ID.test(id) ? await ctx.store.getRepo(ctx.tenant, id) : null;
  if (!repo) throw new ToolRefused("unknown repository; list_repositories names the ones this orchestrator holds");
  return repo;
}

/** The gate every write passes, the same one the orchestrator's screens use: the team the store records for the repository. */
async function changeable(ctx: OrchestratorContext, args: Record<string, unknown>, user: Principal): Promise<RepoRecord & { head: string }> {
  const repo = await repoOf(ctx, args);
  if (!canEditTeam(user, repo.team)) throw new ToolRefused(`only an admin or an owner of ${repo.team} can change this repository`);
  if (!inConfiguration(ctx, repo.id)) throw new ToolRefused(NOT_CONFIGURED);
  if (!repo.head) throw new ToolRefused("this repository has not been read yet");
  return repo as RepoRecord & { head: string };
}

function change(args: Record<string, unknown>): Record<string, unknown> {
  const given = args.change;
  if (!given || typeof given !== "object" || Array.isArray(given)) throw new ToolRefused("change is one object with a kind");
  const kind = (given as { kind?: unknown }).kind;
  if (typeof kind !== "string" || !MCP_CHANGE_KINDS.includes(kind)) throw new ToolRefused(`change.kind is one of ${MCP_CHANGE_KINDS.join(", ")}`);
  return given as Record<string, unknown>;
}

/** A refusal the orchestrator's own screens would show, as text the caller reads; anything else is the orchestrator's fault and stays a failure. */
export function refusalText(err: unknown): string | null {
  if (err instanceof ToolRefused || err instanceof ChangeRefused || err instanceof RequestRefused || err instanceof ForgeRefusal || err instanceof RepositoryGone) return err.message;
  return null;
}

export const TOOLS: Tool[] = [
  {
    name: "list_repositories",
    description: "The team repositories this orchestrator holds: each one's id, team, name, the commit the orchestrator last read, and whether you can propose changes to it.",
    inputSchema: { type: "object", properties: {} },
    writes: false,
    needs: ["repositories", "read"],
    async run(_args, ctx, user) {
      const repos = await shownProjects(ctx, user, await ctx.store.listRepos(ctx.tenant));
      return {
        repositories: repos.map((r) => ({ id: r.id, team: r.team, name: r.name, head: r.head, syncedAt: r.syncedAt, error: r.error && maskUrl(r.error), youCanChange: canEditTeam(user, r.team) })),
      };
    },
  },
  {
    name: "get_repository",
    description: "What one team repository holds at the commit the orchestrator last read: its skills, MCP servers and commands. The head it returns is the baseSha propose_change takes.",
    inputSchema: { type: "object", properties: { repo: REPO_ARG }, required: ["repo"] },
    writes: false,
    needs: ["repositories", "read"],
    async run(args, ctx) {
      const repo = await repoOf(ctx, args);
      if (!repo.head) throw new ToolRefused("this repository has not been read yet");
      const read = await readInventory(mirrorDir(ctx, repo.id));
      return {
        id: repo.id,
        team: repo.team,
        head: read.head,
        plugin: read.plugin,
        skills: read.skills.map((s) => ({ slug: s.slug, description: s.description })),
        mcpServers: read.mcpServers.map((m) => ({ name: m.name, transport: m.transport, shareable: m.shareable })),
        commands: read.commands.map((c) => ({ name: c.name, description: c.description })),
      };
    },
  },
  {
    name: "list_requests",
    description: `The requests the orchestrator opened on team repositories, newest first, at most ${LIST_MAX}: open ones unless another status is asked for.`,
    inputSchema: { type: "object", properties: { repo: REPO_ARG, status: { type: "string", enum: STATUSES } } },
    writes: false,
    needs: ["requests", "read"],
    async run(args, ctx) {
      const status = args.status ?? "open";
      if (!STATUSES.includes(status as RequestStatus)) throw new ToolRefused(`status is one of ${STATUSES.join(", ")}`);
      const repoId = args.repo === undefined ? undefined : (await repoOf(ctx, args)).id;
      const page = await ctx.store.requestPage(ctx.tenant, { ...(repoId ? { repoId } : {}), status: status as RequestStatus }, null, LIST_MAX);
      return {
        total: page.total,
        requests: page.requests.map((r) => ({ repo: r.repoId, number: r.number, title: r.title, status: r.status, url: r.url, branch: r.branch, openedBy: r.createdBy, openedAt: r.createdAt })),
      };
    },
  },
  {
    name: "list_policies",
    description: "The policies each team file declares at the commit the orchestrator last read: what they deny in every teammate's session. Changing one is a request like any other change.",
    inputSchema: { type: "object", properties: { repo: REPO_ARG } },
    writes: false,
    needs: ["repositories", "read"],
    async run(args, ctx) {
      const repos = args.repo === undefined ? await ctx.store.listRepos(ctx.tenant) : [await repoOf(ctx, args)];
      const read = await Promise.all(
        repos.filter((r) => r.head).map(async (r) => {
          const text = await gitAsyncMaybe(["show", `${r.head}:${TEAM_PREFIX_FILE}`], mirrorDir(ctx, r.id));
          let policies: unknown = [];
          try {
            policies = text === null ? [] : ((JSON.parse(text) as { policies?: unknown }).policies ?? []);
          } catch {
            policies = [];
          }
          return { repo: r.id, team: r.team, policies: Array.isArray(policies) ? policies : [] };
        }),
      );
      return { repositories: read };
    },
  },
  {
    name: "list_my_tasks",
    description: `The agent tasks you started, newest first, at most ${LIST_MAX}, with where each stands and the request it opened.`,
    inputSchema: { type: "object", properties: {} },
    writes: false,
    needs: ["tasks", "read"],
    async run(_args, ctx, user) {
      const { tasks } = await ctx.store.taskPage(ctx.tenant, { createdBy: [user.email] }, null, LIST_MAX);
      return { tasks: tasks.map((t) => ({ id: t.id, repo: t.repoId, title: t.title, status: t.status, createdAt: t.createdAt, finishedAt: t.finishedAt, request: t.requestNumber, error: t.error })) };
    },
  },
  {
    name: "preview_change",
    description: "Checks one change to a skill or an MCP server against the orchestrator's rules without opening anything, and returns the commit message and branch the orchestrator proposes. Show the message to the person and ask them to confirm or rewrite it before propose_change.",
    inputSchema: { type: "object", properties: { repo: REPO_ARG, change: CHANGE_ARG }, required: ["repo", "change"] },
    writes: true,
    needs: ["requests", "write"],
    async run(args, ctx, user) {
      const repo = await changeable(ctx, args, user);
      const mirror = mirrorDir(ctx, repo.id);
      const naming = await teamNaming(mirror, repo.head);
      const built = await buildChange(mirror, repo.head, change(args));
      return { baseSha: repo.head, proposal: commitSubject(commitMessagePrefix(naming.commitPrefix), built.proposal), branch: proposedBranch(built.topic, naming) };
    },
  },
  {
    name: "propose_change",
    description: "Opens a request on the team repository with one change to a skill or an MCP server. The request waits for a person to review and merge it; nothing here merges. message is the commit message the person confirmed; baseSha is the head preview_change returned.",
    inputSchema: {
      type: "object",
      properties: { repo: REPO_ARG, baseSha: { type: "string" }, change: CHANGE_ARG, message: { type: "string" }, branch: { type: "string" } },
      required: ["repo", "baseSha", "change", "message"],
    },
    writes: true,
    needs: ["requests", "write"],
    async run(args, ctx, user) {
      const repo = await changeable(ctx, args, user);
      const asked = change(args);
      // Built against what the caller looked at: a repository that moved since gets a new preview first.
      if (args.baseSha !== repo.head) throw new ToolRefused("the repository changed since that preview; preview the change again");
      const mirror = mirrorDir(ctx, repo.id);
      const request = await inRequestTurn(ctx, repo.id, async () => {
        const prepared = await prepareChange(mirror, repo.head, asked, args.message, user.name, await teamNaming(mirror, repo.head), args.branch);
        return propose(ctx, repo, user, prepared);
      });
      return { request: { repo: request.repoId, number: request.number, title: request.title, status: request.status, url: request.url, branch: request.branch, notes: request.notes ?? [] } };
    },
  },
  {
    name: "start_task",
    description: "Starts an agent task on a team repository. The agent works in its own checkout and the task ends in a request for review; nothing it does merges. issue is an issue's link, or its key when the orchestrator has an issue tracker connected.",
    inputSchema: {
      type: "object",
      properties: { repo: REPO_ARG, title: { type: "string" }, description: { type: "string" }, agent: { type: "string", description: "The agent's id." }, issue: { type: "string" }, mode: { type: "string", enum: [...PERMISSION_MODES], description: "Left out: the most the policies allow, up to auto." } },
      required: ["repo", "agent"],
    },
    writes: true,
    needs: ["tasks", "write"],
    async run(args, ctx, user) {
      if (!ctx.tasks) throw new ToolRefused("this orchestrator runs no tasks");
      const started = await startTask(ctx, ctx.tasks, user, { repoId: args.repo, title: args.title, description: args.description, agent: args.agent, issueUrl: args.issue, mode: args.mode });
      if ("error" in started) throw new ToolRefused(started.error);
      const t = started.task;
      return { task: { id: t.id, repo: t.repoId, title: t.title, status: t.status, agent: t.agent, mode: t.mode } };
    },
  },
];

/**
 * The tools one caller is offered. Everyone reads; the tools that open a request or start a
 * task are offered to someone who can change at least one team's repository, and each call
 * checks the repository it names. A key is offered only what its scopes give. No tool merges or
 * closes a request: that stays a person's act on the orchestrator's screen or the forge.
 */
export async function toolsFor(ctx: OrchestratorContext, user: Principal): Promise<Tool[]> {
  const repos = await ctx.store.listRepos(ctx.tenant);
  const writes = repos.some((r) => canEditTeam(user, r.team));
  // A key reaches no further than its scopes, whatever its account could do in the browser.
  const scoped = (t: Tool) => !user.key || allows(user.key.scopes, t.needs[0], t.needs[1]);
  return TOOLS.filter((t) => (!t.writes || writes) && scoped(t) && (t.name !== "start_task" || ctx.tasks)).map((t) =>
    t.name === "start_task" && ctx.tasks ? { ...t, inputSchema: withAgents(t.inputSchema, ctx.tasks.agents().map((a) => a.id)) } : t,
  );
}

function withAgents(schema: Schema, ids: string[]): Schema {
  const properties = schema.properties as Record<string, Schema>;
  return { ...schema, properties: { ...properties, agent: { ...properties.agent, enum: ids } } };
}

/** What the event log keeps of a call: the tool, its repository and what it names, never the content it carries. */
export function callSummary(name: string, args: Record<string, unknown>): string {
  const parts = [name];
  if (typeof args.repo === "string") parts.push(`on ${args.repo}`);
  const asked = args.change as { kind?: unknown; slug?: unknown; name?: unknown } | undefined;
  if (asked && typeof asked === "object") parts.push(`${String(asked.kind)} ${String(asked.slug ?? asked.name ?? "")}`.trim());
  if (typeof args.title === "string") parts.push(`"${args.title.slice(0, 80)}"`);
  return parts.join(" ");
}
