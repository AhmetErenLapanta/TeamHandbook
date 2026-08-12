import { detectSecret } from "./secrets.js";

// A user prompt that TEACHES — "we never use X here", "always run Y first", "burada
// db'yi asla mocklamayız" — is the highest-value lesson in a session: a human, stating
// a rule, in their own words. This file used to try to spot them as they were typed,
// with a list of English phrases. That worked in English and nowhere else: probed
// against a real session, eighteen Turkish prompts produced zero flags, so the half of
// the tagline that is supposed to be measured could never fire for a developer who
// teaches in their own language. Adding a second list would only move the wall.
//
// So nothing here decides what a teaching is any more. Every prompt that could
// plausibly be one is recorded, and which of them states a rule is settled later by
// the model, which reads any language without being told about it. This file is left
// with the two judgements that need no language at all: is this prose the developer
// typed, and is it safe to write down.

// Shorter than this is almost always an ack ("ok", "devam", "yes"); longer is a task
// brief rather than a rule. Both bounds are about shape, not vocabulary.
const MIN_CHARS = 12;
const MAX_CHARS = 600;

/**
 * Not the developer's own prose: slash commands, pasted XML/HTML, and the bracketed
 * notices the harness itself injects ("[Request interrupted by user]"). The last one is
 * not hypothetical — across the transcripts on one machine it was the single most
 * repeated "prompt" of all, by a factor of thirteen.
 */
function isDeveloperProse(text: string): boolean {
  return !text.startsWith("/") && !text.startsWith("<") && !text.startsWith("[");
}

/** Could this prompt carry a lesson? A question of shape only — no language is read. */
export function couldTeach(prompt: string): boolean {
  const text = prompt.trim();
  return text.length >= MIN_CHARS && text.length <= MAX_CHARS && isDeveloperProse(text);
}

export interface CorrectionNote {
  at: string;
  text: string;
}

// Every candidate prompt in a session, not a hand-picked few, so the record of what
// was said is the model's to interpret. Bounded because a session state file is not an
// archive of the conversation — the transcript already is one.
export const MAX_CORRECTIONS = 40;
const MAX_TEXT_CHARS = 400;

/**
 * Record a prompt that could carry a lesson. Secret-bearing prompts are dropped
 * entirely (the same fail-closed rule as capture): the note would otherwise put raw
 * prompt text on disk.
 */
export function noteCorrection(
  notes: CorrectionNote[],
  prompt: string,
  at: string = new Date().toISOString(),
): CorrectionNote[] | null {
  if (!couldTeach(prompt)) return null;
  const full = prompt.trim();
  // scan the WHOLE prompt before truncating: a token straddling the cut would
  // otherwise leave a sub-threshold prefix on disk
  if (detectSecret(full)) return null;
  const text = full.slice(0, MAX_TEXT_CHARS);
  if (notes.some((n) => n.text === text)) return null; // repeated verbatim; already noted
  const next = [...notes, { at, text }];
  return next.length > MAX_CORRECTIONS ? next.slice(-MAX_CORRECTIONS) : next;
}
