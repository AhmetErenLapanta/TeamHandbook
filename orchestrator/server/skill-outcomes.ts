import { Hono } from "hono";
import type { OrchestratorContext } from "./app.js";
import { mirrorDir } from "./app.js";
import type { OrchestratorEnv, Principal } from "./auth.js";
import type { RequestStatus } from "./forge/types.js";
import { gitAsyncMaybe } from "./git.js";
import { route } from "./route-scopes.js";
import { SKILL_SLUG } from "./skill-rules.js";
import { everyTask, visibleTasks } from "./tasks/guards.js";
import type { TaskRecord } from "./tasks/types.js";

/*
 * Whether a skill changed how its tasks end: tasks started with it against tasks started
 * without it over the same window and the same projects, and the same projects before the
 * skill existed. Only decided tasks count, and the answer carries the skill's name and numbers,
 * never a project, branch, commit or path.
 */

export interface OutcomeBucket {
  tasks: number;
  accepted: number;
  acceptedWithoutRevision: number;
  revisionRoundsMedian: number | null;
  rejected: number;
  rates: { withoutRevision: number | null; rejected: number | null };
}

export interface SkillOutcomes {
  skill: string;
  pivot: string | null;
  minimum: number;
  before: OutcomeBucket;
  with: OutcomeBucket;
  without: OutcomeBucket;
}

/** Below this many tasks a bucket's rates are null: a rate over a handful of tasks reads as a finding it is not. */
export const OUTCOME_MINIMUM = 5;
const DAY_MS = 86_400_000;
const LESSONS_PREFIX = "task.lessons.";

type Decision = "accepted" | "rejected";

/** How a task ended once its person decided; null while the decision waits or when it made nothing to decide on. */
function decisionOf(task: TaskRecord, requestStatus: (repoId: string, number: number) => RequestStatus | null): Decision | null {
  if (task.status !== "needs-review") return null;
  if (task.result === "changes") return task.changes?.kept ? "accepted" : task.changes?.undone ? "rejected" : null;
  const numbers = task.targets ? task.targets.flatMap((t) => (t.requestNumber !== null ? [[t.repoId, t.requestNumber] as const] : [])) : task.requestNumber !== null ? [[task.repoId, task.requestNumber] as const] : [];
  const statuses = numbers.map(([repoId, number]) => requestStatus(repoId, number));
  if (statuses.includes("closed")) return "rejected";
  return statuses.length && statuses.every((s) => s === "merged") ? "accepted" : null;
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function bucketOf(decided: { decision: Decision; rounds: number }[]): OutcomeBucket {
  const tasks = decided.length;
  const accepted = decided.filter((d) => d.decision === "accepted");
  const acceptedWithoutRevision = accepted.filter((d) => d.rounds === 0).length;
  const rejected = decided.length - accepted.length;
  const rate = (n: number) => (tasks < OUTCOME_MINIMUM ? null : n / tasks);
  return { tasks, accepted: accepted.length, acceptedWithoutRevision, revisionRoundsMedian: median(decided.map((d) => d.rounds)), rejected, rates: { withoutRevision: rate(acceptedWithoutRevision), rejected: rate(rejected) } };
}

// Started with it, or the agent called it: a lesson kept as the person's own skill is never picked at a start, only called.
const usesSkill = (task: TaskRecord, skill: string) => !!task.skills?.includes(skill) || !!task.tools?.skills.some((s) => s.name === skill) || !!task.usedSkills?.includes(skill);

/** Where the skill came from: kept from lesson candidates of these tasks, or added to a team repository; null when neither is known. */
type Pivot = { at: string; lessonTasks: string[] } | { at: string; lessonTasks: null } | null;

/**
 * When the skill came to be: the moment its person kept the lesson it grew from, else the
 * first commit that added it to a team repository the orchestrator mirrors.
 */
async function pivotOf(ctx: OrchestratorContext, skill: string): Promise<Pivot> {
  const approvals: string[] = [];
  const lessonTasks: string[] = [];
  for (const row of await ctx.store.listSettings(ctx.tenant, LESSONS_PREFIX)) {
    // A row that does not read as the lesson marker is skipped rather than guessed at.
    let marker: { candidates?: unknown } | null = null;
    try {
      marker = JSON.parse(row.value) as { candidates?: unknown };
    } catch {
      marker = null;
    }
    if (!marker || !Array.isArray(marker.candidates)) continue;
    for (const candidate of marker.candidates as { slug?: unknown; keptAt?: unknown }[]) {
      if (candidate?.slug !== skill || typeof candidate.keptAt !== "string" || Number.isNaN(Date.parse(candidate.keptAt))) continue;
      approvals.push(new Date(candidate.keptAt).toISOString());
      lessonTasks.push(row.key.slice(LESSONS_PREFIX.length));
    }
  }
  if (approvals.length) return { at: approvals.sort()[0]!, lessonTasks };
  const added: string[] = [];
  for (const repo of await ctx.store.listRepos(ctx.tenant)) {
    if (!repo.head) continue;
    const mirror = mirrorDir(ctx, repo.id);
    const out = await gitAsyncMaybe(["--git-dir", mirror, "log", "--diff-filter=A", "--format=%cI", repo.head, "--", `skills/${skill}/SKILL.md`], mirror);
    added.push(...(out ?? "").split("\n").filter(Boolean));
  }
  return added.length ? { at: added.map((at) => new Date(at).toISOString()).sort()[0]!, lessonTasks: null } : null;
}

export async function skillOutcomes(ctx: OrchestratorContext, user: Principal, skill: string, days: number, now = Date.now()): Promise<SkillOutcomes> {
  const pivot = await pivotOf(ctx, skill);
  const span = days * DAY_MS;
  const start = pivot ? Date.parse(pivot.at) : now - span;
  const end = Math.min(start + span, now);
  const earliest = pivot ? start - span : start;
  const tasks = (await everyTask(ctx.store, ctx.tenant, { ...visibleTasks(user), since: new Date(earliest).toISOString() })).filter((t) => !t.parentId && Date.parse(t.createdAt) < end);

  const requests = new Map((await ctx.store.listRequests(ctx.tenant)).map((r) => [`${r.repoId}#${r.number}`, r.status]));
  const statusOf = (repoId: string, number: number) => requests.get(`${repoId}#${number}`) ?? null;
  const decided = tasks.flatMap((task) => {
    const decision = decisionOf(task, statusOf);
    return decision ? [{ task, decision }] : [];
  });
  const rounds = await ctx.store.deliveredFollowUpCounts(ctx.tenant, decided.map((d) => d.task.id), ["person", "watch"]);
  const scored = decided.map((d) => ({ ...d, rounds: rounds.get(d.task.id) ?? 0, at: Date.parse(d.task.createdAt) }));

  const after = scored.filter((d) => d.at >= start);
  let withSkill: typeof scored;
  let projects: Set<string>;
  if (pivot?.lessonTasks) {
    // A kept lesson is a personal skill: no task picks it at start, every task its person runs loads it.
    // So it is with the skill when the person who kept it started it, on the projects the lessons came from.
    const sources = (await Promise.all(pivot.lessonTasks.map((id) => ctx.store.getTask(ctx.tenant, id)))).filter((t) => t !== null);
    const keepers = new Set(sources.map((t) => t.createdBy));
    projects = new Set(sources.map((t) => t.repoId));
    withSkill = after.filter((d) => keepers.has(d.task.createdBy) && projects.has(d.task.repoId));
  } else {
    withSkill = after.filter((d) => usesSkill(d.task, skill));
    // The projects the skill was used on bound both comparisons, so a project it never reached does not weigh on either side.
    projects = new Set(withSkill.map((d) => d.task.repoId));
  }
  const chosen = new Set(withSkill);
  return {
    skill,
    pivot: pivot?.at ?? null,
    minimum: OUTCOME_MINIMUM,
    before: bucketOf(pivot ? scored.filter((d) => d.at < start && projects.has(d.task.repoId)) : []),
    with: bucketOf(withSkill),
    without: bucketOf(after.filter((d) => !chosen.has(d) && projects.has(d.task.repoId))),
  };
}

export function skillOutcomeRoutes(ctx: OrchestratorContext): Hono<OrchestratorEnv> {
  const app = new Hono<OrchestratorEnv>();
  route(app, "GET /api/skills/:name/outcomes", async (c) => {
    const skill = c.req.param("name") ?? "";
    if (!SKILL_SLUG.test(skill)) return c.json({ error: "a skill name is lowercase letters, digits and dashes", code: "bad-skill" }, 400);
    const given = c.req.query("days");
    const days = given === undefined ? 30 : Number(given);
    if (!Number.isInteger(days) || days < 7 || days > 90) return c.json({ error: "days is a whole number from 7 to 90", code: "bad-days" }, 400);
    return c.json(await skillOutcomes(ctx, c.get("user"), skill, days));
  });
  return app;
}
