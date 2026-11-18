import { loadedDespiteOff } from "../server/tasks/adapters/contract.js";
import type { AgentCodec, AgentEvent, AgentTransport } from "../server/tasks/adapters/contract.js";
import { opencodeServeCodec } from "../server/tasks/adapters/opencode.js";
import { signInEvents } from "../server/tasks/adapters/frames.js";
import { loadedServers, mcpDecidingCodec, waitingForSignIn } from "./opencode-mcp.js";
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
export async function startOpencodeSession({ program, cwd, env, permission, resume, off = [], readOnly = false, spawn }: { program: string; cwd: string; env: Record<string, string | undefined>; permission: unknown; resume?: string; off?: readonly string[]; readOnly?: boolean; spawn?: Spawner }): Promise<OpencodeSession> {
  const serve = await startOpencodeServe({ program, cwd, env, ...(spawn ? { spawn } : {}) });
  try {
    const status = await serve.request("GET", "/mcp").catch(() => null);
    const servers = status && typeof status === "object" ? Object.keys(status) : [];
    const loaded = loadedServers(status);
    const despite = loadedDespiteOff({ plugins: [], skills: [], mcpServers: off }, loaded);
    if (despite.length) throw new Error(`MCP server ${despite.join(", ")} ${despite.length === 1 ? "is" : "are"} off for this task and ${despite.length === 1 ? "was" : "were"} loaded anyway, so no session was started`);
    const windows = contextWindows(await serve.request("GET", "/config/providers").catch(() => null));
    const sessionId = resume ? await serve.resumeSession(resume, permission) : await serve.createSession(permission);
    return { sessionId, pgid: serve.pgid, transport: serve.transport(), codec: mcpDecidingCodec(opencodeServeCodec(sessionId, 1, cwd, false, servers, windows), servers, [loaded, ...signInEvents(waitingForSignIn(status))], off, readOnly), stop: () => serve.stop() };
  } catch (error) {
    serve.stop();
    throw error;
  }
}

export function contextWindows(answer: unknown): Record<string, number> {
  const providers = (answer as { providers?: unknown } | null)?.providers;
  if (!Array.isArray(providers)) return {};
  const windows: Record<string, number> = {};
  for (const provider of providers as { id?: unknown; models?: unknown }[]) {
    if (typeof provider?.id !== "string" || !provider.models || typeof provider.models !== "object") continue;
    for (const [model, about] of Object.entries(provider.models as Record<string, { limit?: { context?: unknown } } | null>)) {
      const context = about?.limit?.context;
      if (typeof context === "number" && Number.isInteger(context) && context > 0) windows[`${provider.id}/${model}`] = context;
    }
  }
  return windows;
}

/**
 * A task's OpenCode run as its person, from its server's start to its end: the session under
 * `rules`, the conversation `talk` holds over it, and the server ended on every way out, the
 * conversation's end, its time running out, a cancel and a throw alike, since a server never ends
 * by itself. `onProcess` is told the server's group as soon as it runs, for the record a crash is
 * cleaned up from.
 */
export async function runOpencodeAsYou({ program, cwd, env, rules, timeoutMs, signal, onProcess, onSession, resume, off, readOnly, talk, spawn }: { program: string; cwd: string; env: Record<string, string | undefined>; rules: unknown; timeoutMs: number; signal: AbortSignal; onProcess: (pgid: number) => void; onSession?: (sessionId: string) => void; resume?: string; off?: readonly string[]; readOnly?: boolean; talk: (transport: AgentTransport, codec: AgentCodec) => Promise<AgentEvent[]>; spawn?: Spawner }): Promise<{ events: AgentEvent[]; timedOut: boolean }> {
  const session = await startOpencodeSession({ program, cwd, env, permission: rules, ...(resume ? { resume } : {}), ...(off ? { off } : {}), ...(readOnly ? { readOnly } : {}), ...(spawn ? { spawn } : {}) });
  if (session.pgid !== null) onProcess(session.pgid);
  onSession?.(session.sessionId);
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
