import { numberLines } from "./design/DiffPatch";

/** Lines of the diff a person points the agent at, with the file and the lines they cover. */
export interface Quote { path: string; lines: string; text: string }

/** Lines one quote carries at most: enough for a function, short of filling the agent's prompt. */
export const MOST_QUOTED = 40;
/** Characters one quote carries at most, as the orchestrator takes them. */
export const MOST_QUOTED_TEXT = 4_000;

const span = (numbers: number[]) => (numbers.length === 1 || numbers[0] === numbers.at(-1) ? `${numbers[0]}` : `${numbers[0]}-${numbers.at(-1)}`);

/**
 * The quote for the lines between two picked ones, in either order: the code lines only, named by
 * their lines after the change, or before it when every picked line was removed. Null when the
 * pick holds no code line.
 */
export function quoteOf(path: string, patch: string, from: number, to: number): Quote | null {
  const [first, last] = from <= to ? [from, to] : [to, from];
  const lines = numberLines(patch).slice(first, last + 1).filter((l) => l.kind === "add" || l.kind === "del" || (l.kind === "context" && l.new !== null)).slice(0, MOST_QUOTED);
  // Whole lines only, up to the most a quote carries: a cut line would be code the request does not hold.
  let size = 0;
  const picked = lines.filter((l) => (size += l.text.length + 1) <= MOST_QUOTED_TEXT + 1);
  if (!picked.length) return null;
  const after = picked.flatMap((l) => (l.new === null ? [] : [l.new]));
  const before = picked.flatMap((l) => (l.old === null ? [] : [l.old]));
  return { path, lines: after.length ? span(after) : `${span(before)} before the change`, text: picked.map((l) => l.text).join("\n") };
}
