import type { HookInput } from "./hook-io.js";
import { commandFamily, fingerprint, normalizeErrorText } from "./normalize.js";
import { extractErrorText, extractExitCode, isInterrupt } from "./tool-response.js";
import {
  attachEditToOpenErrors,
  loadSessionState,
  recordFailure,
  resolveOpenErrors,
  saveSessionState,
  handbookHome,
} from "./session-state.js";

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit"]);

export function captureBashFailure(input: HookInput, home: string = handbookHome()): boolean {
  if (input.tool_name !== "Bash" || !input.session_id) return false;
  const exitCode = extractExitCode(input.tool_response);
  if (exitCode === undefined || exitCode === 0) return false;
  // Ctrl-C / timeout / OOM kills are not real failures to learn from.
  if (isInterrupt(input.tool_response)) return false;
  const command = typeof input.tool_input?.command === "string" ? input.tool_input.command : "";
  if (!command) return false;
  const error = normalizeErrorText(extractErrorText(input.tool_response));
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

export function captureFileEdit(input: HookInput, home: string = handbookHome()): boolean {
  if (!input.session_id || !EDIT_TOOLS.has(input.tool_name ?? "")) return false;
  const filePath = typeof input.tool_input?.file_path === "string" ? input.tool_input.file_path : "";
  if (!filePath) return false;
  const state = loadSessionState(input.session_id, home);
  if (!attachEditToOpenErrors(state, filePath)) return false;
  saveSessionState(state, home);
  return true;
}

export function captureBashSuccess(input: HookInput, home: string = handbookHome()): boolean {
  if (input.tool_name !== "Bash" || !input.session_id) return false;
  if (extractExitCode(input.tool_response) !== 0) return false;
  const command = typeof input.tool_input?.command === "string" ? input.tool_input.command : "";
  if (!command) return false;
  const state = loadSessionState(input.session_id, home);
  if (state.openErrors.length === 0) return false;
  // Only resolve errors from the same working directory: a `npm test` pass in
  // repo B must not close an `npm test` failure opened in repo A.
  const resolved = resolveOpenErrors(state, commandFamily(command), command, input.cwd ?? "");
  if (resolved.length === 0) return false;
  saveSessionState(state, home);
  return true;
}
