import { readFileSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "./fs-atomic.js";
import { handbookHome } from "./session-state.js";

// "The things you tell Claude twice should only be said once" is the promise, but
// until now the recurrence score for a teaching was the model guessing from a single
// session — it had no way to know whether the developer had said it before. This is
// that memory: a small local record of what has already been taught, so the harvest
// is told "you have said something like this in 2 earlier sessions" instead of
// inferring it. Error→fix pairs already had this via the ledger's fingerprints;
// teachings, the thing the tagline is actually about, did not.

const STORE_LIMIT = 200;
const SAMPLE_CHARS = 160;

// Words that carry no meaning for matching. Deliberately short: an aggressive list
// would collapse unrelated teachings into each other, and a false echo is worse than
// a missed one — it inflates a score the user is trusting.
const STOPWORDS = new Set([
  "a", "an", "the", "is", "are", "was", "be", "to", "of", "in", "on", "for", "we",
  "you", "i", "it", "this", "that", "and", "or", "but", "with", "here", "there",
  "do", "does", "dont", "not", "no", "our", "us", "if", "when", "then", "should",
  "please", "just", "can", "will", "at", "as", "by", "from",
  // instruction scaffolding: every teaching is phrased with these, so leaving them
  // in makes "never use mocks" and "never use var" look like the same lesson, and
  // "run the tests before pushing" the same as "run the linter before pushing"
  "use", "never", "always", "must", "need", "remember", "make", "run", "before",
  "after", "instead", "only", "every", "all", "any", "was", "were", "have", "has",
  // where the rule applies is scaffolding too — "in this repo" is not the lesson
  "repo", "project", "codebase", "reminder", "note",
]);

/** Content words, lightly stemmed. A developer never repeats a teaching word for
 * word: "mocks"/"mock" and "editing"/"edit" have to land on the same token or the
 * echo is missed, which is the failure that leaves the recurrence score a guess. */
export function contentWords(text: string): string[] {
  const words = text
    .toLowerCase()
    // apostrophes close up ("don't" → "dont"); every other punctuation splits, or
    // the contraction would survive as the meaningless fragment "don"
    .replace(/['\u2019]/g, "")
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w))
    .map(stem)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));
  return [...new Set(words)];
}

function stem(word: string): string {
  const base = word
    .replace(/ies$/, "y")
    .replace(/(?<=.{3})(?:es|s)$/, "")
    .replace(/(?<=.{4})(?:ing|ed)$/, "");
  // "running" → "runn" → "run": undo the consonant doubled before the suffix
  return /([bdfglmnprt])\1$/.test(base) ? base.slice(0, -1) : base;
}

/**
 * Are these two the same teaching? Overlap of the SHORTER side, not of the union:
 * real sentences carry filler ("One more time: ...", "Use when writing ...") and
 * measuring against the union lets that filler outvote the rule itself. Two guards
 * keep it from over-matching: either the shorter side is fully contained in the
 * longer, or at least three content words are shared and they are half of the
 * shorter side. Three shared CONTENT words is the load-bearing half — scaffolding
 * alone can never clear it, so "run the tests before pushing" and "run the linter
 * before pushing" stay apart, and a false echo never inflates a score the
 * developer is trusting.
 */
export function sameTeaching(a: string[], b: string[]): boolean {
  if (a.length === 0 || b.length === 0) return false;
  const setB = new Set(b);
  const shared = a.filter((w) => setB.has(w)).length;
  const shorter = Math.min(a.length, b.length);
  return shared === shorter || (shared >= 3 && shared / shorter >= 0.5);
}

export interface TeachingRecord {
  words: string[];
  count: number;
  firstAt: string;
  lastAt: string;
  sample: string;
}

export function teachingsFile(home: string = handbookHome()): string {
  return join(home, "teachings.json");
}

export function readTeachings(home: string = handbookHome()): TeachingRecord[] {
  try {
    const parsed = JSON.parse(readFileSync(teachingsFile(home), "utf8"));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (r): r is TeachingRecord =>
        Array.isArray(r?.words) && typeof r?.count === "number" && typeof r?.firstAt === "string",
    );
  } catch {
    return [];
  }
}

export interface Echo {
  text: string;
  // how many EARLIER sessions taught something like this — 0 means it is new
  priorSessions: number;
  firstAt: string;
}

/**
 * Match this session's teachings against everything taught before, then fold them in.
 * One call, because the two halves must not be split: reading after writing would
 * report every teaching as an echo of itself.
 *
 * The texts arrive already secret-scanned by `captureCorrection` — that scan is the
 * persistence boundary for teachings, and this store sits behind it.
 */
export function recordAndMatchTeachings(
  texts: string[],
  home: string = handbookHome(),
  at: string = new Date().toISOString(),
): Echo[] {
  const store = readTeachings(home);
  const echoes: Echo[] = [];
  // dedupe within the session first: saying it three times in one sitting is one
  // teaching, not three, and counting it as three would fake the recurrence
  const seenThisSession: string[][] = [];
  for (const text of texts) {
    const words = contentWords(text);
    if (words.length < 2) continue;
    if (seenThisSession.some((prior) => sameTeaching(words, prior))) continue;
    seenThisSession.push(words);
    const match = store.find((r) => sameTeaching(words, r.words));
    if (match) {
      echoes.push({ text, priorSessions: match.count, firstAt: match.firstAt });
      match.count += 1;
      match.lastAt = at;
    } else {
      echoes.push({ text, priorSessions: 0, firstAt: at });
      store.push({ words, count: 1, firstAt: at, lastAt: at, sample: text.slice(0, SAMPLE_CHARS) });
    }
  }
  if (seenThisSession.length > 0) {
    // keep the most recently taught, so the store stays bounded without ever
    // dropping something the developer is actively repeating
    const trimmed = store.sort((a, b) => b.lastAt.localeCompare(a.lastAt)).slice(0, STORE_LIMIT);
    writeFileAtomic(teachingsFile(home), JSON.stringify(trimmed, null, 2) + "\n");
  }
  return echoes;
}
