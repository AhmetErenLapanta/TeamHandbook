import type { HookInput } from "./hook-io.js";
import { commandFamily, fingerprint, normalizeErrorText } from "./normalize.js";
import { bashFailure, isBashSuccess } from "./tool-response.js";
import { signalSecret } from "./secrets.js";
import { noteCorrection } from "./corrections.js";
import { incrementRedactionBlocked } from "./counters.js";
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
    // commandFamily can carry a secret verbatim when a token lands in the subcommand
    // slot (`npx <tool> sk-...`); never let that shape reach the activity record on disk.
    if (signalSecret({ command })) return false;
    family = commandFamily(command);
    if (GENERIC_FAMILIES.has(family) || family === "unknown") return false;
  } else if (EDIT_TOOLS.has(input.tool_name ?? "")) {
    const filePath = typeof input.tool_input?.file_path === "string" ? input.tool_input.file_path : "";
    const m = filePath.match(/\.([A-Za-z0-9]+)$/);
    if (!m) return false;
    if (signalSecret({ edits: [filePath] })) return false;
    ext = `.${m[1]!.toLowerCase()}`;
  } else {
    return false;
  }
  const state = loadSessionState(input.session_id, home);
  // Evidence for the harvest: count every meaningful tool call (substance check)
  // and remember where the transcript lives, even when the activity shape is not new.
  state.meaningfulToolCalls = (state.meaningfulToolCalls ?? 0) + 1;
  if (input.transcript_path) state.transcriptPath = input.transcript_path;
  const activity = state.activity ?? { families: [], exts: [] };
  let fresh = true;
  if (family && !activity.families.includes(family)) activity.families.push(family);
  else if (ext && !activity.exts.includes(ext)) activity.exts.push(ext);
  else fresh = false;
  state.activity = activity;
  saveSessionState(state, home);
  return fresh;
}

/**
 * Flag a teaching-shaped prompt ("we never use X here", "always run Y first") so
 * the harvest gets it as evidence instead of having to spot it in the transcript.
 * Secret-bearing prompts are dropped by noteCorrection — nothing raw is stored.
 */
export function captureCorrection(input: HookInput, home: string = handbookHome()): boolean {
  if (!input.session_id || typeof input.prompt !== "string") return false;
  const state = loadSessionState(input.session_id, home);
  const next = noteCorrection(state.corrections ?? [], input.prompt);
  if (!next) return false;
  state.corrections = next;
  if (input.transcript_path) state.transcriptPath = input.transcript_path;
  saveSessionState(state, home);
  return true;
}

// Namespaced exactly as commands/learn.md is invoked; matches with or without
// $ARGUMENTS after it, never a prompt that merely mentions the command in prose.
const LEARN_SLASH_COMMAND = /^\/handbook:learn(\s|$)/;

// Any OTHER literal slash command. Seeing one while an ask is pending is positive
// evidence the user moved on to a different explicit action, so it is the one
// thing (short of the CLI actually consuming the ask) allowed to clear a pending
// flag early. A plain-language prompt is not this — it is what learn.md step 2's
// clarifying question gets answered with. Shaped like a command name (letters,
// digits, ":", "_", "-", then whitespace or end), the same way LEARN_SLASH_COMMAND
// is anchored and terminated, specifically so it does NOT match a pasted absolute
// path ("/Users/x/..."), a regex literal, or a diff line — any of those would
// otherwise silently kill a still-live ask, which is exactly the lost-case class
// this card exists to close.
const ANY_SLASH_COMMAND = /^\/[a-zA-Z][a-zA-Z0-9:_-]*(\s|$)/;

/**
 * Track whether the user's own literal /handbook:learn slash command is still an
 * open, unconsumed ask. Measured, not assumed: dumping real hook stdin for both a
 * typed slash command and a plain-language request that made the model invoke the
 * same command via the Skill tool showed UserPromptSubmit carries the raw text a
 * human submitted in both cases (the slash command included), and that the model's
 * own Skill-tool call produces no UserPromptSubmit event of its own. So this is the
 * only place the two paths are told apart.
 *
 * The flag's lifecycle has to close two opposite failure modes at once:
 *
 *   - STALE TRUE: if the flag just stayed true forever after being set, a capture
 *     the model starts on its own much later (in the same session, via the Skill
 *     tool) would wrongly inherit the user's long-past explicit ask.
 *   - LOST TRUE: learn.md step 2 can ask the user a clarifying question when
 *     nothing in the session matches yet, and that exchange can take more than
 *     one round trip (which mode, which case, more detail). Every answer is a new
 *     UserPromptSubmit, in prose, not the literal slash command. Clearing the flag
 *     on the first one of those — or even the second — would misjudge the capture
 *     that follows as "the model invoked this on its own", when the user started
 *     it and is still mid-conversation answering the product's own questions.
 *
 * A plain-language prompt therefore never clears a pending ask by itself, no
 * matter how many of them intervene — an arbitrary turn budget would just move
 * where LOST TRUE reappears, and criterion here is zero lost cases, not "usually
 * enough". Instead:
 *
 *   - The ask is CONSUMED (cleared) the moment cli/learn.ts actually decides a
 *     trigger on it and the pipeline reaches a non-error outcome (see learn.ts's
 *     peekExplicitLearnInvocation / finalizeExplicitLearnInvocation, and
 *     pipeline.ts's runManualSignal caller) — this is what stops a genuinely-used
 *     true from leaking into a later, unrelated capture; it covers the ordinary
 *     "typed it, it ran" case exactly.
 *   - The ask is INVALIDATED early if the user types a DIFFERENT literal slash
 *     command while one is pending: that is a deliberate, explicit context
 *     switch, unlike ambiguous prose, so it is safe to treat as "the user moved
 *     on from that ask".
 *   - An ask that is pending, gets no different slash command, but is also never
 *     consumed (the user simply drops the topic mid-conversation) stays pending
 *     until one of the above happens. This is an accepted, asymmetric risk: it
 *     can cause a later unrelated model-initiated capture in the same session to
 *     wrongly get the "explicit" pass, which only means it is queued for the
 *     user to accept or reject at /handbook:review — never that a real request is
 *     silently destroyed. The opposite mistake (treating a live explicit ask as
 *     the model's own) throws the user's capture away with no recovery, which
 *     both learn.ts's own fail-open default and this card treat as strictly
 *     worse.
 */
export function captureLearnInvocation(input: HookInput, home: string = handbookHome()): boolean {
  if (!input.session_id || typeof input.prompt !== "string") return false;
  const state = loadSessionState(input.session_id, home);
  const prompt = input.prompt.trim();
  if (LEARN_SLASH_COMMAND.test(prompt)) {
    state.explicitLearnPending = true;
  } else if (state.explicitLearnPending !== true) {
    // Not currently pending (never recorded, or already false): record a concrete
    // "not pending" so a session that never typed the command doesn't fall back to
    // peekExplicitLearnInvocation's "never recorded" default of true.
    state.explicitLearnPending = false;
  } else if (ANY_SLASH_COMMAND.test(prompt)) {
    state.explicitLearnPending = false; // explicit context switch: the ask is over
  }
  // else: a plain-language prompt while pending — left untouched on purpose.
  if (input.transcript_path) state.transcriptPath = input.transcript_path;
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
  // A failing command/error can carry a secret (a `curl` with a bearer token, an
  // inline `API_KEY=...`). Drop the whole occurrence rather than persist a redacted
  // husk: a blanked open error can never pair (resolveOpenErrors matches on family),
  // so it would silently swallow every later clean recurrence of the same error. If
  // the error recurs WITHOUT the secret, that clean occurrence is captured fresh and
  // pairs normally. Nothing raw ever reaches ~/.teamhandbook/.
  if (signalSecret({ command, error })) {
    incrementRedactionBlocked(home);
    return false;
  }
  const family = commandFamily(command);
  const state = loadSessionState(input.session_id, home);
  if (input.transcript_path) state.transcriptPath = input.transcript_path;
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
  // A path is rarely secret, but signalSecret inspects edits and this path would be
  // persisted (and later shown in the skill/PR) — drop it rather than write it.
  if (signalSecret({ edits: [filePath] })) {
    incrementRedactionBlocked(home);
    return false;
  }
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
  // The resolving command is the fix that ships in the skill; if it carries a secret
  // we can neither store nor distill it, so don't pair — the error stays open (and is
  // later flushed as a content-free weak signal).
  if (signalSecret({ resolvedCommand: command })) {
    incrementRedactionBlocked(home);
    return 0;
  }
  // Only resolve errors from the same working directory: a `npm test` pass in
  // repo B must not close an `npm test` failure opened in repo A.
  const resolved = resolveOpenErrors(state, commandFamily(command), command, input.cwd ?? "");
  if (resolved.length === 0) return 0;
  saveSessionState(state, home);
  return resolved.length;
}
