// Fence inspection for the structural layer. Deliberately does NOT reuse
// prompt-safety.ts's own LINE_TERMINATORS or its sentinel regex: an assertion that
// shares the code's definition of "a line" cannot find a terminator the code forgot,
// and one that compares exact strings cannot find a lookalike sentinel. Both
// definitions live here, side by side, and the tests report them separately.
import {
  foldForDelimiterMatch,
  UNTRUSTED_OPEN,
  UNTRUSTED_CLOSE,
} from "../../src/lib/prompt-safety.js";
import { CR, FF, LF, LS, NEL, PS, VT } from "./chars.js";

/** what prompt-safety.ts calls a line break (LINE_TERMINATORS), and what
 * transcript.ts's /m role-label pass agrees with */
export const PRODUCT_LINE_BREAKS = new RegExp(`${CR}${LF}|[${LF}${CR}${LS}${PS}]`, "g");

/** every mandatory break in the Unicode line-breaking algorithm. The three the
 * product's definition leaves out - NEL, FORM FEED, VERTICAL TAB - are the reason this
 * second definition exists. */
export const STRICT_LINE_BREAKS = new RegExp(
  `${CR}${LF}|[${LF}${CR}${VT}${FF}${NEL}${LS}${PS}]`,
  "g",
);

export type LineRule = "product" | "strict";

export function splitLines(text: string, how: LineRule): string[] {
  return text.split(how === "strict" ? STRICT_LINE_BREAKS : PRODUCT_LINE_BREAKS);
}

/**
 * Fold text down to what a reader SEES, so a sentinel a model could plausibly read as the
 * real delimiter is counted even though no exact-string match will ever see it.
 *
 * The invisible-and-confusable half is the PRODUCT's own fold, imported rather than
 * rewritten. This file used to carry a second hand-written copy, and the two had different
 * blind spots: the copy here folded three characters the product did not, and neither of
 * them folded the astral compatibility block at all, so the corpus reported "the list
 * shortened" about a class it never tested. One fold, one blind spot, and the blind spot is
 * visible in one place.
 *
 * Two differences remain, both deliberate and both making this STRICTER than the product:
 * whitespace is collapsed and case is folded. That is why `fence-space` is still a pinned
 * finding - the product does not collapse whitespace inside a delimiter, on purpose, and
 * this assertion says so out loud instead of agreeing by construction.
 */
export function foldConfusables(text: string): string {
  return foldForDelimiterMatch(text).replace(/\s+/g, "").toUpperCase();
}

const FOLDED_OPEN = foldConfusables(UNTRUSTED_OPEN);
const FOLDED_CLOSE = foldConfusables(UNTRUSTED_CLOSE);

function countOf(haystack: string, needle: string): number {
  return needle ? haystack.split(needle).length - 1 : 0;
}

export interface FenceRegion {
  /** the text between an OPEN and its CLOSE, sentinels excluded */
  body: string;
  /** the label lines the fence itself emitted, in order */
  labels: string[];
}

export interface PromptShape {
  /** exact-string sentinel occurrences, in the order they appear */
  order: Array<"open" | "close">;
  /** every exact-string occurrence, counted independently of the pair scan. A payload
   * that rejoins into a closing sentinel raises this without disturbing `order`, so the
   * two numbers have to be read together. */
  rawOpen: number;
  rawClose: number;
  fences: FenceRegion[];
  /** everything outside every fence: the prompt's own instructions */
  instructionRegions: string[];
}

/**
 * Split a built prompt into fences and instruction regions. Balanced-pair scan on the
 * exact sentinels, which is what the product actually emits; an unbalanced result is
 * itself the finding, so this reports rather than throws.
 */
export function shapeOf(prompt: string): PromptShape {
  const order: Array<"open" | "close"> = [];
  const fences: FenceRegion[] = [];
  const instructionRegions: string[] = [];
  let cursor = 0;
  for (;;) {
    const open = prompt.indexOf(UNTRUSTED_OPEN, cursor);
    if (open === -1) break;
    instructionRegions.push(prompt.slice(cursor, open));
    order.push("open");
    const bodyStart = open + UNTRUSTED_OPEN.length;
    const close = prompt.indexOf(UNTRUSTED_CLOSE, bodyStart);
    if (close === -1) {
      fences.push({ body: prompt.slice(bodyStart), labels: [] });
      cursor = prompt.length;
      break;
    }
    order.push("close");
    const body = prompt.slice(bodyStart, close);
    fences.push({ body, labels: labelLinesOf(body) });
    cursor = close + UNTRUSTED_CLOSE.length;
  }
  instructionRegions.push(prompt.slice(cursor));
  return {
    order,
    rawOpen: countOf(prompt, UNTRUSTED_OPEN),
    rawClose: countOf(prompt, UNTRUSTED_CLOSE),
    fences,
    instructionRegions,
  };
}

/** Lines at column 0 inside a fence body, by the given definition of a line. The fence
 * indents every value by two spaces, so these are supposed to be the fence's own
 * preamble and its field labels, and nothing else. */
export function columnZeroLines(body: string, how: LineRule): string[] {
  return splitLines(body, how)
    .map((line) => (line.endsWith(CR) ? line.slice(0, -1) : line))
    .filter((line) => line.trim() !== "" && !line.startsWith("  "));
}

function labelLinesOf(body: string): string[] {
  return columnZeroLines(body, "product").filter((line) => line.endsWith(":"));
}

/** Sentinel-shaped text still legible inside a fence body after folding away case,
 * width, invisibles and confusable capitals. */
export function lookalikeSentinels(body: string): number {
  const folded = foldConfusables(body);
  return countOf(folded, FOLDED_OPEN) + countOf(folded, FOLDED_CLOSE);
}

/** Where a canary occurs and whether its line was indented. The fence promises content
 * only ever appears indented; this checks that without printing the payload. */
export function canaryPlacement(
  prompt: string,
  canary: string,
  how: LineRule,
): { hits: number; unindented: number } {
  let hits = 0;
  let unindented = 0;
  for (const line of splitLines(prompt, how)) {
    if (!line.includes(canary)) continue;
    hits += 1;
    if (!line.startsWith("  ")) unindented += 1;
  }
  return { hits, unindented };
}
