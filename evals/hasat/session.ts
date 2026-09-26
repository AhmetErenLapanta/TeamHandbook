// Turning one corpus session into the job the product would actually harvest.
//
// `harvestSession` accepts a bare transcript path, and a runner that handed it only that
// would measure a different product: in production `HarvestJob.evidence` carries
// transcript-independent evidence, and the harvest prompt leans on it heavily - every
// prompt the developer typed, so a mid-session teaching survives slicing, and the
// resolved error-fix pairs, whose ids `anchorIsSound` then verifies.
//
// So nothing here builds that evidence by hand. The session is REPLAYED through the same
// capture functions the hooks call, in the order the hooks call them, and the job is then
// assembled exactly as `src/hooks/session-end.ts` assembles it. A pair fingerprint
// therefore comes out of the product's own hashing rather than out of a literal, and the
// 40-prompt ceiling, the 400-character truncation and the verbatim-repeat drop all apply
// as they do on a real machine.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  captureBashFailure,
  captureBashSuccess,
  captureCorrection,
  captureFileEdit,
  recordActivity,
} from "../../src/lib/capture.js";
import { loadSessionState, sessionHasSubstance } from "../../src/lib/session-state.js";
import {
  flushSessionEnd,
  ledgerFingerprintCounts,
  ledgerPairsForSession,
} from "../../src/lib/signals.js";
import type { HarvestJob } from "../../src/lib/harvest.js";
import type { HookInput } from "../../src/lib/hook-io.js";
import { buildTranscriptSlice } from "../../src/lib/transcript.js";
import { defaultHarvestConfig } from "../../src/lib/harvest.js";
import type { CorpusSession, Label, Turn } from "./corpus.js";

/** A working directory that exists nowhere. `cwd` has to be stable across a session's
 * events, because an open error only pairs with a success from the same one. */
function fixtureCwd(): string {
  return mkdtempSync(join(tmpdir(), "th-hasat-cwd-"));
}

// ── transcript ──────────────────────────────────────────────────────────────

interface Line {
  type: "user" | "assistant";
  message: { role: string; content: unknown };
  isSidechain?: true;
  isMeta?: true;
}

/**
 * Write the session as Claude Code writes one. A turn carrying a tool call becomes two
 * lines - an assistant line whose content holds its text beside a tool_use block, and a
 * user line holding only the tool_result - because that is what the reader has to walk
 * past to find the conversation, and a transcript without them is not the shape the
 * product reads.
 */
export function writeTranscript(session: CorpusSession, dir: string): string {
  const lines: Line[] = [];
  for (const turn of session.turns) {
    lines.push(transcriptLine(turn));
    if (turn.tool) {
      lines.push({
        type: "user",
        message: {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: `toolu_${lines.length}`, content: turn.tool.result },
          ],
        },
      });
    }
  }
  const path = join(dir, "transcript.jsonl");
  writeFileSync(path, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`, "utf8");
  return path;
}

function transcriptLine(turn: Turn): Line {
  const blocks: unknown[] = [{ type: "text", text: turn.text }];
  if (turn.tool) {
    blocks.push({
      type: "tool_use",
      id: "toolu_fixture",
      name: turn.tool.name,
      input: turn.tool.input,
    });
  }
  const line: Line = {
    type: turn.role,
    // A human prompt arrives as a plain string and model output as blocks. Both shapes
    // are in every real transcript, so both are written here.
    message:
      turn.role === "user" && !turn.tool
        ? { role: "user", content: turn.text }
        : { role: turn.role, content: blocks },
  };
  if (turn.sidechain) line.isSidechain = true;
  if (turn.meta) line.isMeta = true;
  return line;
}

// ── replay through the capture path ─────────────────────────────────────────

/** How the harvest's own evidence came to be, per label, measured rather than assumed. */
export interface LabelPresence {
  labelId: string;
  /** the developer's own words for this lesson survived into the redacted slice */
  inSlice: boolean;
  /** and into the prompts the recorder kept */
  inCorrections: boolean;
}

export interface BuiltSession {
  job: HarvestJob;
  /** what `session-end.ts` would have decided before spending anything */
  substance: boolean;
  /** prompts the recorder kept, after the shape filter, the ceiling and the truncation */
  correctionsKept: number;
  /** prompts the fixture offered it */
  promptsOffered: number;
  /** prompts the recorder truncated at 400 characters */
  correctionsTruncated: number;
  slice: string;
  redactedLines: number;
  presence: LabelPresence[];
}

function foldForMatch(text: string): string {
  return text
    .toLowerCase()
    .replace(/['’`"“”]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

const MAX_TEXT_CHARS = 400;

/**
 * Replay one session into a throwaway home and assemble its job.
 *
 * `home` is expected to be fresh for this call. A home shared between two sessions would
 * make the first one's teachings echoes of the second, and its candidates "recent review
 * decisions" the prompt tells the model not to re-propose - so two fixtures would measure
 * each other rather than the product.
 */
export function buildSession(session: CorpusSession, home: string): BuiltSession {
  const dir = mkdtempSync(join(tmpdir(), "th-hasat-"));
  const transcriptPath = writeTranscript(session, dir);
  const cwd = fixtureCwd();
  const sessionId = `fixture-${session.id}`;
  const base: HookInput = { session_id: sessionId, transcript_path: transcriptPath, cwd };

  // The prompt recorder, once per user turn, in order - a meta line is one Claude Code
  // injected, and UserPromptSubmit never fires for it.
  const prompts = session.turns
    .filter((t) => t.role === "user" && !t.meta && !t.sidechain)
    .map((t) => t.text);
  for (const prompt of prompts) captureCorrection({ ...base, prompt }, home);

  for (const event of session.work) {
    if (event.kind === "edit") {
      const input: HookInput = {
        ...base,
        hook_event_name: "PostToolUse",
        tool_name: "Edit",
        tool_input: { file_path: event.file },
        tool_response: { stdout: "", stderr: "", interrupted: false },
      };
      // Both, and in this order, because a post-tool-use hook calls both: the edit is a
      // candidate fix for an open error AND a contribution to the session's work shape.
      captureFileEdit(input, home);
      recordActivity(input, home);
      continue;
    }
    if (event.kind === "bash-fail") {
      captureBashFailure(
        {
          ...base,
          hook_event_name: "PostToolUseFailure",
          tool_name: "Bash",
          tool_input: { command: event.command },
          error: `Exit code 1\n${event.error ?? ""}`,
        },
        home,
      );
      recordActivity({ ...base, tool_name: "Bash", tool_input: { command: event.command } }, home);
      continue;
    }
    const ok: HookInput = {
      ...base,
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_input: { command: event.command },
      tool_response: { stdout: "ok", stderr: "", interrupted: false },
    };
    captureBashSuccess(ok, home);
    recordActivity(ok, home);
  }

  // From here on this is session-end.ts, line for line: read the state before the flush
  // deletes it, decide substance on it, flush, then take the pairs and their recurrence
  // counts from the ledger rather than from the state file.
  const state = loadSessionState(sessionId, home);
  const substance = sessionHasSubstance(state);
  const correctionsKept = state.corrections?.length ?? 0;
  const correctionsTruncated = (state.corrections ?? []).filter((c) => c.text.length === MAX_TEXT_CHARS)
    .length;
  flushSessionEnd(sessionId, home);
  const pairs = ledgerPairsForSession(sessionId, home);
  const counts = ledgerFingerprintCounts(home);
  const recurrence: Record<string, number> = {};
  for (const pair of pairs) recurrence[pair.fingerprint] = counts.get(pair.fingerprint) ?? 1;

  const job: HarvestJob = {
    sessionId,
    cwd,
    transcriptPath,
    evidence: {
      pairs,
      ...(state.activity ? { work: state.activity } : {}),
      ...(state.corrections?.length ? { corrections: state.corrections } : {}),
      recurrence,
    },
  };

  const { slice, redacted } = buildTranscriptSlice(transcriptPath, defaultHarvestConfig.transcriptCharCap);
  const foldedSlice = foldForMatch(slice);
  const foldedCorrections = (state.corrections ?? []).map((c) => foldForMatch(c.text));
  const presence: LabelPresence[] = session.labels.map((label: Label) => {
    const needle = foldForMatch(label.anchor);
    return {
      labelId: label.id,
      inSlice: foldedSlice.includes(needle),
      inCorrections: foldedCorrections.some((c) => c.includes(needle)),
    };
  });

  return {
    job,
    substance,
    correctionsKept,
    promptsOffered: prompts.length,
    correctionsTruncated,
    slice,
    redactedLines: redacted,
    presence,
  };
}
