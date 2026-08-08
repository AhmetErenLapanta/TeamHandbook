// The Bash tool_response object is { code, stdout, stderr, interrupted } (verified
// against the Claude Code 2.1.x binary). Older/other spellings are kept as
// fallbacks, and a text form ("... Exit code 1 ...") is parsed if no numeric field
// is present, so the detector survives payload-shape drift across versions.
const EXIT_CODE_KEYS = ["code", "exit_code", "exitCode", "returnCode"];
const STDOUT_TAIL_CHARS = 2000;
const EXIT_CODE_TEXT = /\bexit code[:\s]+(\d{1,3})\b/i;

// Some payload shapes wrap the result as an array of content blocks
// ([{type:"text", text:"..."}]). Flatten those blocks' text to a single string so
// the same extraction logic applies regardless of shape.
function contentBlocksText(response: unknown): string | null {
  if (!Array.isArray(response)) return null;
  const parts = response
    .map((b) => (b && typeof b === "object" ? (b as Record<string, unknown>)["text"] : b))
    .filter((t) => typeof t === "string");
  return parts.length ? parts.join("\n") : null;
}

export function extractExitCode(response: unknown): number | undefined {
  const blocks = contentBlocksText(response);
  if (blocks !== null) return extractExitCode(blocks);
  if (typeof response === "string") {
    const m = response.match(EXIT_CODE_TEXT);
    return m ? Number(m[1]) : undefined;
  }
  if (typeof response !== "object" || response === null) return undefined;
  const record = response as Record<string, unknown>;
  for (const key of EXIT_CODE_KEYS) {
    const value = record[key];
    if (typeof value === "number" && Number.isInteger(value)) return value;
  }
  // No numeric field: infer failure from an interrupt flag or an embedded message.
  if (record["interrupted"] === true) return 130;
  const text = [record["stderr"], record["stdout"], record["text"]]
    .filter((v) => typeof v === "string")
    .join("\n");
  const m = text.match(EXIT_CODE_TEXT);
  return m ? Number(m[1]) : undefined;
}

// Exit codes that mean "the command was killed/interrupted", not "the command
// reported a real failure worth learning from" (Ctrl-C, timeout, OOM kill).
const INTERRUPT_CODES = new Set([124, 130, 137, 143, 144, 145]);

export function isInterrupt(response: unknown): boolean {
  if (typeof response === "object" && response !== null) {
    if ((response as Record<string, unknown>)["interrupted"] === true) return true;
  }
  const code = extractExitCode(response);
  return code !== undefined && INTERRUPT_CODES.has(code);
}

export function extractErrorText(response: unknown): string {
  const blocks = contentBlocksText(response);
  if (blocks !== null) return blocks.slice(-STDOUT_TAIL_CHARS);
  if (typeof response === "string") return response;
  if (typeof response !== "object" || response === null) return "";
  const record = response as Record<string, unknown>;
  const stderr = record["stderr"];
  if (typeof stderr === "string" && stderr.trim()) return stderr;
  const stdout = record["stdout"];
  if (typeof stdout === "string" && stdout.trim()) return stdout.slice(-STDOUT_TAIL_CHARS);
  const text = record["text"];
  if (typeof text === "string" && text.trim()) return text.slice(-STDOUT_TAIL_CHARS);
  return "";
}
