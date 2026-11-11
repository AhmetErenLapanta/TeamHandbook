import type { Section } from "../router";

export interface Tab { section: Section; label: string }

export type KeyAction = { kind: "help" } | { kind: "search"; anywhere: boolean } | { kind: "then" } | { kind: "go"; section: Section } | null;

/** The key that follows "g" for a tab: its label's first letter, which no two of the top tabs share. */
export function goKey(tab: Tab): string {
  return tab.label.slice(0, 1).toLowerCase();
}

/**
 * What a key press does, given whether "g" was the press before it and whether Cmd or Ctrl was held.
 * Cmd or Ctrl with K opens the palette from anywhere; "/" is the page's own search where it has one.
 * Only the tabs this person is shown are reached, so a shortcut never opens a page the top bar hides
 * from them. Cmd or Ctrl with a digit is left to the browser, which switches its own tabs with it.
 */
export function readKey(key: string, afterG: boolean, tabs: readonly Tab[], mod = false): KeyAction {
  if (mod) return key.toLowerCase() === "k" ? { kind: "search", anywhere: true } : null;
  if (afterG) {
    const tab = tabs.find((t) => goKey(t) === key.toLowerCase());
    return tab ? { kind: "go", section: tab.section } : null;
  }
  if (key === "?") return { kind: "help" };
  if (key === "/") return { kind: "search", anywhere: false };
  if (key === "g") return { kind: "then" };
  return null;
}

/** A press meant for a field, a modified one, or one in an open menu is the page's, not a shortcut. */
export function typingIn(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName) || target.closest("[role='listbox'], [role='menu']") !== null;
}
