import { call } from "./api";
import type { RequestStatus, TaskCost, TaskStatus } from "./api";
import type { TaskPhase } from "../../shared/work";
import { stateOf, stateSaid } from "./task-state";
import type { TaskForge, TaskState } from "./task-state";

/**
 * As EK14-veri-sozlesme.md has them: a person's tasks cut by whose move it is, in one read. Your
 * turn holds only the reader's own; a teammate's task waiting on them stays in the full list.
 */
export type Turn = "yours" | "agents" | "waiting" | "done";
export type YourTurn = "review" | "answer" | "continue" | "retry" | "follow-up";
export interface BoardCard {
  id: string; title: string; repoId: string; status: TaskStatus; phase: TaskPhase; next: YourTurn | null;
  createdBy: string; createdAt: string; finishedAt: string | null; waitingFor: "connect" | "machine" | "limit" | null;
  changes: { files: number; additions: number; deletions: number } | null;
  request: { repoId: string; number: number; status: RequestStatus; url: string } | null;
  cost: TaskCost;
  state?: TaskState; forge?: TaskForge | null;
  agent: string; startedAt: string | null; issueKey: string | null;
  reason?: string | null;
}
/** `byRepo`: each repository's tasks waiting on the reader and at work, for the rail; a task over several counts in each. */
export interface TaskBoard { sections: Record<Turn, BoardCard[]>; counts: Record<Turn, number>; byRepo?: Record<string, { yours: number; agents: number }> }

/** The board, or one repository's part of it (a task over several is in each of them). */
export const boardApi = { read: (repoId: string | null = null) => call<TaskBoard>("GET", `/api/tasks/board${repoId ? `?${new URLSearchParams({ repo: repoId })}` : ""}`) };

/** A card's state in the one word every list says it in, and the tone it is drawn in. */
export function cardState(card: Pick<BoardCard, "status" | "phase" | "next" | "waitingFor" | "request" | "state" | "forge">): { label: string; tone: string; state: TaskState } {
  const state = stateOf({ ...card, request: card.request ? { status: card.request.status } : null });
  const { word, tone } = stateSaid(state, card.forge);
  return { label: word, tone, state };
}

// The calls the task page marks as seen, by what a card waits for; a task to continue was never marked.
const SEEN_AS: Record<YourTurn, string[]> = { review: ["review"], answer: ["approval", "answer"], retry: ["failed"], continue: [], "follow-up": ["follow-up"] };

/** Whether what a card waits for has not been seen on its page yet. */
export function cardUnread(card: Pick<BoardCard, "id" | "next">, seen: Set<string>): boolean {
  const keys = card.next ? SEEN_AS[card.next] : [];
  return keys.length > 0 && !keys.some((k) => seen.has(`${card.id}:${k}`));
}

/** The Tasks page's one sentence, from the counts alone: the cards are cut at fifty a section. */
/**
 * The day at a glance, one sentence: what waits on the person, what runs, and what was kept this
 * week with what it cost. A part that is zero is not said; nothing at all says nothing.
 */
export function daySentence(board: Pick<TaskBoard, "sections" | "counts">): string | null {
  const kept = board.sections.done.filter((c) => c.phase === "merged");
  const spent = kept.reduce((sum, c) => sum + (c.cost.usd ?? 0), 0);
  const now = [
    board.counts.yours ? `${board.counts.yours} ${board.counts.yours === 1 ? "waits" : "wait"} on you` : null,
    board.counts.agents ? `${board.counts.agents} ${board.counts.agents === 1 ? "is" : "are"} working` : null,
    board.counts.waiting ? `${board.counts.waiting} ${board.counts.waiting === 1 ? "waits" : "wait"} for a computer` : null,
  ].filter(Boolean).join(", ");
  const week = kept.length ? `${kept.length} kept this week${spent > 0 ? ` for $${spent.toFixed(2)}` : ""}` : null;
  const said = [now || null, week].filter(Boolean).join("; ");
  return said ? `${said.charAt(0).toUpperCase()}${said.slice(1)}.` : null;
}

/** When a card last moved, short: the time today, "Yesterday", else the weekday or the date. */
export function whenShort(at: string, now: Date = new Date()): string {
  const day = new Date(at);
  const startOf = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((startOf(now) - startOf(day)) / 86_400_000);
  if (days <= 0) return day.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  if (days === 1) return "Yesterday";
  if (days < 7) return day.toLocaleDateString(undefined, { weekday: "short" });
  return day.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
