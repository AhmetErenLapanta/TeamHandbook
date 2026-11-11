import type { OrchestratorContext } from "../app.js";
import { mirrorDir } from "../app.js";
import type { Principal } from "../auth.js";
import { readInventory } from "../inventory.js";
import { canStartOnTeam } from "../tasks/guards.js";
import { taskPhase } from "../tasks/phase.js";
import type { TaskRecord, TaskStatus } from "../tasks/types.js";
import { ToolRefused } from "./tools.js";

/** The agent session a call comes from: the task it runs for, and the person that task runs as. */
export interface AgentSession {
  task: TaskRecord;
  user: Principal;
}

/**
 * What the task runner does for the orchestrator's tools: start a child task of the session's
 * task, cancel one, and say which tasks the session started. A session reads and cancels only
 * its own task and the tasks it delegated, down the tree; every other task is unknown to it.
 */
export interface Orchestrator {
  /** `mode` is the agent's ask; the runner holds the child to the parent's mode and the organization's ceiling. */
  delegate(session: AgentSession, input: { repoId: string; prompt: string; wait: boolean; timeoutSeconds: number; mode?: string }): Promise<{ taskId: string; status: TaskStatus }>;
  cancel(session: AgentSession, taskId: string): Promise<void>;
  family(session: AgentSession): Promise<string[]>;
}

type Schema = Record<string, unknown>;

/** A tool every task's agent is offered through the orchestrator's MCP endpoint; its description is what the model reads, so it is kept short. */
export interface OrchestratorTool {
  name: string;
  description: string;
  inputSchema: Schema;
  run(args: Record<string, unknown>, ctx: OrchestratorContext, session: AgentSession, orchestrator: Orchestrator): Promise<unknown>;
}

const ID = /^[a-z0-9][a-z0-9-]{0,62}$/;
const TASK = /^[a-z][a-z0-9_]{3,63}$/;
const MAX_PROMPT = 8_000;
const MAX_WAIT_SECONDS = 1_800;
const SUGGESTED = 5;

async function familyTask(ctx: OrchestratorContext, session: AgentSession, orchestrator: Orchestrator, given: unknown): Promise<TaskRecord> {
  const id = typeof given === "string" ? given : "";
  const known = id === session.task.id || (TASK.test(id) && (await orchestrator.family(session)).includes(id));
  const task = known ? await ctx.store.getTask(ctx.tenant, id) : null;
  if (!task) throw new ToolRefused("no such task among this task and the ones it delegated");
  return task;
}

async function requestsOf(ctx: OrchestratorContext, task: TaskRecord) {
  const opened = task.targets ? task.targets.filter((t) => t.requestNumber !== null).map((t) => ({ repoId: t.repoId, number: t.requestNumber! })) : task.requestNumber !== null ? [{ repoId: task.repoId, number: task.requestNumber }] : [];
  const found = [];
  for (const { repoId, number } of opened) {
    const r = await ctx.store.getRequest(ctx.tenant, repoId, number);
    if (r) found.push({ repo: repoId, number, status: r.status, url: r.provider === "local" ? null : r.url });
  }
  return found;
}

export const ORCHESTRATOR_TOOLS: OrchestratorTool[] = [
  {
    name: "delegate_task",
    description: "Start a child task on another repository this task's person may start tasks on. The child opens its own request. wait=true returns when it ends or timeout_seconds pass.",
    inputSchema: {
      type: "object",
      properties: {
        repo: { type: "string", description: "The repository's id." },
        prompt: { type: "string", description: "What the child does, on its own." },
        wait: { type: "boolean" },
        timeout_seconds: { type: "integer", minimum: 1, maximum: MAX_WAIT_SECONDS },
        mode: { type: "string", description: "A permission mode no wider than this task's." },
      },
      required: ["repo", "prompt"],
    },
    async run(args, ctx, session, orchestrator) {
      const repoId = typeof args.repo === "string" ? args.repo : "";
      const repo = ID.test(repoId) ? await ctx.store.getRepo(ctx.tenant, repoId) : null;
      // A child runs as the parent's person, so it reaches no repository that person could not start a task on.
      if (!repo || !canStartOnTeam(session.user, repo.team)) throw new ToolRefused("no repository by that id that this task's person may start a task on");
      const prompt = typeof args.prompt === "string" ? args.prompt.trim() : "";
      if (!prompt || prompt.length > MAX_PROMPT) throw new ToolRefused(`the prompt is 1 to ${MAX_PROMPT} characters`);
      const timeout = typeof args.timeout_seconds === "number" && Number.isInteger(args.timeout_seconds) ? Math.min(Math.max(args.timeout_seconds, 1), MAX_WAIT_SECONDS) : 600;
      const mode = typeof args.mode === "string" && /^[a-z][a-z-]{0,39}$/.test(args.mode) ? args.mode : undefined;
      const child = await orchestrator.delegate(session, { repoId: repo.id, prompt, wait: args.wait === true, timeoutSeconds: timeout, ...(mode ? { mode } : {}) });
      return { task: child.taskId, status: child.status };
    },
  },
  {
    name: "task_status",
    description: "Where this task or one it delegated stands: status, phase, repositories and requests.",
    inputSchema: { type: "object", properties: { task: { type: "string", description: "The task's id; this task's own when left out." } } },
    async run(args, ctx, session, orchestrator) {
      const task = await familyTask(ctx, session, orchestrator, args.task ?? session.task.id);
      const requests = await requestsOf(ctx, task);
      const phase = taskPhase(task, (repoId, number) => requests.find((r) => r.repo === repoId && r.number === number)?.status ?? null);
      return { task: task.id, status: task.status, phase, repo: task.repoId, targets: (task.targets ?? []).map((t) => ({ repo: t.repoId, status: t.status })), requests, error: task.error };
    },
  },
  {
    name: "task_cancel",
    description: "Cancel a task this task delegated. This task itself is not cancelled here.",
    inputSchema: { type: "object", properties: { task: { type: "string" } }, required: ["task"] },
    async run(args, ctx, session, orchestrator) {
      const task = await familyTask(ctx, session, orchestrator, args.task);
      if (task.id === session.task.id) throw new ToolRefused("a task does not cancel itself; finish instead");
      await orchestrator.cancel(session, task.id);
      return { task: task.id, cancelled: true };
    },
  },
  {
    name: "request_status",
    description: "A request this task or one it delegated opened: status and address.",
    inputSchema: { type: "object", properties: { repo: { type: "string" }, number: { type: "integer", minimum: 1 } }, required: ["repo", "number"] },
    async run(args, ctx, session, orchestrator) {
      const ids = [session.task.id, ...(await orchestrator.family(session))];
      for (const id of ids) {
        const task = await ctx.store.getTask(ctx.tenant, id);
        const hit = task ? (await requestsOf(ctx, task)).find((r) => r.repo === args.repo && r.number === args.number) : undefined;
        if (hit) return hit;
      }
      throw new ToolRefused("no such request among the ones this task and its delegated tasks opened");
    },
  },
  {
    name: "suggest_skill",
    description: "The team's skills on this task's repository whose name or description matches the words given.",
    inputSchema: { type: "object", properties: { query: { type: "string", description: "A few words of what the skill is for." } }, required: ["query"] },
    async run(args, ctx, session) {
      const words = (typeof args.query === "string" ? args.query : "").toLowerCase().split(/\W+/).filter((w) => w.length > 2).slice(0, 10);
      if (!words.length) throw new ToolRefused("give a few words of what the skill is for");
      const repo = await ctx.store.getRepo(ctx.tenant, session.task.repoId);
      if (!repo) return { skills: [] };
      const { skills } = await readInventory(mirrorDir(ctx, repo.id));
      const scored = skills.map((s) => ({ s, score: words.filter((w) => `${s.name} ${s.description}`.toLowerCase().includes(w)).length })).filter((x) => x.score > 0);
      scored.sort((a, b) => b.score - a.score || a.s.name.localeCompare(b.s.name));
      return { skills: scored.slice(0, SUGGESTED).map(({ s }) => ({ name: s.name, description: s.description })) };
    },
  },
];
