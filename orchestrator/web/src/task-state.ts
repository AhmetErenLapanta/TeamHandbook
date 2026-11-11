import { FORGES, isHostedForge } from "../../shared/forge-def";
import type { Tone } from "./design/tone";

/** Where a task stands, the one sequence every list, head and card says in the same word. */
export type TaskState =
  | "waiting"
  | "working"
  | "usage-limit"
  | "waiting-machine"
  | "needs-you"
  | "kept"
  | "in-review"
  | "merged"
  | "undone"
  | "failed"
  | "stopped";

export interface TaskForge { kind: string; number: number; url: string }

const WORDS: Record<TaskState, string> = {
  waiting: "waiting its turn",
  working: "working",
  "usage-limit": "at the usage limit",
  "waiting-machine": "waiting for your machine",
  "needs-you": "needs you",
  kept: "kept on this machine",
  "in-review": "in review",
  merged: "merged",
  undone: "undone",
  failed: "failed",
  stopped: "stopped",
};

const TONES: Record<TaskState, Tone> = {
  waiting: "neutral",
  working: "info",
  "usage-limit": "warn",
  "waiting-machine": "warn",
  "needs-you": "warn",
  kept: "ok",
  "in-review": "info",
  merged: "ok",
  undone: "neutral",
  failed: "error",
  stopped: "neutral",
};

/** A state as the word it is said in and the tone it is drawn in; one in review on a forge names the forge. */
export function stateSaid(state: TaskState, forge: TaskForge | null | undefined): { word: string; tone: Tone } {
  const label = state === "in-review" && forge && isHostedForge(forge.kind) ? ` on ${FORGES[forge.kind].label}` : "";
  return { word: `${WORDS[state]}${label}`, tone: TONES[state] };
}

/** What a task or a board card holds that its state can be read from, when the orchestrator did not say it. */
export interface StateSource {
  state?: TaskState;
  status: string;
  phase?: string;
  waitingFor?: "connect" | "machine" | "limit" | "sign-in" | null;
  result?: "request" | "changes" | null;
  next?: string | null;
  question?: { answer?: string } | null;
  attention?: string | null;
  changes?: { undone?: unknown; kept?: unknown } | { files: number } | null;
  request?: { status: string; provider?: string } | null;
  /** What the agent asked while it ran: a plan, a question or a permission still waiting on its person. */
  requests?: { status: string; responseCapability?: string }[];
}

/**
 * The orchestrator's own word for where a task stands. A record from before it said so is read from
 * the same facts the orchestrator reads them from, so a list never mixes two languages.
 */
export function stateOf(task: StateSource): TaskState {
  if (task.state) return task.state;
  if (task.next === "answer" || task.next === "review" || task.next === "follow-up" || task.attention) return "needs-you";
  if (task.status === "failed" && task.question && !task.question.answer) return "needs-you";
  if (task.requests?.some((r) => r.status === "pending" && r.responseCapability === "live")) return "needs-you";
  if (task.waitingFor === "limit") return "usage-limit";
  if (task.waitingFor) return "waiting-machine";
  if (task.status === "queued") return "waiting";
  if (task.status === "running") return "working";
  if (task.status === "cancelled" || task.status === "interrupted" || task.next === "continue") return "stopped";
  if (task.status === "failed" || task.next === "retry") return "failed";
  const changes = task.changes as { undone?: unknown; kept?: unknown } | null | undefined;
  if (changes?.undone || task.request?.status === "closed") return "undone";
  if (task.request?.status === "merged") return task.request.provider === "local" ? "kept" : "merged";
  if (changes?.kept || task.phase === "merged") return task.request && task.request.provider !== "local" ? "merged" : "kept";
  if (task.phase === "failed") return "undone";
  if (task.request?.status === "open" && task.request.provider !== "local" && task.request.provider !== undefined) return "in-review";
  return "needs-you";
}
