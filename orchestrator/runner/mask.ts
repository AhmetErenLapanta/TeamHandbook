import type { AgentEvent, AgentFailure, AgentRequest } from "../server/tasks/adapters/contract.js";
import type { McpTool } from "../server/tasks/agents.js";
import { SECRET_NAME } from "../server/forge/project-git.js";
import { COMMAND_MAX, OUTPUT_LINE_MAX, OUTPUT_LINES_MAX, PATCH_LINES_MAX, PLAN_TEXT_MAX, TODO_TEXT_MAX, TODOS_MAX } from "../shared/runner-wire.js";
import type { RunnerEvent, TaskOutcome } from "./link.js";

/**
 * Masks every text an event carries, on this machine, before it is sent anywhere, and rebuilds it
 * from the fields its kind has; null for an event of a kind this runner does not know, which is
 * not sent at all: a field nobody masks for would leave the machine as the agent wrote it.
 */
export function maskEvent(event: RunnerEvent, mask: (text: string) => string): RunnerEvent | null {
  switch (event.type) {
    case "message":
    case "output":
    case "notice":
    case "log":
      return { type: event.type, text: mask(event.text) };
    case "steer":
      return { type: "steer", text: mask(event.text), by: mask(event.by) };
    case "tool_call":
      return {
        type: "tool_call",
        ...(event.id === undefined ? {} : { id: event.id }),
        tool: mask(event.tool),
        target: event.target === null ? null : mask(event.target),
        status: event.status,
        ...(event.command === undefined ? {} : { command: mask(event.command).slice(0, COMMAND_MAX) }),
        ...(event.mcp === undefined ? {} : { mcp: { server: mask(event.mcp.server), tool: mask(event.mcp.tool) } }),
        ...(event.refusal === undefined ? {} : { refusal: { kind: event.refusal.kind, reason: mask(event.refusal.reason) } }),
      };
    case "tool_output":
      return { type: "tool_output", id: event.id, lines: event.lines.slice(-OUTPUT_LINES_MAX).map((line) => mask(line).slice(0, OUTPUT_LINE_MAX)) };
    case "edit":
      return {
        type: "edit",
        id: event.id,
        path: mask(event.path),
        additions: event.additions,
        deletions: event.deletions,
        ...(event.patch === undefined || SECRET_NAME.test(event.path) ? {} : { patch: event.patch.split("\n").slice(0, PATCH_LINES_MAX).map(mask).join("\n") }),
      };
    case "todos":
      return { type: "todos", items: event.items.slice(0, TODOS_MAX).map((item) => ({ text: mask(item.text).slice(0, TODO_TEXT_MAX), state: item.state })) };
    case "request":
      return { type: "request", request: maskRequest(event.request, mask) };
    case "request_resolved":
      return { type: "request_resolved", requestId: event.requestId, decision: event.decision };
    case "request_withdrawn":
      return { type: "request_withdrawn", requestId: event.requestId };
    case "usage":
      return { type: "usage", cost: { usd: event.cost.usd, inputTokens: event.cost.inputTokens, outputTokens: event.cost.outputTokens } };
    case "context":
      return { type: "context", tokens: event.tokens };
    case "spend":
      return { type: "spend", usd: event.usd };
    case "mcp_status":
      return { type: "mcp_status", needsSignIn: event.needsSignIn.map(mask) };
    case "turn_finished":
      return { type: "turn_finished", ok: event.ok, summary: mask(event.summary), reason: event.reason === null ? null : mask(event.reason), turns: event.turns };
    case "error":
      return { type: "error", failure: maskFailure(event.failure, mask) };
    case "limit":
      return { type: "limit", window: event.window, status: event.status, ...(event.resetAt === undefined ? {} : { resetAt: event.resetAt }) };
    case "background":
      return { type: "background", pending: event.pending };
    case "terminal":
      return {
        type: "terminal",
        status: event.status,
        summary: mask(event.summary),
        ...(event.failure ? { failure: maskFailure(event.failure, mask) } : {}),
        ...(event.nativeSessionId === undefined ? {} : { nativeSessionId: event.nativeSessionId }),
      };
    default:
      return null;
  }
}

export function maskRequest(request: AgentRequest, mask: (text: string) => string): AgentRequest {
  return {
    id: request.id,
    kind: request.kind,
    tool: request.tool,
    summary: mask(request.summary),
    ...(request.plan === undefined ? {} : { plan: request.plan.split("\n").map(mask).join("\n").slice(0, PLAN_TEXT_MAX) }),
    ...(request.questions
      ? {
          questions: request.questions.map((q) => ({
            key: q.key,
            title: mask(q.title),
            ...(q.description === undefined ? {} : { description: mask(q.description) }),
            choice: q.choice,
            ...(q.options ? { options: q.options.map((o) => ({ value: o.value, label: mask(o.label), ...(o.description === undefined ? {} : { description: mask(o.description) }) })) } : {}),
            ...(q.other === undefined ? {} : { other: q.other }),
          })),
        }
      : {}),
  };
}

function maskFailure(failure: AgentFailure, mask: (text: string) => string): AgentFailure {
  return {
    class: failure.class,
    message: mask(failure.message),
    retryable: failure.retryable,
    ...(failure.code === undefined ? {} : { code: mask(failure.code) }),
    ...(failure.resetAt === undefined ? {} : { resetAt: failure.resetAt }),
    ...(failure.detail === undefined ? {} : { detail: mask(failure.detail) }),
  };
}

/** Masks the outcome's texts on this machine: its error, and the request's title and description. */
export function maskOutcome(outcome: TaskOutcome, mask: (text: string) => string): TaskOutcome {
  return { ...outcome, error: outcome.error === null ? null : mask(outcome.error), request: outcome.request && { title: mask(outcome.request.title), body: mask(outcome.request.body) } };
}

/**
 * Whether a tool is one of the person's own MCP tools: one of an MCP server the team did not give
 * the task. Its calls carry what the person's own services hold, which stays on their machine.
 */
export function ownMcpTool(teamTools: readonly McpTool[]): (tool: string) => boolean {
  const team = new Set(teamTools.map((t) => `mcp__${t.server}__${t.tool}`));
  return (tool) => tool.startsWith("mcp__") && !team.has(tool);
}

/**
 * An event as it leaves a machine for a team's orchestrator, or null for one that stays here: for
 * one of the person's own MCP tools only the tool's name, the decision and whether it ran go, never
 * what the call was aimed at; what any of the agent's own tools printed stays here, its commands'
 * output included, as the team sees only that a command ran; the team's tests' output is the
 * machine's own and goes. What the agent writes in its own words goes.
 */
export function keepOwnToolsHere(event: AgentEvent, own: (tool: string) => boolean): AgentEvent | null {
  if (event.type === "tool_output") return null;
  if (event.type === "tool_call" && own(event.tool)) return { type: "tool_call", ...(event.id === undefined ? {} : { id: event.id }), tool: event.tool, target: null, status: event.status, ...(event.mcp === undefined ? {} : { mcp: event.mcp }), ...(event.refusal === undefined ? {} : { refusal: event.refusal }) };
  if (event.type === "request" && own(event.request.tool)) return { ...event, request: ownRequest(event.request) };
  return event;
}

export const KEPT_ON_MACHINE = "(what it is aimed at stays on the person's machine)";

export function ownRequest(request: AgentRequest): AgentRequest {
  return { ...request, summary: KEPT_ON_MACHINE };
}

/** A variable whose name says it holds a credential. */
const CREDENTIAL_NAME = /TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|PRIVATE_?KEY|CREDENTIAL|AUTH/i;

/**
 * The values of the person's own environment that the task's output is masked for on their machine,
 * besides what looks like a credential by its shape: every variable whose name says it holds one.
 */
export function environmentSecrets(env: Record<string, string | undefined>): string[] {
  return Object.entries(env).flatMap(([name, value]) => (value && CREDENTIAL_NAME.test(name) ? [value] : []));
}
