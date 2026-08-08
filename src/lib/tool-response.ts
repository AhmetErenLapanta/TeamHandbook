import type { HookInput } from "./hook-io.js";

// How Claude Code reports a Bash tool result (verified empirically, 2.1.x):
//   success  → PostToolUse event, tool_response = {stdout, stderr, interrupted, …},
//              NO exit code field.
//   failure  → PostToolUseFailure event, error = "Exit code N\n<stderr>",
//              is_interrupt, and NO tool_response.
// The classifiers below key off the event, and also honor an explicit numeric exit
// code if a future/other payload shape provides one — so the detector survives both.

const STDOUT_TAIL_CHARS = 2000;
const EXIT_CODE_KEYS = ["code", "exit_code", "exitCode", "returnCode"];
const EXIT_CODE_TEXT = /\bexit code[:\s]+(\d{1,3})\b/i;
// Codes that mean "killed/interrupted", not a real failure worth learning from.
const INTERRUPT_CODES = new Set([124, 130, 137, 143, 144, 145]);

/**
 * Numeric exit code if the payload provides one. For OBJECT responses only the
 * structured numeric keys count — a successful command whose OUTPUT merely quotes
 * "exit code 1" (grep over logs, a test runner echoing a subprocess) must never be
 * reclassified as a failure, so stdout/stderr text is deliberately not scanned.
 * Text scanning applies only to string/array shapes, where no structure exists.
 */
export function extractExitCode(response: unknown): number | undefined {
  if (Array.isArray(response)) return extractExitCode(contentBlocksText(response));
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
  return undefined;
}

export interface BashFailure {
  errorText: string;
  interrupted: boolean;
}

/**
 * If this event represents a FAILED Bash command, return its error text and whether
 * it was an interrupt; otherwise null. Handles the real PostToolUseFailure shape and
 * the hypothetical "non-zero exit code in tool_response" shape.
 */
export function bashFailure(input: HookInput): BashFailure | null {
  if (input.hook_event_name === "PostToolUseFailure") {
    const text = typeof input.error === "string" ? input.error : "";
    const code = extractExitCode(text);
    return {
      errorText: text,
      interrupted: input.is_interrupt === true || (code !== undefined && INTERRUPT_CODES.has(code)),
    };
  }
  // Fallback: a PostToolUse whose tool_response carries a non-zero exit code.
  const code = extractExitCode(input.tool_response);
  if (code !== undefined && code !== 0) {
    return { errorText: errorTextFromResponse(input.tool_response), interrupted: INTERRUPT_CODES.has(code) };
  }
  return null;
}

/**
 * True if this event represents a SUCCESSFULLY COMPLETED Bash command. Success
 * requires POSITIVE evidence — either an explicit code 0, or the real PostToolUse
 * response shape ({stdout, stderr, interrupted}) with interrupted !== true. An
 * evidence-free payload (missing tool_response, or an error string under an
 * unfamiliar event name) must never resolve an open error into a fake pair.
 */
export function isBashSuccess(input: HookInput): boolean {
  if (input.hook_event_name === "PostToolUseFailure") return false;
  if (typeof input.error === "string" && input.error.trim()) return false;
  const r = input.tool_response;
  const code = extractExitCode(r);
  if (code !== undefined) return code === 0;
  if (typeof r !== "object" || r === null || Array.isArray(r)) return false;
  const record = r as Record<string, unknown>;
  const hasResultShape = ["stdout", "stderr", "interrupted"].some((k) => k in record);
  return hasResultShape && record["interrupted"] !== true;
}

function contentBlocksText(response: unknown): string {
  if (!Array.isArray(response)) return "";
  return response
    .map((b) => (b && typeof b === "object" ? (b as Record<string, unknown>)["text"] : b))
    .filter((t) => typeof t === "string")
    .join("\n");
}

function errorTextFromResponse(response: unknown): string {
  if (typeof response === "string") return response;
  if (Array.isArray(response)) return contentBlocksText(response).slice(-STDOUT_TAIL_CHARS);
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
