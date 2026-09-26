// The tiers a model reply passes through, derived from the reply itself.
//
// `harvestSession`'s summary reports what the SIEVE dropped and by which reason, but an
// element `parseItem` refused never appears in it at all - so "the model returned nothing"
// and "everything it returned was refused for evidence it had invented" are the same number
// there. That difference matters more than any other tier, because a refused correction
// means the model put words in the developer's mouth.
//
// These live apart from the runner so the deterministic test can import them: `run.ts` calls
// `main()` at the top level, so importing it would start a measurement.
import { balancedArrayAt } from "../../src/lib/harvest.js";

/**
 * Why an element the model emitted never became an item. `harvestSession`'s summary cannot
 * answer this: it reports what the SIEVE dropped and by which reason, but an element
 * `parseItem` refused never appears in it at all, so "the model returned nothing" and
 * "everything it returned was refused for evidence it had invented" are the same number
 * there. That difference matters more than any other tier, because a refused correction
 * means the model put words in the developer's mouth.
 *
 * It mirrors `anchorIsSound` and `parseItem` rather than calling them, neither of which is
 * exported. A mirror can drift, so it is checked rather than trusted: it has to accept
 * exactly as many elements as `parseHarvestResponse` kept, and the run says so when it
 * does not.
 */
export type Refusal = "accepted" | "bad-kind" | "ungrounded-quote" | "unknown-pair" | "schema";

const HARVEST_KIND_NAMES = ["procedure", "correction", "error-fix", "discovery"];
const MIN_QUOTE_CHARS = 12;
const CRITERIA = ["recurrence", "unfindability", "generality", "durability", "costOfError"];

function foldForMatch(text: string): string {
  return text
    .toLowerCase()
    .replace(/['’`"“”]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function quoteIsGrounded(quote: string, haystacks: string[]): boolean {
  const needle = foldForMatch(quote);
  if (needle.length < MIN_QUOTE_CHARS) return false;
  if (haystacks.some((hay) => hay.includes(needle))) return true;
  const pieces = needle.split(/\s*(?:\.\.\.|…)\s*/).map((p) => p.trim()).filter(Boolean);
  return pieces.length > 1 && pieces.every((piece) => haystacks.some((hay) => hay.includes(piece)));
}

export interface Grounding {
  slice: string;
  corrections: string[];
  pairFingerprints: Set<string>;
}

export function classifyRefusal(raw: unknown, grounding: Grounding): Refusal {
  if (typeof raw !== "object" || raw === null) return "schema";
  const o = raw as Record<string, unknown>;
  if (typeof o.kind !== "string" || !HARVEST_KIND_NAMES.includes(o.kind)) return "bad-kind";
  const haystacks = [foldForMatch(grounding.slice), ...grounding.corrections.map(foldForMatch)];
  if (o.kind === "correction" && !(typeof o.quote === "string" && quoteIsGrounded(o.quote, haystacks))) {
    return "ungrounded-quote";
  }
  if (o.kind === "error-fix") {
    const fingerprint = (typeof o.source === "string" ? o.source : "").match(/^pair:([0-9a-f]{16})$/)?.[1];
    if (!fingerprint || !grounding.pairFingerprints.has(fingerprint)) return "unknown-pair";
  }
  for (const key of ["name", "description", "body", "expect"]) {
    if (typeof o[key] !== "string" || !(o[key] as string).trim()) return "schema";
  }
  if (o.scope !== "team" && o.scope !== "project") return "schema";
  const scores = o.scores;
  if (typeof scores !== "object" || scores === null) return "schema";
  for (const criterion of CRITERIA) {
    const value = (scores as Record<string, unknown>)[criterion];
    if (typeof value !== "number" || value < 0 || value > 2) return "schema";
  }
  return "accepted";
}

/** The elements of the model's array, or null when the reply held no readable array. */
export function rawElements(raw: string): unknown[] | null {
  for (
    let attempt = 0, from = raw.indexOf("[");
    attempt < 5 && from !== -1;
    attempt += 1, from = raw.indexOf("[", from + 1)
  ) {
    const candidate = balancedArrayAt(raw, from);
    if (!candidate) continue;
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      // that bracket opened inside prose; try the next one
    }
  }
  return null;
}
