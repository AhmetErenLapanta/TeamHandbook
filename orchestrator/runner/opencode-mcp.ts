import type { AgentCodec, AgentEvent, Decision } from "../server/tasks/adapters/contract.js";
import { FORGE_REASON, FORGE_TOOL, QUESTION_REASON, READING_TOOL, refusedTool, TRACKER_REASON, TRACKER_TOOL } from "../server/tasks/profile.js";

const sanitized = (name: string) => name.replace(/[^a-zA-Z0-9_-]/g, "_");

export const OFF_REASON = "This MCP server is turned off for this task.";

export function mcpCall(id: string, servers: readonly string[]): { server: string; tool: string } | null {
  const matches = [...new Set(servers.map(sanitized))].filter((server) => id.length > server.length + 1 && id.startsWith(`${server}_`));
  return matches.length === 1 ? { server: matches[0]!, tool: id.slice(matches[0]!.length + 1) } : null;
}

export function mcpDecision(id: string, servers: readonly string[], off: readonly string[] = [], readOnly = false): { decision: Decision; note?: string } | null {
  const decided = decide(id, servers, off);
  return decided || !readOnly ? decided : { decision: "deny", note: QUESTION_REASON };
}

function decide(id: string, servers: readonly string[], off: readonly string[]): { decision: Decision; note?: string } | null {
  const tracker = TRACKER_TOOL.test(id);
  const family = tracker || FORGE_TOOL.test(id);
  const call = mcpCall(id, servers);
  if (call && off.map(sanitized).includes(call.server)) return { decision: "deny", note: OFF_REASON };
  if (!call) return family ? { decision: "deny", note: tracker ? TRACKER_REASON : FORGE_REASON } : null;
  const refused = refusedTool(call.server, call.tool);
  if (refused) return { decision: "deny", note: refused };
  const named = call.tool.toLowerCase().startsWith(`${call.server.toLowerCase()}_`) ? call.tool.slice(call.server.length + 1) : null;
  return family || READING_TOOL.test(call.tool) || (named !== null && READING_TOOL.test(named)) ? { decision: "allow-once" } : null;
}

const LOADED_STATES: Record<string, "connected" | "needs-sign-in" | "failed" | "off"> = { connected: "connected", needs_auth: "needs-sign-in", needs_client_registration: "needs-sign-in", failed: "failed", disabled: "off" };

/** What OpenCode's servers stand at as the session starts, as the agent's own report of what it loaded; its skills and plugins it does not say. */
export function loadedServers(status: unknown): Extract<AgentEvent, { type: "loaded" }> {
  const known = status && typeof status === "object" ? Object.entries(status as Record<string, { status?: unknown } | null>) : null;
  return { type: "loaded", plugins: null, skills: null, mcpServers: known ? known.map(([name, server]) => ({ name, state: LOADED_STATES[String(server?.status)] ?? "failed" })) : null };
}

export function waitingForSignIn(status: unknown): string[] {
  if (!status || typeof status !== "object") return [];
  return Object.entries(status as Record<string, { status?: unknown } | null>).flatMap(([name, server]) => (server?.status === "needs_auth" ? [name] : []));
}

export function mcpDecidingCodec(codec: AgentCodec, servers: readonly string[], opening: readonly AgentEvent[] = [], off: readonly string[] = [], readOnly = false): AgentCodec {
  const outbox: string[] = [];
  let first: AgentEvent[] = [...opening];
  return {
    ...codec,
    decode(line) {
      const said = first;
      first = [];
      return [...said, ...codec.decode(line)].flatMap((event): AgentEvent[] => {
        if (event.type !== "request" || event.request.kind !== "mcp") return [event];
        const decided = mcpDecision(event.request.tool, servers, off, readOnly);
        if (!decided) return [event];
        const answer = codec.answer(event.request.id, decided.decision, decided.note);
        if (answer) outbox.push(answer);
        return decided.decision === "deny" ? [{ type: "tool_call", tool: event.request.tool, target: null, status: "refused", refusal: { kind: decided.note === FORGE_REASON ? "forge-write" : decided.note === OFF_REASON || decided.note === QUESTION_REASON ? "not-allowed" : "tracker-write", reason: decided.note ?? TRACKER_REASON } }] : [];
      });
    },
    pending: () => [...outbox.splice(0), ...codec.pending()],
  };
}
