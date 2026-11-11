/**
 * Just enough of an MCP client to ask a remote server which tools it has: initialize, then
 * tools/list, over Streamable HTTP, reading a JSON or an event-stream answer. The orchestrator never
 * calls a tool; the list is what a person picks the tools a task may use from.
 */
export const CALL_TIMEOUT_MS = 10_000;
const MAX_PAGES = 10;
const PROTOCOL = "2025-06-18";

export class McpCallFailed extends Error {}

export interface ListedTool {
  name: string;
  description: string;
  /** What the server says of the tool, when it says anything: MCP's `readOnlyHint` and `destructiveHint`. */
  annotations: { readOnlyHint?: boolean; destructiveHint?: boolean };
}

async function answerOf(res: Response, id: number): Promise<Record<string, unknown>> {
  const type = res.headers.get("content-type") ?? "";
  const text = await res.text();
  const messages = type.includes("text/event-stream")
    ? text.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).filter(Boolean)
    : [text];
  for (const raw of messages) {
    let message: { id?: unknown; result?: unknown; error?: { message?: string } };
    try {
      message = JSON.parse(raw);
    } catch {
      continue;
    }
    if (message.id !== id) continue;
    if (message.error) throw new McpCallFailed(`the server answered with an error: ${String(message.error.message ?? "").slice(0, 200)}`);
    return (message.result ?? {}) as Record<string, unknown>;
  }
  throw new McpCallFailed("the server's answer carried no reply to the call");
}

/** One conversation with a server: initialized once, then any number of calls on its session. */
async function session(url: string, headers: Record<string, string>, send: typeof fetch): Promise<(method: string, params: Record<string, unknown>) => Promise<Record<string, unknown>>> {
  let id: string | null = null;
  let next = 1;
  const post = async (body: Record<string, unknown>): Promise<Response> => {
    let res: Response;
    try {
      res = await send(url, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": PROTOCOL, ...(id ? { "mcp-session-id": id } : {}), ...headers },
        body: JSON.stringify({ jsonrpc: "2.0", ...body }),
        redirect: "error",
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      });
    } catch (err) {
      throw new McpCallFailed((err as Error).name === "TimeoutError" ? `the server did not answer within ${CALL_TIMEOUT_MS / 1000} seconds` : "the server was not reached");
    }
    if (res.status === 401 || res.status === 403) throw new McpCallFailed(`the server refused the sign-in (${res.status}); connect it again`);
    if (!res.ok) throw new McpCallFailed(`the server answered ${res.status}`);
    return res;
  };
  const call = async (method: string, params: Record<string, unknown>) => {
    const n = next++;
    const res = await post({ id: n, method, params });
    id = res.headers.get("mcp-session-id") ?? id;
    return answerOf(res, n);
  };
  await call("initialize", { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: "teamhandbook-orchestrator", version: "1.0.0" } });
  await (await post({ method: "notifications/initialized" })).body?.cancel();
  return call;
}

export async function listTools(url: string, headers: Record<string, string>, send: typeof fetch = fetch): Promise<ListedTool[]> {
  const call = await session(url, headers, send);
  const tools: ListedTool[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const result = await call("tools/list", cursor ? { cursor } : {});
    for (const t of (result.tools ?? []) as { name?: unknown; description?: unknown; annotations?: { readOnlyHint?: unknown; destructiveHint?: unknown } }[]) {
      if (typeof t.name !== "string") continue;
      const { readOnlyHint, destructiveHint } = t.annotations ?? {};
      const annotations = { ...(typeof readOnlyHint === "boolean" ? { readOnlyHint } : {}), ...(typeof destructiveHint === "boolean" ? { destructiveHint } : {}) };
      tools.push({ name: t.name, description: typeof t.description === "string" ? t.description.slice(0, 300) : "", annotations });
    }
    cursor = typeof result.nextCursor === "string" ? result.nextCursor : undefined;
    if (!cursor) break;
  }
  return tools;
}

/**
 * Calls reading tools one after another on one session and returns each answer's text. The
 * orchestrator calls only tools it reads with - a tracker's issue, the sites an account reaches - never
 * one that changes anything.
 */
export async function readWithTools(url: string, headers: Record<string, string>, calls: (previous: string[]) => { name: string; arguments: Record<string, unknown> } | null, send: typeof fetch = fetch): Promise<string[]> {
  const call = await session(url, headers, send);
  const answers: string[] = [];
  for (let step = calls(answers); step; step = calls(answers)) {
    const result = await call("tools/call", step);
    if (result.isError) throw new McpCallFailed(`the server answered ${step.name} with an error`);
    answers.push(((result.content ?? []) as { type?: string; text?: string }[]).filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n"));
  }
  return answers;
}
