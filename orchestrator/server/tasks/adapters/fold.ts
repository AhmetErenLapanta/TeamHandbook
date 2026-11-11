import type { TaskCost } from "../types.js";
import type { AgentDecoder, AgentEvent, AgentFailure, AgentTerminal } from "./contract.js";
import { MAX_REFUSED } from "./frames.js";

export interface RefusedCall {
  tool: string;
  target: string | null;
}

export interface AgentReport {
  ok: boolean;
  /** The agent's closing words, if it wrote any. Shown and quoted as data only. */
  summary: string;
  cost: TaskCost;
  /** Calls the agent made and was refused, as its own output reports them: the tool and what it was aimed at. Data, never instructions. */
  denied?: RefusedCall[];
  failure?: AgentFailure;
}

/** An event as one log line, or null for an event the log does not show. */
export function logText(event: AgentEvent): string | null {
  switch (event.type) {
    case "message":
    case "output":
    case "notice":
      return event.text;
    case "tool_call":
      return event.status === "started" ? `tool ${event.tool}${event.target ? ` ${event.target}` : ""}` : null;
    case "request":
      return `waiting for a decision: ${event.request.tool} ${event.request.summary}`;
    case "turn_finished":
      // A turn the agent gives no reason for has nothing to say beyond its summary, which the report carries.
      return event.reason === null ? null : `agent finished: ${event.reason}, ${event.turns ?? "?"} turns`;
    case "error":
      return `agent error: ${event.failure.message}${event.failure.detail ? ` ${event.failure.detail}` : ""}`;
    default:
      return null;
  }
}

/** One stdout line as the log shows it: the line's events joined, or null when none shows. */
export function logLineOf(decoder: AgentDecoder, line: string): string | null {
  const parts = decoder.decode(line).flatMap((e) => logText(e) ?? []);
  return parts.length ? parts.join(" · ") : null;
}

/** A part of the cost stays unknown unless some event reported it; known parts add up. */
function addCost(total: TaskCost, more: TaskCost): TaskCost {
  const add = (a: number | null, b: number | null) => (a === null ? b : b === null ? a : a + b);
  return { usd: add(total.usd, more.usd), inputTokens: add(total.inputTokens, more.inputTokens), outputTokens: add(total.outputTokens, more.outputTokens) };
}

export function foldRun(events: readonly AgentEvent[], terminal: AgentTerminal): AgentReport {
  let cost: TaskCost = { usd: null, inputTokens: null, outputTokens: null };
  const denied: RefusedCall[] = [];
  for (const e of events) {
    if (e.type === "usage") cost = addCost(cost, e.cost);
    if (e.type === "tool_call" && e.status === "refused" && denied.length < MAX_REFUSED) denied.push({ tool: e.tool, target: e.target });
  }
  return { ok: terminal.status === "completed", summary: terminal.summary, cost, ...(denied.length ? { denied } : {}), ...(terminal.failure ? { failure: terminal.failure } : {}) };
}

/** A finished session's events, its terminal last: the one fold every run's report comes from. */
export function foldSession(events: readonly AgentEvent[]): AgentReport {
  const terminal = [...events].reverse().find((e): e is AgentTerminal => e.type === "terminal");
  return foldRun(events, terminal ?? { type: "terminal", status: "failed", summary: "" });
}

/** A finished run's whole stdout, read by a fresh decoder. */
export function foldStdout(decoder: AgentDecoder, stdout: string, exitCode: number | null): AgentReport {
  return foldSession([...stdout.split("\n").flatMap((line) => decoder.decode(line)), decoder.finish(exitCode)]);
}
