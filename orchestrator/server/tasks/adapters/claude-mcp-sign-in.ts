import { parseLine } from "./frames.js";

/**
 * Signing a person's MCP server in from a short Claude Code session of their own, at their click.
 * Read from Claude Code 2.1.322's own code, never by running it: `mcp_status` lists the session's
 * servers with their status; `mcp_authenticate` with no `redirectUri` makes Claude Code listen on
 * a localhost port of its own and answers with the address to open, or says the server needs no
 * sign-in; once the person signs in in their browser, Claude Code takes the redirect, keeps the
 * token in their own store and connects the server, and the next `mcp_status` says so. The
 * address carries the sign-in's state and is never logged or stored.
 */

const request = (id: string, body: Record<string, unknown>) => JSON.stringify({ type: "control_request", request_id: id, request: body });

/** The line that asks the session for its servers and their status. */
export const mcpStatusRequest = (id: string) => request(id, { subtype: "mcp_status" });

/** The line that starts a server's sign-in, by the name Claude Code itself gives it. */
export const mcpSignInRequest = (id: string, server: string) => request(id, { subtype: "mcp_authenticate", serverName: server });

/** The answer a control request of this id got, or null for any other line. */
function answerTo(line: string, id: string): { ok: true; response: Record<string, unknown> } | { ok: false; code: string | null } | null {
  const frame = parseLine(line);
  const response = (frame?.type === "control_response" ? frame.response : null) as Record<string, unknown> | null;
  if (!response || response.request_id !== id) return null;
  if (response.subtype === "success") return { ok: true, response: (response.response ?? {}) as Record<string, unknown> };
  return { ok: false, code: typeof response.error_code === "string" ? response.error_code : null };
}

export type McpServerState = "signed-in" | "waiting" | "failed";

const STATE: Record<string, McpServerState> = { connected: "signed-in", "needs-auth": "waiting", pending: "waiting", failed: "failed" };

/**
 * The session's servers from its answer to `mcp_status`, by Claude Code's own name and as a page
 * names them (a plugin's server without its `plugin_<plugin>_` prefix), or null for any other line.
 * A status it does not know is left out.
 */
export function mcpServers(line: string, id: string): { name: string; shown: string; state: McpServerState }[] | null {
  const answer = answerTo(line, id);
  if (!answer) return null;
  if (!answer.ok) return [];
  const rows = Array.isArray(answer.response.mcpServers) ? answer.response.mcpServers : [];
  return rows.flatMap((row: Record<string, unknown> | null) => {
    const state = STATE[String(row?.status)];
    return row && typeof row.name === "string" && row.name && state ? [{ name: row.name, shown: row.name.replace(/^plugin_[^_]+_(?=.)/, ""), state }] : [];
  });
}

/** The one server a page's name stands for, or null when none does or two could. */
export function mcpServerNamed(servers: readonly { name: string; shown: string }[], shown: string): string | null {
  const matches = servers.filter((s) => s.name === shown || s.shown === shown);
  return matches.length === 1 ? matches[0]!.name : null;
}

/** Why a sign-in could not start, in the orchestrator's words: never Claude Code's own text. */
const REFUSED: Record<string, string> = {
  mcp_policy_blocked: "Your organization's policy does not allow this server.",
  mcp_client_registration_unavailable: "This server does not let Claude Code sign in from here; use the command instead.",
};
const NOT_STARTED = "Claude Code could not start the sign-in; use the command instead.";

export type McpSignIn = { authorizeUrl: string } | { signedIn: true } | { failed: string };

/**
 * Claude Code's answer to `mcp_authenticate`, or null for any other line: the address to open in
 * the person's browser, or that the server needs no sign-in. Only an https address is passed on;
 * anything else is refused rather than opened.
 */
export function mcpSignInAnswer(line: string, id: string): McpSignIn | null {
  const answer = answerTo(line, id);
  if (!answer) return null;
  if (!answer.ok) return { failed: (answer.code && REFUSED[answer.code]) || NOT_STARTED };
  if (answer.response.requiresUserAction === false) return { signedIn: true };
  const url = typeof answer.response.authUrl === "string" && URL.canParse(answer.response.authUrl) ? new URL(answer.response.authUrl) : null;
  return url?.protocol === "https:" ? { authorizeUrl: url.href } : { failed: NOT_STARTED };
}
