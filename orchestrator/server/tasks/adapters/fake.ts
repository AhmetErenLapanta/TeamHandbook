import type { AgentCapabilities, AgentCodec, AgentDecoder, AgentEvent } from "./contract.js";
import { editOf, inFolder, outputLine, parseLine, refusedCalls, todosOf } from "./frames.js";

export const FAKE_CAPABILITIES: AgentCapabilities = {
  mcp: false,
  runsAsYou: true,
  resume: false,
  steer: false,
  approvals: false,
  questions: false,
  fork: false,
  rollback: false,
  usage: false,
  plan: false,
  permissionModes: ["auto"],
  options: [],
  pendingRequestsSurviveRestart: false,
};

const CALL_STATES = new Set(["started", "done", "failed"]);

/**
 * What the stand-in does as the live view shows it, in the contract's own shapes, rebuilt from
 * their known fields: a call by its id, a command's output, a file it wrote (named inside the
 * task's folder, its lines counted from its patch), its to-do list in an agent's own states, and
 * the turn's cost so far as `{"type":"spend","usd":n}`, dropped unless n is a finite count of dollars.
 */
function liveEvents(frame: Record<string, unknown>, work: string | undefined): AgentEvent[] {
  const id = typeof frame.id === "string" && frame.id ? frame.id : null;
  if (frame.type === "tool_call" && id && typeof frame.tool === "string" && CALL_STATES.has(frame.status as string)) {
    return [{ type: "tool_call", id, tool: frame.tool, target: typeof frame.target === "string" ? frame.target : null, ...(typeof frame.command === "string" ? { command: frame.command } : {}), status: frame.status as "started" | "done" | "failed" }];
  }
  if (frame.type === "tool_output" && id && Array.isArray(frame.lines)) return [{ type: "tool_output", id, lines: frame.lines.filter((l): l is string => typeof l === "string") }];
  if (frame.type === "edit" && id && typeof frame.patch === "string") return editOf(id, inFolder(work, frame.path), frame.patch);
  if (frame.type === "todos") return todosOf(frame.todos);
  if (frame.type === "spend" && typeof frame.usd === "number" && Number.isFinite(frame.usd) && frame.usd >= 0) return [{ type: "spend", usd: frame.usd }];
  return [];
}

/**
 * The stand-in's JSON lines: `log` lines for the log, its calls, output, edits and to-do list for
 * the live view, and one `result` line with its summary and the calls it was told it was refused.
 */
export function fakeDecoder(work?: string): AgentDecoder {
  let summary: string | null = null;
  return {
    decode(line) {
      const frame = parseLine(line);
      if (!frame) return outputLine(line);
      if (frame.type === "log" && typeof frame.text === "string") return [{ type: "message", text: frame.text }];
      const live = liveEvents(frame, work);
      if (live.length) return live;
      if (frame.type !== "result") return [];
      summary = typeof frame.summary === "string" ? frame.summary : "";
      return [...refusedCalls(frame.denied, (e) => e.tool, (e) => e.target), { type: "turn_finished", ok: true, summary, reason: null, turns: null }];
    },
    finish(exitCode) {
      return { type: "terminal", status: exitCode === 0 && summary !== null ? "completed" : "failed", summary: summary ?? "" };
    },
  };
}

/** The stand-in's two-way session: in a mode that asks it asks when its message tells it to, and it takes no message while in a turn. */
export const FAKE_TWO_WAY_CAPABILITIES: AgentCapabilities = { ...FAKE_CAPABILITIES, approvals: true, permissionModes: ["approval-required", "auto-accept-edits", "auto"] };

/**
 * The stand-in with `--two-way`: `log` lines, an `ask` line for each question, one `result` line
 * per turn, `interrupted` on one that was cut short. A message, an answer and an interrupt are
 * one JSON line each on its stdin.
 */
export function fakeCodec(work?: string): AgentCodec {
  const held = new Map<string, { tool: string; target: string }>();
  let last: { summary: string; interrupted: boolean } | null = null;
  return {
    decode(line) {
      const frame = parseLine(line);
      if (!frame) return outputLine(line);
      if (frame.type === "log" && typeof frame.text === "string") return [{ type: "message", text: frame.text }];
      if (frame.type === "ask" && typeof frame.id === "string" && typeof frame.tool === "string") {
        const target = typeof frame.target === "string" ? frame.target : "";
        held.set(frame.id, { tool: frame.tool, target });
        return [{ type: "request", request: { id: frame.id, kind: "permission", tool: frame.tool, summary: target || frame.tool } }];
      }
      const live = liveEvents(frame, work);
      if (live.length) return live;
      if (frame.type !== "result") return [];
      last = { summary: typeof frame.summary === "string" ? frame.summary : "", interrupted: frame.interrupted === true };
      return [{ type: "turn_finished", ok: !last.interrupted, summary: last.summary, reason: null, turns: null }];
    },
    finish(exitCode) {
      if (last?.interrupted) return { type: "terminal", status: "interrupted", summary: "" };
      return { type: "terminal", status: exitCode === 0 && last ? "completed" : "failed", summary: last?.summary ?? "" };
    },
    turn: (text) => JSON.stringify({ type: "user", text }),
    interrupt: () => JSON.stringify({ type: "interrupt" }),
    answer(requestId, decision) {
      return held.delete(requestId) ? JSON.stringify({ type: "answer", id: requestId, decision }) : null;
    },
    grantKey(requestId) {
      const asked = held.get(requestId);
      return asked ? JSON.stringify([asked.tool, asked.target]) : null;
    },
    pending: () => [],
  };
}
