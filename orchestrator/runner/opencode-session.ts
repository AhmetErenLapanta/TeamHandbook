import type { AgentCodec, AgentEvent, AgentTransport } from "../server/tasks/adapters/contract.js";
import { opencodeServeCodec } from "../server/tasks/adapters/opencode.js";
import { signInEvents } from "../server/tasks/adapters/frames.js";
import { mcpDecidingCodec, waitingForSignIn } from "./opencode-mcp.js";
import { startOpencodeServe } from "./opencode-serve.js";
import type { Spawner } from "./opencode-serve.js";

export interface OpencodeSession {
  sessionId: string;
  /** The server's process group, for the runner's record of what to end after a crash. */
  pgid: number | null;
  transport: AgentTransport;
  codec: AgentCodec;
  stop(): void;
}

/**
 * One task's OpenCode, ready for a two-way session: its own server on 127.0.0.1, then a session
 * under the task's permission rules. It runs with the person's own OpenCode sign-in, since only
 * the config file is the task's; a server that does not come up, or a session it will not make,
 * leaves nothing running.
 */
export async function startOpencodeSession({ program, cwd, env, permission, spawn }: { program: string; cwd: string; env: Record<string, string | undefined>; permission: unknown; spawn?: Spawner }): Promise<OpencodeSession> {
  const serve = await startOpencodeServe({ program, cwd, env, ...(spawn ? { spawn } : {}) });
  try {
    const status = await serve.request("GET", "/mcp").catch(() => null);
    const servers = status && typeof status === "object" ? Object.keys(status) : [];
    const sessionId = await serve.createSession(permission);
    return { sessionId, pgid: serve.pgid, transport: serve.transport(), codec: mcpDecidingCodec(opencodeServeCodec(sessionId, 1, cwd, false, servers), servers, signInEvents(waitingForSignIn(status))), stop: () => serve.stop() };
  } catch (error) {
    serve.stop();
    throw error;
  }
}

/**
 * A task's OpenCode run as its person, from its server's start to its end: the session under
 * `rules`, the conversation `talk` holds over it, and the server ended on every way out, the
 * conversation's end, its time running out, a cancel and a throw alike, since a server never ends
 * by itself. `onProcess` is told the server's group as soon as it runs, for the record a crash is
 * cleaned up from.
 */
export async function runOpencodeAsYou({ program, cwd, env, rules, timeoutMs, signal, onProcess, talk, spawn }: { program: string; cwd: string; env: Record<string, string | undefined>; rules: unknown; timeoutMs: number; signal: AbortSignal; onProcess: (pgid: number) => void; talk: (transport: AgentTransport, codec: AgentCodec) => Promise<AgentEvent[]>; spawn?: Spawner }): Promise<{ events: AgentEvent[]; timedOut: boolean }> {
  const session = await startOpencodeSession({ program, cwd, env, permission: rules, ...(spawn ? { spawn } : {}) });
  if (session.pgid !== null) onProcess(session.pgid);
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    session.stop();
  }, timeoutMs);
  const cancel = () => session.stop();
  signal.addEventListener("abort", cancel, { once: true });
  if (signal.aborted) cancel();
  try {
    return { events: await talk(session.transport, session.codec), timedOut };
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", cancel);
    session.stop();
  }
}
