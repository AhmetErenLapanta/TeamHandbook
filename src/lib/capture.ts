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

// Command families too generic to describe "what kind of work this was".
const GENERIC_FAMILIES = new Set([
  "ls", "cat", "cd", "pwd", "echo", "grep", "find", "head", "tail", "which",
  "mkdir", "rm", "cp", "mv", "touch", "chmod", "sed", "awk", "wc", "sleep",
  "git status", "git diff", "git log", "git add",
]);

function bashCommand(input: HookInput): string {
  return typeof input.tool_input?.command === "string" ? input.tool_input.command : "";
}

/**
 * Accumulate the session's coarse work shape (which command families ran, which
 * file types were edited). This powers repeated-work detection (T3): the shape is
 * recorded at session end and, when similar work recurs, the user is nudged to
 * turn the procedure into a skill.
 */
export function recordActivity(input: HookInput, home: string = handbookHome()): boolean {
  if (!input.session_id) return false;
  let family = "";
  let ext = "";
  if (input.tool_name === "Bash") {
    const command = bashCommand(input);
    if (!command) return false;
    family = commandFamily(command);
    if (GENERIC_FAMILIES.has(family) || family === "unknown") return false;
  } else if (EDIT_TOOLS.has(input.tool_name ?? "")) {
    const filePath = typeof input.tool_input?.file_path === "string" ? input.tool_input.file_path : "";
    const m = filePath.match(/\.([A-Za-z0-9]+)$/);
    if (!m) return false;
    ext = `.${m[1]!.toLowerCase()}`;
  } else {
    return false;
  }
  const state = loadSessionState(input.session_id, home);
  const activity = state.activity ?? { families: [], exts: [] };
  if (family && !activity.families.includes(family)) activity.families.push(family);
  else if (ext && !activity.exts.includes(ext)) activity.exts.push(ext);
  else return false; // nothing new; skip the write
  state.activity = activity;
  saveSessionState(state, home);
  return true;
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
