/** How many squares a change weight draws, the way GitHub weighs a file in a request. */
export const SQUARES = 5;

/** Lines a filled square stands for: a one-line fix fills one, a change of thirty lines or more fills all five. */
const LINES_A_SQUARE = 6;

export interface Weight { added: number; removed: number; empty: number }

/**
 * The squares of a change: as many filled as its size earns, split between added and removed in
 * proportion, the rest empty. A change of no lines fills none.
 */
export function weightOf(added: number, removed: number): Weight {
  const lines = added + removed;
  if (lines <= 0) return { added: 0, removed: 0, empty: SQUARES };
  const filled = Math.min(SQUARES, Math.ceil(lines / LINES_A_SQUARE));
  const green = Math.round((added / lines) * filled);
  return { added: green, removed: filled - green, empty: SQUARES - filled };
}
