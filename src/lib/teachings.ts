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

/**
 * How much of the past this remembers. It was 200, from when only prompts matching a
 * teaching pattern were ever recorded and 200 of those was a long time. Now every
 * prompt that could carry a lesson is kept, and 200 turned out to be **two days** of
 * one real developer's history — a rule taught on Monday would be evicted before
 * Thursday's repeat, which is the one thing this file exists to catch.
 *
 * The new number is measured against the same history: ~19 records a day, so 2000 is
 * about three months. It costs nothing to hold — matching 40 prompts against a full
 * store takes 1ms, and the file lands under 400KB.
 */
export const STORE_LIMIT = 2000;
const SAMPLE_CHARS = 160;
const RECORD_VERSION = 2;

// Words that carry no meaning for matching. Deliberately short: an aggressive list
// would collapse unrelated teachings into each other, and a false echo is worse than
// a missed one — it inflates a score the user is trusting.
//
// This list is English and stays English. It is a refinement, not a requirement: a
// teaching in a language it knows nothing about keeps all of its words, and the
// "three shared content words" rule below is what stops two Turkish rules that share
// only "burada"/"asla" from reading as one. Measured across the pairs this file is
// built to separate, adding no second list costs nothing — which is the reason there
// is no second list, and no per-language burden waiting to be taken on.
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

// Fuzzy word matching is for inflection, not for short words, where two unrelated
// tokens easily share most of their trigrams ("var"/"vars"/"vary").
const FUZZY_MIN_CHARS = 5;
// Measured on the pairs it has to tell apart: inflection and plurals land at 0.82 and
// above ("mocklamayız"/"mocklamayın" 0.82, "kullan"/"kullanın" 0.83,
// "testcontainer"/"testcontainers" 0.92), while two identifiers a digit apart land at
// 0.78 and below ("customer1"/"customer2", "module12"/"module13").
const FUZZY_OVERLAP = 0.8;

/**
 * Lowercased and accent-folded. The old form of this was `[^a-z0-9\s-]`, which did not
 * strip accents so much as delete the letters carrying them: every Turkish, Greek and
 * Cyrillic word came out as fragments, so a developer who teaches in their own language
 * had no working recurrence at all. Folding rather than merely keeping them is
 * deliberate — Turkish is routinely typed without its diacritics, and "değiştirme" and
 * "degistirme" have to land on one form or every second phrasing is a miss. Dotless ı
 * needs its own line: unlike ç/ğ/ö/ş/ü it has no decomposition, so NFD leaves it whole.
 */
function fold(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/ı/g, "i");
}

/** Content words, lightly stemmed. A developer never repeats a teaching word for
 * word: "mocks"/"mock" and "editing"/"edit" have to land on the same token or the
 * echo is missed, which is the failure that leaves the recurrence score a guess. */
export function matchTokens(text: string): string[] {
  const words = fold(text)
    // apostrophes close up ("don't" → "dont", "db'yi" → "dbyi"); every other
    // punctuation splits, or the contraction would survive as the fragment "don"
    .replace(/['’]/g, "")
    .replace(/[^\p{L}\p{N}\s-]/gu, " ")
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

function trigrams(token: string): Set<string> {
  const padded = ` ${token} `;
  const grams = new Set<string>();
  for (let i = 0; i + 3 <= padded.length; i++) grams.add(padded.slice(i, i + 3));
  return grams;
}

/**
 * One word inflected two ways. The stemmer above knows English endings and nothing
 * else, which leaves an agglutinative language — where "mocklama", "mocklamayız" and
 * "mocklamayın" are one word wearing three suffixes — with no way to match itself.
 * Character-trigram overlap of the shorter side gets there without knowing whose
 * grammar it is looking at, and without a stemmer per language.
 */
function sameWord(a: string, b: string): boolean {
  if (a === b) return true;
  if (Math.min(a.length, b.length) < FUZZY_MIN_CHARS) return false;
  // A token carrying digits is an identifier, a version or a path fragment, and there
  // no suffix is being inflected — the digit IS the meaning, so "topic203" and
  // "topic204" are two things, not one word twice.
  if (/\d/.test(a) || /\d/.test(b)) return false;
  const [ga, gb] = [trigrams(a), trigrams(b)];
  let shared = 0;
  for (const gram of ga) if (gb.has(gram)) shared += 1;
  return shared / Math.min(ga.size, gb.size) >= FUZZY_OVERLAP;
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
  let shared = 0;
  for (const word of a) if (b.some((other) => sameWord(word, other))) shared += 1;
  const shorter = Math.min(a.length, b.length);
  return shared === shorter || (shared >= 3 && shared / shorter >= 0.5);
}

export interface TeachingRecord {
  words: string[];
  count: number;
  firstAt: string;
  lastAt: string;
  sample: string;
  v?: number;
}

export function teachingsFile(home: string = handbookHome()): string {
  return join(home, "teachings.json");
}

export function readTeachings(home: string = handbookHome()): TeachingRecord[] {
  try {
    const parsed = JSON.parse(readFileSync(teachingsFile(home), "utf8"));
    if (!Array.isArray(parsed)) return [];
    return (
      parsed
        .filter(
          (r): r is TeachingRecord =>
            Array.isArray(r?.words) &&
            typeof r?.count === "number" &&
            typeof r?.firstAt === "string",
        )
        // Records written before the tokenizer kept non-ASCII letters hold the
        // fragments it left behind. The sample is the original text, so re-derive from
        // it rather than leave the developer's own history unmatchable.
        .map((r) =>
          r.v === RECORD_VERSION || typeof r.sample !== "string"
            ? r
            : { ...r, words: matchTokens(r.sample), v: RECORD_VERSION },
        )
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
 * Match this session's prompts against everything recorded before, then fold them in.
 * One call, because the two halves must not be split: reading after writing would
 * report every prompt as an echo of itself.
 *
 * What arrives here is every prompt the session captured, not a pre-filtered set of
 * "teachings". Deciding which sentence states a rule is the model's job — the only
 * detector that could do it before the call was a list of English phrases, which is
 * exactly what left every other language unserved. Noise in the store is harmless,
 * because nothing is ever read out of it except by matching against a lesson the model
 * has already chosen to propose.
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
    const words = matchTokens(text);
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
      store.push({
        words,
        count: 1,
        firstAt: at,
        lastAt: at,
        sample: text.slice(0, SAMPLE_CHARS),
        v: RECORD_VERSION,
      });
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
