import { mcpServerNamed, mcpServers, mcpSignInAnswer, mcpSignInRequest, mcpStatusRequest } from "./adapters/claude-mcp-sign-in.js";
import type { McpSignIn } from "./adapters/claude-mcp-sign-in.js";
import { startProcess } from "./isolation.js";

/** How long a sign-in waits for its person in the browser before the session ends: the sign-in page's own time and a little more. */
export const MCP_SIGN_IN_MS = 3 * 60_000;
/** How often the session asks whether the server is signed in yet. */
const STATUS_EVERY_MS = 2_000;

export type McpSignInState = { state: "waiting" | "signed-in" | "failed"; why?: string };

export const SIGN_IN_TIMED_OUT = "The sign-in did not come back; try again, or sign in with claude and /mcp.";
const NO_SUCH_SERVER = "Claude Code has no one server by that name; use the command instead.";
const NO_ANSWER = "Claude Code did not answer; use the command instead.";

/** One sign-in under way: its first answer, where it stands now, and how to end it early. */
export interface McpSignInSession {
  server: string;
  first: Promise<McpSignIn>;
  state(): McpSignInState;
  end(): void;
}

/**
 * Signs one of the person's own MCP servers in from a short Claude Code session of theirs, at their click. The session
 * reads the person's user settings with every hook off, finds the server by the name the page shows, asks Claude Code
 * to start its sign-in, which listens on a localhost port of its own, and then asks every two seconds whether the
 * server is signed in, until it is, it fails, or MCP_SIGN_IN_MS pass. The address it hands back carries the sign-in's
 * state, so it reaches the caller alone: nothing here logs a line of the session.
 */
export function startMcpSignInSession(program: string, env: Record<string, string>, cwd: string, shown: string, ms = MCP_SIGN_IN_MS): McpSignInSession {
  const stop = new AbortController();
  let now: McpSignInState = { state: "waiting" };
  let answered: (sign: McpSignIn) => void = () => {};
  const first = new Promise<McpSignIn>((resolve) => (answered = resolve));
  let name: string | null = null;
  let asked = 0;
  let statusId = "";
  let timer: NodeJS.Timeout | null = null;
  const settle = (state: McpSignInState) => {
    if (now.state !== "waiting") return;
    now = state;
    if (timer) clearInterval(timer);
    stop.abort();
  };
  const askStatus = () => {
    statusId = `status-${++asked}`;
    started.write(mcpStatusRequest(statusId) + "\n");
  };
  const args = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--no-session-persistence", "--setting-sources", "user", "--settings", JSON.stringify({ disableAllHooks: true })];
  const started = startProcess({ program, args, env, cwd }, {
    timeoutMs: ms,
    signal: stop.signal,
    onLine: (stream, line) => {
      if (stream !== "stdout" || now.state !== "waiting") return;
      const servers = statusId ? mcpServers(line, statusId) : null;
      if (servers && !name) {
        name = mcpServerNamed(servers, shown);
        if (!name) return void (answered({ failed: NO_SUCH_SERVER }), settle({ state: "failed", why: NO_SUCH_SERVER }));
        if (servers.find((s) => s.name === name)?.state === "signed-in") return void (answered({ signedIn: true }), settle({ state: "signed-in" }));
        return void started.write(mcpSignInRequest("sign-in", name) + "\n");
      }
      if (servers && name) {
        const state = servers.find((s) => s.name === name)?.state;
        if (state === "signed-in") settle({ state: "signed-in" });
        return;
      }
      const sign = mcpSignInAnswer(line, "sign-in");
      if (!sign) return;
      answered(sign);
      if ("failed" in sign) return settle({ state: "failed", why: sign.failed });
      if ("signedIn" in sign) return settle({ state: "signed-in" });
      timer = setInterval(askStatus, STATUS_EVERY_MS);
    },
  });
  askStatus();
  void started.outcome.then(() => {
    answered({ failed: NO_ANSWER });
    settle({ state: "failed", why: name ? SIGN_IN_TIMED_OUT : NO_ANSWER });
  });
  return { server: shown, first, state: () => now, end: () => settle({ state: "failed", why: "The sign-in was ended." }) };
}
