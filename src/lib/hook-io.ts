export interface HookInput {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  // PostToolUse (success) carries tool_response; PostToolUseFailure carries error +
  // is_interrupt and no tool_response.
  tool_response?: unknown;
  error?: string;
  is_interrupt?: boolean;
  // UserPromptSubmit carries the text the user just typed
  prompt?: string;
}

export async function readStdin(stream: NodeJS.ReadableStream = process.stdin): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function parseHookInput(raw: string): HookInput | null {
  if (!raw.trim()) return null;
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    return parsed as HookInput;
  } catch {
    return null;
  }
}
