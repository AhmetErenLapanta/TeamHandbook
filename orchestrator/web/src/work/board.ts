import { stateOf, stateSaid } from "../task-state";
import type { Tone } from "../design/tone";
import type { WorkColumn, WorkItem, WorkItems, WorkTaskLink } from "./api";

export interface PlacedColumn { name: string; items: WorkItem[] }

const BY_CATEGORY: { name: string; category: WorkItem["status"]["category"] }[] = [
  { name: "To do", category: "todo" },
  { name: "In progress", category: "doing" },
  { name: "Done", category: "done" },
];

/**
 * The board as the team's tracker draws it: each issue in the column the server placed it in. A
 * tracker that names no columns gets the three every status falls into, and an issue no column
 * holds goes to Other rather than out of sight.
 */
export function placeItems(columns: WorkColumn[], items: WorkItem[]): PlacedColumn[] {
  if (!columns.length) return BY_CATEGORY.map((c) => ({ name: c.name, items: items.filter((i) => i.status.category === c.category) }));
  const placed = columns.map((c) => ({ name: c.name, items: [] as WorkItem[] }));
  const other: WorkItem[] = [];
  for (const item of items) (placed.find((c) => c.name === item.column)?.items ?? other).push(item);
  return [...placed, ...(other.length ? [{ name: "Other", items: other }] : [])];
}

export interface SprintSummary { done: number; total: number; openRequests: number; blocked: number; costUsd: number | null; costPartial: boolean; /** The forge every open request is on, when it is one: GitLab or GitHub. */ reviewOn: string | null }

/** The sprint header's line: what is done, the requests waiting on a reviewer, what is blocked, and what its agents cost. */
export function sprintSummary(read: WorkItems): SprintSummary {
  const open = new Set<string>();
  const forges = new Set<string>();
  let cost: number | null = null;
  let costPartial = false;
  for (const item of read.items) {
    for (const task of item.tasks) {
      for (const r of task.requests) {
        if (r.status !== "open") continue;
        open.add(`${r.repoId}#${r.number}`);
        forges.add(r.url ? (/ on (GitLab|GitHub)$/.exec(r.name)?.[1] ?? "") : "");
      }
      if (task.costUsd === null) costPartial = true;
      else cost = (cost ?? 0) + task.costUsd;
    }
  }
  const { todo, doing, done } = read.progress;
  return { done, total: todo + doing + done, openRequests: open.size, blocked: read.items.filter((i) => i.blocked).length, costUsd: cost, costPartial: costPartial && cost !== null, reviewOn: forges.size === 1 && [...forges][0] ? [...forges][0]! : null };
}

/**
 * The badge for a task on a card: the one word every list says it in. A request on a forge makes it
 * in review or merged; one kept on this machine, which opens no request, is kept.
 */
export function taskBadge(task: WorkTaskLink): { label: string; tone: Tone } {
  const first = task.requests[0];
  const named = first?.name.match(/ on (GitLab|GitHub)$/);
  const forge = first?.url && named ? { kind: named[1]!.toLowerCase(), number: first.number, url: first.url } : null;
  const state = stateOf({ status: task.status, ...(task.phase ? { phase: task.phase } : {}), result: task.result ?? null, request: first ? { status: first.status, provider: first.url ? "forge" : "local" } : null });
  const { word, tone } = stateSaid(state, forge);
  return { label: word, tone };
}

/**
 * Whether an issue is the person's own work: assigned to them, or carrying a task they started.
 * The assignee is theirs when the server says so; until it does, when the tracker's name for the
 * assignee is their orchestrator name.
 */
export function isMine(item: WorkItem, me: { name: string; email: string }): boolean {
  const you = (item.assignee as { you?: boolean } | null)?.you;
  const assigned = you ?? (item.assignee !== null && item.assignee.name.trim().toLowerCase() === me.name.trim().toLowerCase());
  return assigned || item.tasks.some((t) => t.startedBy === me.email);
}

/** How Jira ranks priorities, highest first; one it does not name sorts after these. */
const PRIORITY = ["highest", "critical", "blocker", "high", "medium", "low", "lowest"];

/**
 * The issue to start next: one waiting to be done that no agent has touched, the person's own
 * before anyone's, then by priority, then in the board's own order. Null when every waiting issue
 * already has an agent or the board has none waiting.
 */
export function nextIssue(read: WorkItems, me: { name: string; email: string }): WorkItem | null {
  const waiting = read.items.filter((i) => i.status.category === "todo" && !i.tasks.length && !i.blocked);
  const rank = (i: WorkItem) => {
    const p = PRIORITY.indexOf((i.priority ?? "").toLowerCase());
    return p < 0 ? PRIORITY.length : p;
  };
  return [...waiting].sort((a, b) => Number(isMine(b, me)) - Number(isMine(a, me)) || rank(a) - rank(b))[0] ?? null;
}

/**
 * The board as a morning note to paste into a team's channel: where the sprint stands, what is in
 * review, what agents are at work on, what is blocked, and what to start next, one issue a line.
 */
export function morningSummary(title: string, read: WorkItems, me: { name: string; email: string }): string {
  const line = (i: WorkItem) => `- ${i.key} ${i.summary}`;
  const s = sprintSummary(read);
  const p = read.progress;
  const inReview = read.items.filter((i) => i.tasks[0]?.requests.some((r) => r.status === "open"));
  const working = read.items.filter((i) => i.tasks[0] && ["queued", "running"].includes(i.tasks[0].status));
  const blocked = read.items.filter((i) => i.blocked);
  const next = nextIssue(read, me);
  return [
    `${title}: ${p.done} of ${s.total} done${p.points ? `, ${p.points.done} of ${p.points.total} points` : ""}, ${p.doing} in progress, ${p.todo} to do.`,
    ...(inReview.length ? ["", "In review:", ...inReview.map(line)] : []),
    ...(working.length ? ["", "Agents at work on:", ...working.map(line)] : []),
    ...(blocked.length ? ["", "Blocked:", ...blocked.map(line)] : []),
    ...(next ? ["", "Next up:", line(next)] : []),
  ].join("\n");
}

