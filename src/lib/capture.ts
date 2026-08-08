import type { HookInput } from "./hook-io.js";
import { commandFamily, fingerprint, normalizeErrorText } from "./normalize.js";
import { bashFailure, isBashSuccess } from "./tool-response.js";
import {
  attachEditToOpenErrors,
  loadSessionState,
  recordFailure,
  resolveOpenErrors,
  saveSessionState,
  handbookHome,
} from "./session-state.js";

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit"]);

function bashCommand(input: HookInput): string {
  return typeof input.tool_input?.command === "string" ? input.tool_input.command : "";
}

/** Record a failed Bash command (PostToolUseFailure, or a non-zero PostToolUse). */
export function captureBashFailure(input: HookInput, home: string = handbookHome()): boolean {
  if (input.tool_name !== "Bash" || !input.session_id) return false;
  const failure = bashFailure(input);
  if (!failure || failure.interrupted) return false; // not a failure, or a Ctrl-C/timeout kill
  const command = bashCommand(input);
  if (!command) return false;
  const error = normalizeErrorText(failure.errorText);
  const family = commandFamily(command);
  const state = loadSessionState(input.session_id, home);
  recordFailure(state, {
    fingerprint: fingerprint(family, error),
    family,
    command,
    error,
    cwd: input.cwd ?? "",
  });
  saveSessionState(state, home);
  return true;
}

/** Attach a successful file edit to any open errors, as a candidate fix. */
export function captureFileEdit(input: HookInput, home: string = handbookHome()): boolean {
  if (!input.session_id || !EDIT_TOOLS.has(input.tool_name ?? "")) return false;
  const filePath = typeof input.tool_input?.file_path === "string" ? input.tool_input.file_path : "";
  if (!filePath) return false;
  const state = loadSessionState(input.session_id, home);
  if (!attachEditToOpenErrors(state, filePath)) return false;
  saveSessionState(state, home);
  return true;
}

/**
 * A completed Bash command closes any open errors of the same command family.
 * Returns how many pairs were resolved (0 when nothing matched), so the health
 * counter can reflect multi-resolves accurately.
 */
export function captureBashSuccess(input: HookInput, home: string = handbookHome()): number {
  if (input.tool_name !== "Bash" || !input.session_id) return 0;
  if (!isBashSuccess(input)) return 0;
  const command = bashCommand(input);
  if (!command) return 0;
  const state = loadSessionState(input.session_id, home);
  if (state.openErrors.length === 0) return 0;
  // Only resolve errors from the same working directory: a `npm test` pass in
  // repo B must not close an `npm test` failure opened in repo A.
  const resolved = resolveOpenErrors(state, commandFamily(command), command, input.cwd ?? "");
  if (resolved.length === 0) return 0;
  saveSessionState(state, home);
  return resolved.length;
}
