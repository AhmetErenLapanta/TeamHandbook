import type { KeyboardEvent } from "react";

const MOVES = ["ArrowDown", "ArrowUp", "Home", "End"];

/** Arrow keys, Home and End move focus between a listbox's options, so the list is one stop in the Tab order. */
export function moveInList(e: KeyboardEvent<HTMLElement>): void {
  if (!MOVES.includes(e.key)) return;
  const rows = [...e.currentTarget.querySelectorAll<HTMLElement>('[role="option"]')];
  if (!rows.length) return;
  e.preventDefault();
  const at = rows.indexOf(document.activeElement as HTMLElement);
  const next = e.key === "Home" ? 0 : e.key === "End" ? rows.length - 1 : Math.min(Math.max(at + (e.key === "ArrowDown" ? 1 : -1), 0), rows.length - 1);
  rows[next]?.focus();
}

/** The one option Tab reaches in a list: the picked one, else the first. */
export function tabStop(index: number, picked: number): 0 | -1 {
  return (picked >= 0 ? index === picked : index === 0) ? 0 : -1;
}
