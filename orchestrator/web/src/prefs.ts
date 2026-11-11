import { useEffect, useState } from "react";

// Per-browser conveniences only: a private window, blocked storage or another browser starts
// from the defaults, and nothing here decides what anyone may see or do.
const memory = new Map<string, string | null>();
const CHANGED = "orchestrator:pref";

export function readPref(key: string): string | null {
  if (memory.has(key)) return memory.get(key)!;
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writePref(key: string, value: string | null): void {
  memory.set(key, value);
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    // Kept in memory for this page; the next visit starts from the default.
  }
  window.dispatchEvent(new Event(CHANGED));
}

export function usePref(key: string): [string | null, (value: string | null) => void] {
  const [value, setValue] = useState(() => readPref(key));
  useEffect(() => {
    const on = () => setValue(readPref(key));
    window.addEventListener(CHANGED, on);
    return () => window.removeEventListener(CHANGED, on);
  }, [key]);
  return [value, (next) => writePref(key, next)];
}

export type Theme = "system" | "light" | "dark";
export const THEME_KEY = "orchestrator.theme";

/** The colours follow the system unless someone picked one on this browser. */
export function applyTheme(theme: string | null): void {
  if (theme === "light" || theme === "dark") document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
}
