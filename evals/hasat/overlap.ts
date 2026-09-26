// How much of a label's canonical sentence is already lying in the transcript.
//
// The n-gram bans in `corpus.test.ts` prove the sentence was not COPIED. They do not say
// how much of it a model could assemble by picking words out of the session, and that
// question decides what the recall number means: at an overlap near 1 the task is
// transcription, and the independent review of tier 1 measured 0.26 on average and 0.53 at
// worst - "rephrase what the developer said two turns ago" rather than "extract the lesson".
//
// This is that measure, in the shape the review used, so the two tiers are comparable: the
// fraction of the canonical sentence's CONTENT words that appear in the single best user
// sentence of the session, and the same against every user turn together. It is reported
// rather than enforced. A hard threshold would be the wrong instrument - a lesson about
// lockfiles has to say "lockfile" - and the number is only readable next to tier 1's.
import type { CorpusSession, Label } from "./corpus.js";

// Function words carry no subject, so leaving them in would measure English rather than
// leakage: every sentence shares "the" with every other one.
const STOPWORDS = new Set([
  "a", "an", "and", "any", "are", "as", "at", "be", "because", "been", "before", "but", "by",
  "can", "cannot", "do", "does", "each", "every", "for", "from", "had", "has", "have", "how",
  "in", "into", "is", "it", "its", "must", "never", "no", "not", "of", "on", "one", "only",
  "or", "other", "out", "over", "own", "rather", "so", "than", "that", "the", "their", "them",
  "then", "there", "these", "they", "this", "to", "two", "up", "was", "were", "what", "when",
  "where", "which", "while", "who", "will", "with", "without", "would", "you", "your",
  "ve", "bir", "bu", "da", "de", "den", "için", "ile", "mi", "ne", "o", "ya",
]);

function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9çğıöşü\s-]+/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));
}

/** Content words of `needle` that also appear in `haystack`, as a fraction of the needle's
 * own content words. Directional on purpose: what matters is how much of the REFERENCE
 * sentence is available in the session, not how much of the session is in the sentence. */
export function contentOverlap(needle: string, haystack: string): number {
  const want = new Set(words(needle));
  if (want.size === 0) return 0;
  const have = new Set(words(haystack));
  let hits = 0;
  for (const word of want) if (have.has(word)) hits += 1;
  return hits / want.size;
}

export interface OverlapRow {
  sessionId: string;
  labelId: string;
  form: Label["form"];
  /** the best single developer turn, which is the number the tier-1 review reported */
  bestTurn: number;
  /** everything the developer said in the session, together */
  allUserTurns: number;
  /** everything the assistant said, which is where a leak would be worst */
  allAssistantTurns: number;
}

export function overlapRows(sessions: CorpusSession[]): OverlapRow[] {
  const rows: OverlapRow[] = [];
  for (const session of sessions) {
    const user = session.turns.filter((t) => t.role === "user" && !t.meta && !t.sidechain);
    const assistant = session.turns.filter((t) => t.role === "assistant" && !t.sidechain);
    for (const label of session.labels) {
      rows.push({
        sessionId: session.id,
        labelId: label.id,
        form: label.form,
        bestTurn: Math.max(0, ...user.map((t) => contentOverlap(label.lesson, t.text))),
        allUserTurns: contentOverlap(label.lesson, user.map((t) => t.text).join("\n")),
        allAssistantTurns: contentOverlap(label.lesson, assistant.map((t) => t.text).join("\n")),
      });
    }
  }
  return rows;
}

/**
 * The same measure with the label pointed at a DIFFERENT session, which is what makes the
 * table above readable.
 *
 * A whole side of a dense session is a few thousand content words, so a sentence will find
 * a good fraction of its own words in there by chance alone. Without this baseline, tier 2's
 * higher assistant-side overlap reads as leakage when most of it is length. The per-turn
 * figure needs no such correction, which is why it is the one to compare against tier 1's.
 */
export function overlapAgainstOtherSessions(sessions: CorpusSession[]): OverlapRow[] {
  const rows: OverlapRow[] = [];
  const withLabels = sessions.filter((s) => s.labels.length > 0);
  for (let i = 0; i < withLabels.length; i++) {
    const source = withLabels[i]!;
    const donor = withLabels[(i + 1) % withLabels.length]!;
    const user = donor.turns.filter((t) => t.role === "user" && !t.meta && !t.sidechain);
    const assistant = donor.turns.filter((t) => t.role === "assistant" && !t.sidechain);
    for (const label of source.labels) {
      rows.push({
        sessionId: `${source.id} -> ${donor.id}`,
        labelId: label.id,
        form: label.form,
        bestTurn: Math.max(0, ...user.map((t) => contentOverlap(label.lesson, t.text))),
        allUserTurns: contentOverlap(label.lesson, user.map((t) => t.text).join("\n")),
        allAssistantTurns: contentOverlap(label.lesson, assistant.map((t) => t.text).join("\n")),
      });
    }
  }
  return rows;
}

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

export function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;
}
