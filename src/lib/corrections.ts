import { detectSecret } from "./secrets.js";

// A user prompt that TEACHES — "we never use X here", "always run Y first", "no,
// that's wrong, do Z" — is the highest-value lesson in a session: a human, stating
// a rule, in their own words. The harvest model looks for these on its own, but
// flagging them deterministically at the moment they are typed means a teaching in
// the middle of a long session can never be lost to slicing, and the harvest gets
// them as evidence rather than having to notice them.

// Ordered most-specific first: "we never use X here" is a house CONVENTION even
// though it also contains the word "never", so the convention pattern must win.
const TEACHING_PATTERNS: Array<{ name: string; re: RegExp }> = [
  // house style: "we never use X", "in this repo we ...", "our convention is"
  { name: "convention", re: /\b(?:we (?:never|always|only)?\s*(?:use|don'?t use|prefer|avoid)|in this (?:repo|project|codebase)|our (?:convention|standard|rule)|the (?:convention|standard) here)\b/i },
  // explicit correction of the assistant: "no, ...", "that's wrong", "actually, ..."
  // (the leading forms end in punctuation, so they must NOT be wrapped in \b — a
  // trailing word boundary after a comma can never match ordinary prose)
  {
    name: "correction",
    re: /(?:^|\s)(?:no|nope|actually|wrong)\s*[,.!:]|\b(?:that'?s (?:wrong|not right|not how)|that is wrong|instead of that|don'?t do that)\b/i,
  },
  // preference stated as a directive: "use X instead of Y", "prefer X over Y"
  { name: "preference", re: /\b(?:use \w[\w.-]* instead|prefer \w[\w.-]* over|switch to \w[\w.-]*|stop using \w[\w.-]*)\b/i },
  // absolute rules: "always run make fmt", "never commit to main", "don't use var".
  // "I don't know why this fails" is a question, not a rule — exclude first person.
  { name: "rule", re: /\b(?:always|never|must|make sure to|be sure to)\b|(?<!\bI\s)(?<!\bwe\s)\b(?:don'?t|do not)\b/i },
];

// Prompts shorter than this are almost always acks ("ok", "go on", "yes") and
// longer than this are usually task briefs, not rules.
const MIN_CHARS = 12;
const MAX_CHARS = 600;

/** The kind of teaching this prompt looks like, or null when it is ordinary work. */
export function teachingKind(prompt: string): string | null {
  const text = prompt.trim();
  if (text.length < MIN_CHARS || text.length > MAX_CHARS) return null;
  // slash commands, pasted output, and local-command echoes are not teachings
  if (text.startsWith("/") || text.startsWith("<")) return null;
  for (const { name, re } of TEACHING_PATTERNS) {
    if (re.test(text)) return name;
  }
  return null;
}

export interface CorrectionNote {
  at: string;
  kind: string;
  text: string;
}

// Keep the most recent few: they are hints for the harvest, not an archive.
export const MAX_CORRECTIONS = 10;
const MAX_TEXT_CHARS = 400;

/**
 * Record a teaching-shaped prompt, if it is one. Secret-bearing prompts are
 * dropped entirely (same fail-closed rule as capture): the note would otherwise
 * put raw prompt text on disk.
 */
export function noteCorrection(
  notes: CorrectionNote[],
  prompt: string,
  at: string = new Date().toISOString(),
): CorrectionNote[] | null {
  const kind = teachingKind(prompt);
  if (!kind) return null;
  const full = prompt.trim();
  // scan the WHOLE prompt before truncating: a token straddling the cut would
  // otherwise leave a sub-threshold prefix on disk
  if (detectSecret(full)) return null;
  const text = full.slice(0, MAX_TEXT_CHARS);
  if (notes.some((n) => n.text === text)) return null; // repeated verbatim; already noted
  const next = [...notes, { at, kind, text }];
  return next.length > MAX_CORRECTIONS ? next.slice(-MAX_CORRECTIONS) : next;
}
