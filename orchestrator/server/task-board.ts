import { Hono } from "hono";
import type { OrchestratorContext } from "./app.js";
import { mirrorDir } from "./app.js";
import type { OrchestratorEnv, Principal } from "./auth.js";
import type { RequestRecord, RequestStatus } from "./forge/types.js";
import { gitAsyncMaybe } from "./git.js";
import { localMode } from "./mode.js";
import { browsesFolders, listFolders, shownProjects } from "./projects.js";
import { route } from "./route-scopes.js";
import { everyTask, visibleTasks } from "./tasks/guards.js";
import { taskPhase } from "./tasks/phase.js";
import type { TaskPhase } from "./tasks/phase.js";
import { machineWaits } from "./tasks/runner.js";
import { taskForge, taskState } from "./tasks/state.js";
import type { TaskForge, TaskState } from "./tasks/state.js";
import type { TaskCost, TaskRecord, TaskStatus } from "./tasks/types.js";

/*
 * The data the Tasks screen and the command palette read in one call each. Tasks groups a
 * person's work by whose turn it is: theirs (a change to review or keep, a question waiting, a
 * task to continue or retry), the agents' (queued or working), done this week, and waiting for a
 * computer; each card carries how big its change is. The palette finds tasks, projects and, on a
 * local orchestrator, folders by name.
 */

export type Turn = "yours" | "agents" | "waiting" | "done";
/** What a task in your turn waits for you to do. */
export type YourTurn = "review" | "answer" | "continue" | "retry" | "follow-up";

export interface BoardCard {
  id: string;
  title: string;
  /** The tracker issue's key it was started from, shown beside the title; null without one. */
  issueKey: string | null;
  repoId: string;
  /** The agent it runs with, by id. */
  agent: string;
  status: TaskStatus;
  phase: TaskPhase;
  /** Where it stands in the one word every screen uses. */
  state: TaskState;
  /** Its change's request on GitLab or GitHub; null while it has none there. */
  forge: TaskForge | null;
  /** In your turn, what it waits for; null in the others. */
  next: YourTurn | null;
  createdBy: string;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  /** In waiting for a computer: none of the starter's is connected, or theirs is away. */
  waitingFor: "connect" | "machine" | null;
  /** Why it failed or stopped, as its page says it; null while it has not. */
  error: string | null;
  /** The size of its change, files and lines; null before there is one or when it cannot be read. */
  changes: { files: number; additions: number; deletions: number } | null;
  request: { repoId: string; number: number; status: RequestStatus; url: string } | null;
  cost: TaskCost;
  /** Why a stopped or failed task ended, in one sentence; null for any other and when the run said nothing. */
  reason: string | null;
}

export interface TaskBoard {
  sections: Record<Turn, BoardCard[]>;
  /** Every task in each section, past the cards shown. */
  counts: Record<Turn, number>;
  /** Per repository, the tasks in the reader's turn and the agents'; a task over several counts in each, as the board for one repository reads it. */
  byRepo: Record<string, { yours: number; agents: number }>;
}

const WEEK_MS = 7 * 86_400_000;
/** How far back a task waiting for its review is still shown: past it, it reads as left. */
const REVIEW_DAYS = 90;
/** The cards one section shows; the count says how many more there are. */
const CARDS_PER_SECTION = 50;
const SEARCH_RESULTS = 8;

const REASON_SHOWN = 160;

/** The first line a run left as its error, cut to a sentence a row holds. */
export function endReason(error: string | null): string | null {
  const first = error?.trim().split("\n")[0]?.trim();
  if (!first) return null;
  return first.length > REASON_SHOWN ? `${first.slice(0, REASON_SHOWN).trimEnd()}…` : first;
}

/** A request task's change as its mirror reads it, from the base it started on to the head its request has; null when either is gone. */
async function requestSize(ctx: OrchestratorContext, repoId: string, base: string | null, head: string): Promise<BoardCard["changes"]> {
  if (!base) return null;
  const mirror = mirrorDir(ctx, repoId);
  const out = await gitAsyncMaybe(["--git-dir", mirror, "diff", "--numstat", "--no-renames", base, head], mirror);
  if (out === null) return null;
  const lines = out.split("\n").filter(Boolean);
  // A binary file shows "-" for its lines: it counts as a file, not as lines.
  const sum = (column: 0 | 1) => lines.reduce((n, line) => n + (Number(line.split("\t")[column]) || 0), 0);
  return { files: lines.length, additions: sum(0), deletions: sum(1) };
}

function changeSize(task: TaskRecord): BoardCard["changes"] {
  const files = task.changes?.files;
  if (!files) return null;
  return { files: files.length, additions: files.reduce((n, f) => n + (f.additions ?? 0), 0), deletions: files.reduce((n, f) => n + (f.deletions ?? 0), 0) };
}

/** The board for one person: the tasks they read, each in the section its next step puts it; with a repository, its tasks alone, as the rail picks it. */
export async function taskBoard(ctx: OrchestratorContext, user: Principal, now = Date.now(), repoId?: string): Promise<TaskBoard> {
  const visible = { ...visibleTasks(user), ...(repoId ? { repoId } : {}) };
  const week = new Date(now - WEEK_MS).toISOString();
  const open = await everyTask(ctx.store, ctx.tenant, { ...visible, statuses: ["queued", "running", "interrupted"] });
  const reviewed = await everyTask(ctx.store, ctx.tenant, { ...visible, statuses: ["needs-review"], finishedSince: new Date(now - REVIEW_DAYS * 86_400_000).toISOString() });
  const ended = await everyTask(ctx.store, ctx.tenant, { ...visible, statuses: ["failed", "cancelled"], finishedSince: week });
  const tasks = [...open, ...reviewed, ...ended];

  const requests = new Map<string, RequestRecord>();
  for (const task of tasks) {
    for (const [repoId, number] of [[task.repoId, task.requestNumber] as const, ...(task.targets ?? []).map((t) => [t.repoId, t.requestNumber] as const)]) {
      if (number === null || requests.has(`${repoId}#${number}`)) continue;
      const request = await ctx.store.getRequest(ctx.tenant, repoId, number);
      if (request) requests.set(`${repoId}#${number}`, request);
    }
  }
  const statusOf = (repoId: string, number: number) => requests.get(`${repoId}#${number}`)?.status ?? null;
  const waits = await machineWaits(ctx, tasks.filter((t) => t.runner === "local" && t.status === "queued").map((t) => t.createdBy), now);
  // A teammate's suggested follow-up waits on the task's starter, on a request still open.
  const suggested = await ctx.store.waitingSuggestionTasks(ctx.tenant, tasks.map((t) => t.id));

  const sections: Record<Turn, BoardCard[]> = { yours: [], agents: [], waiting: [], done: [] };
  const byRepo: TaskBoard["byRepo"] = {};
  for (const task of tasks) {
    const phase = taskPhase(task, statusOf);
    const waitingFor = task.runner === "local" && task.status === "queued" ? (waits.get(task.createdBy) ?? null) : null;
    // A run asks while it works, or a run that stopped asked its starter one question: both wait on their answer.
    const asking = (task.status === "running" && (await ctx.store.taskRequests(ctx.tenant, task.id)).some((r) => r.status === "pending")) || (task.question !== undefined && task.question !== null && !task.question.answer);
    // An interrupted task without a request reads as in review to taskPhase; its next step is to continue.
    const next: YourTurn | null = asking ? "answer" : task.status === "interrupted" ? "continue" : task.status === "failed" ? "retry" : suggested.has(task.id) ? "follow-up" : phase === "review" ? "review" : null;
    // A teammate's task that waits on them is their turn, not the reader's: it stays off the board and in the full list.
    if (next && task.createdBy !== user.email && task.createdBy !== user.id) continue;
    const turn: Turn | null = waitingFor ? "waiting" : next ? "yours" : task.status === "queued" || task.status === "running" ? "agents" : phase === "merged" || phase === "failed" ? (task.finishedAt && task.finishedAt >= week ? "done" : null) : null;
    if (!turn) continue;
    if (turn === "yours" || turn === "agents") {
      for (const repoId of new Set([task.repoId, ...(task.targets ?? []).map((t) => t.repoId)])) (byRepo[repoId] ??= { yours: 0, agents: 0 })[turn]++;
    }
    const request = task.requestNumber !== null ? requests.get(`${task.repoId}#${task.requestNumber}`) : undefined;
    sections[turn].push({
      id: task.id,
      title: task.title,
      issueKey: task.issueKey,
      repoId: task.repoId,
      agent: task.agent,
      status: task.status,
      phase,
      state: taskState(task, (repoId, number) => requests.get(`${repoId}#${number}`), waitingFor, asking && task.status === "running"),
      forge: taskForge(task, (repoId, number) => requests.get(`${repoId}#${number}`)),
      next: turn === "yours" ? next : null,
      createdBy: task.createdBy,
      createdAt: task.createdAt,
      startedAt: task.startedAt,
      finishedAt: task.finishedAt,
      waitingFor,
      error: task.error,
      changes: null,
      request: request ? { repoId: request.repoId, number: request.number, status: request.status, url: request.url } : null,
      cost: task.cost,
      reason: task.status === "failed" || task.status === "interrupted" ? endReason(task.error) : null,
    });
  }

  const counts = { yours: sections.yours.length, agents: sections.agents.length, waiting: sections.waiting.length, done: sections.done.length };
  const byId = new Map(tasks.map((t) => [t.id, t]));
  for (const turn of Object.keys(sections) as Turn[]) {
    sections[turn].sort((a, b) => (b.finishedAt ?? b.createdAt).localeCompare(a.finishedAt ?? a.createdAt));
    sections[turn] = sections[turn].slice(0, CARDS_PER_SECTION);
    // A change is read only for the cards shown, and only where there is one: a review, a retry with what it made, or work done.
    for (const card of sections[turn]) {
      const task = byId.get(card.id)!;
      card.changes = changeSize(task) ?? (card.request ? await requestSize(ctx, card.request.repoId, task.baseSha, requests.get(`${card.request.repoId}#${card.request.number}`)!.headSha) : null);
    }
  }
  return { sections, counts, byRepo };
}

/** What the palette finds by name: the tasks the person reads, the projects, and on a local orchestrator its owner's folders of this machine. */
export async function search(ctx: OrchestratorContext, user: Principal, q: string, home?: string) {
  const words = q.trim().toLowerCase();
  const tasks = (await ctx.store.taskPage(ctx.tenant, { ...visibleTasks(user), titleHas: words }, null, SEARCH_RESULTS)).tasks.map((t) => ({ id: t.id, title: t.title, repoId: t.repoId, status: t.status }));
  const projects = (await shownProjects(ctx, user, await ctx.store.listRepos(ctx.tenant)))
    .filter((r) => r.name.toLowerCase().includes(words) || r.id.includes(words))
    .slice(0, SEARCH_RESULTS)
    .map((r) => ({ id: r.id, name: r.name }));
  // The folder picker's own rule: another account on this machine never reads its owner's folder names.
  const listed = localMode() && browsesFolders(user) ? await listFolders(undefined, words, { ...(home ? { home } : {}), dataDir: ctx.dataDir }) : null;
  const folders = listed && !("refused" in listed) ? (listed.matches ?? []).slice(0, SEARCH_RESULTS).map((f) => ({ name: f.name, path: f.path })) : [];
  return { tasks, projects, folders };
}

export function taskBoardRoutes(ctx: OrchestratorContext): Hono<OrchestratorEnv> {
  const app = new Hono<OrchestratorEnv>();
  route(app, "GET /api/tasks/board", async (c) => c.json(await taskBoard(ctx, c.get("user"), Date.now(), c.req.query("repo") || undefined)));
  route(app, "GET /api/search", async (c) => {
    const q = c.req.query("q") ?? "";
    if (q.trim().length < 1 || q.length > 100) return c.json({ error: "search with 1 to 100 characters", code: "bad-search" }, 400);
    return c.json(await search(ctx, c.get("user"), q));
  });
  return app;
}
