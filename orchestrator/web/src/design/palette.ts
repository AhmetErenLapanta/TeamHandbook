/**
 * Where the command palette can jump, and the group it is listed under. A folder opens as a project
 * first, so it carries `open`, which answers where to go; `inside` is what typing into it reads.
 */
export interface Jump { label: string; detail: string; to: string; group: Group; open?: () => Promise<string>; inside?: string; asked?: boolean }

export type Group = "Actions" | "Pages" | "Repositories" | "Folders" | "Tasks";

const GROUPS: readonly Group[] = ["Actions", "Pages", "Repositories", "Folders", "Tasks"];

/** Jumps a group lists at most: enough to pick from without the palette scrolling. */
export const MOST_A_GROUP = 5;

/**
 * The jumps that match what was typed, group by group: a label that starts with it before one that
 * only holds it, then the detail. Nothing typed matches nothing, so the palette opens empty.
 */
export function jumpsFor(jumps: readonly Jump[], query: string): Jump[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const score = (j: Jump) => {
    // The folders and what the orchestrator found were read for what was typed, so each one already matches it.
    if (j.group === "Folders" || j.asked) return 0;
    const label = j.label.toLowerCase();
    if (label.startsWith(needle)) return 0;
    if (label.includes(needle)) return 1;
    return j.detail.toLowerCase().includes(needle) ? 2 : null;
  };
  return GROUPS.flatMap((group) =>
    jumps
      .filter((j) => j.group === group)
      .flatMap((j) => {
        const s = score(j);
        return s === null ? [] : [{ j, s }];
      })
      .sort((a, b) => a.s - b.s)
      .slice(0, MOST_A_GROUP)
      .map((m) => m.j),
  );
}

/**
 * What the folder list is asked for what was typed: a path ending in "/" is the folder to look
 * inside; a path without one, its parent, keeping the names that start with its last part; anything
 * else, the words to search folders for. `~` stays as typed; the server reads it against home.
 */
export function folderAsk(query: string): { under?: string; prefix?: string; q?: string } | null {
  const typed = query.trim();
  if (!typed) return null;
  if (!/^(~|\/)/.test(typed)) return { q: typed };
  if (typed === "~" || typed.endsWith("/")) return { under: typed === "~" ? "~" : typed.replace(/\/+$/, "") || "/" };
  const cut = typed.lastIndexOf("/");
  return { under: typed.slice(0, cut) || (typed.startsWith("~") ? "~" : "/"), prefix: typed.slice(cut + 1) };
}

/** One folder up from a path that ends in "/", as Backspace takes it there: `~/code/shop/` is `~/code/`. */
export function folderUp(query: string): string | null {
  if (!/^(~|\/).*\/$/.test(query) || query === "/" || query === "~/") return null;
  const parent = query.replace(/[^/]+\/$/, "");
  return parent === "~" ? "~/" : parent;
}
