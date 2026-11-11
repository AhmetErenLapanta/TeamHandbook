import { useEffect, useState } from "react";

export const SECTIONS = ["activity", "work", "repositories", "tasks", "team", "controls", "integrations", "settings", "welcome"] as const;
export type Section = (typeof SECTIONS)[number];

/** Where the browser is: the organization, the top section, and what follows it; `named` when the path names any section, known or not. */
export interface Place { org: string | null; section: Section | null; named: boolean; rest: string[] }

export function placeOf(pathname: string): Place {
  const [org, section, ...rest] = pathname.split("/").filter(Boolean).map(decodeURIComponent);
  return {
    org: org ?? null,
    section: (SECTIONS as readonly string[]).includes(section ?? "") ? (section as Section) : null,
    named: section !== undefined,
    rest,
  };
}

/** A path inside one organization. */
export function pathIn(org: string, ...parts: string[]): string {
  return `/${[org, ...parts].map(encodeURIComponent).join("/")}`;
}

/**
 * Where an address with no organization lands in the person's own: the installed app's shortcuts
 * name a page, and something shared to the app opens the task form with it as the work; anything
 * else is Activity.
 */
export function rootTarget(search: string, home: string): string {
  const params = new URLSearchParams(search);
  const shared = params.get("url")?.trim() || params.get("text")?.trim();
  if (shared) return `${pathIn(home, "work", "new")}?${new URLSearchParams({ issue: shared })}`;
  if (params.get("go") === "tasks") return pathIn(home, "tasks");
  if (params.get("go") === "my-work") return `${pathIn(home, "work")}?mine=1`;
  return pathIn(home, "tasks");
}

/**
 * Where a page that left the top bar lives now: Activity's overview and the list of projects are
 * Tasks, a project's requests are Your turn there, and Controls is Team, its policies under it.
 * Null for a page that stayed where it was.
 */
export function movedPath(org: string, section: Section | null, rest: string[]): string | null {
  if (section === "activity" && !rest.length) return pathIn(org, "tasks");
  if (section === "repositories" && (!rest.length || (rest.length === 1 && rest[0] === "requests"))) return pathIn(org, "tasks");
  if (section === "controls") return rest.length ? pathIn(org, "team", "policies", ...rest) : pathIn(org, "team");
  return null;
}

/** A path inside the organization the browser is on now, for screens that do not carry it. */
export function here(...parts: string[]): string {
  return pathIn(placeOf(window.location.pathname).org ?? "", ...parts);
}

/**
 * The path an address from before the top sections maps to. Bookmarks, links in team chats
 * and the sign-in redirect still carry `#/repo/...`, `#/tasks/...` and the like.
 */
export function legacyPath(hash: string, org: string): string | null {
  const [path] = hash.replace(/^#/, "").split("?");
  const [first, id] = (path ?? "").split("/").filter(Boolean);
  if (path === undefined || !path.startsWith("/") || first === "join") return null;
  if (first === "repo" && id) return pathIn(org, "repositories", id);
  if (first === "tasks") return id ? pathIn(org, "tasks", id) : pathIn(org, "tasks");
  if (first === "requests") return pathIn(org, "tasks");
  if (first === "people") return pathIn(org, "settings", "members");
  if (!first || first === "login") return pathIn(org, "tasks");
  return pathIn(org, ...path.split("/").filter(Boolean));
}

const MOVED = "orchestrator:navigate";

export function navigate(to: string, replace = false): void {
  if (replace) window.history.replaceState(null, "", to);
  else window.history.pushState(null, "", to);
  window.dispatchEvent(new Event(MOVED));
}

/** The current path and query, kept current across links, back and forward. */
export function useLocation(): { pathname: string; search: string; hash: string } {
  const read = () => ({ pathname: window.location.pathname, search: window.location.search, hash: window.location.hash });
  const [location, setLocation] = useState(read);
  useEffect(() => {
    const on = () => setLocation(read());
    window.addEventListener("popstate", on);
    window.addEventListener("hashchange", on);
    window.addEventListener(MOVED, on);
    return () => {
      window.removeEventListener("popstate", on);
      window.removeEventListener("hashchange", on);
      window.removeEventListener(MOVED, on);
    };
  }, []);
  return location;
}

/**
 * Follows a plain link to a page of this orchestrator without reloading it. A link that opens
 * elsewhere, in a new tab, or with a modifier key is left to the browser.
 */
export function followInApp(event: MouseEvent): void {
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  const link = (event.target as Element | null)?.closest?.("a");
  if (!link || link.target || link.hasAttribute("download")) return;
  const url = new URL(link.href, window.location.href);
  if (url.origin !== window.location.origin || url.pathname.startsWith("/api/")) return;
  if (url.hash && url.pathname === window.location.pathname && url.search === window.location.search) return;
  event.preventDefault();
  navigate(url.pathname + url.search + url.hash);
}
