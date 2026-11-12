import { useEffect, useId, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { navigate } from "../router";
import { folderUp, jumpsFor } from "./palette";
import type { Group, Jump } from "./palette";

const groupsOf = (found: Jump[]) => [...new Set(found.map((j) => j.group))].map((group): [Group, Jump[]] => [group, found.filter((j) => j.group === group)]);

/** How long typing pauses before the folders are read for it. */
const FOLDER_DELAY_MS = 150;

/**
 * The one search: a dialog that jumps to a page, a project, a folder or a task by keyboard. The
 * arrow keys move, Enter opens, Esc closes. What is read only when it opens (the tasks) comes from
 * more; the folders, on one person's own machine, are read for what is typed: the right arrow looks
 * inside the folder, Backspace after a "/" goes up one, and a folder opens as a project on Enter.
 */
export function CommandPalette({ open, onClose, jumps, more, folders, finds }: { open: boolean; onClose: () => void; jumps: readonly Jump[]; more?: () => Promise<Jump[]>; folders?: (query: string) => Promise<Jump[]>; finds?: (query: string) => Promise<Jump[]> }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [query, setQuery] = useState("");
  const [read, setRead] = useState<Jump[]>([]);
  const [at, setAt] = useState(0);
  const [inFolders, setInFolders] = useState<Jump[]>([]);
  const [found_, setFound] = useState<Jump[]>([]);
  const [refused, setRefused] = useState<string | null>(null);
  const listId = useId();
  useEffect(() => {
    setRefused(null);
    if (!open || !folders || !query.trim()) return setInFolders([]);
    let current = true;
    const timer = setTimeout(() => void folders(query).then((found) => current && setInFolders(found), () => current && setInFolders([])), FOLDER_DELAY_MS);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [open, folders, query]);
  // The orchestrator's own search, for what the newest page of tasks does not hold: older tasks, an issue key, a word of the agent's.
  useEffect(() => {
    if (!open || !finds || !query.trim()) return setFound([]);
    let current = true;
    const timer = setTimeout(() => void finds(query).then((found) => current && setFound(found), () => current && setFound([])), FOLDER_DELAY_MS);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [open, finds, query]);
  useEffect(() => {
    const box = dialog.current;
    if (!box) return;
    if (open && !box.open) {
      setQuery("");
      setAt(0);
      box.showModal();
      void more?.().then(setRead, () => setRead([]));
    } else if (!open && box.open) box.close();
  }, [open, more]);
  const found = jumpsFor([...jumps, ...read, ...inFolders, ...found_.filter((j) => !read.some((r) => r.to === j.to))], query);
  const active = found[Math.min(at, found.length - 1)];
  const go = (jump: Jump) => {
    // A folder becomes a project before it is opened; a folder it cannot be is said here, and the palette stays.
    if (jump.open) {
      jump.open().then((to) => {
        onClose();
        navigate(to);
      }, (e: Error) => setRefused(e.message));
      return;
    }
    onClose();
    navigate(jump.to);
  };
  const atEnd = (e: KeyboardEvent<HTMLInputElement>) => e.currentTarget.selectionStart === e.currentTarget.value.length && e.currentTarget.selectionEnd === e.currentTarget.value.length;
  const typeIn = (text: string) => {
    setQuery(text);
    setAt(0);
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setAt((now) => Math.min(Math.max(now + (e.key === "ArrowDown" ? 1 : -1), 0), Math.max(found.length - 1, 0)));
    } else if (e.key === "ArrowRight" && active?.inside && atEnd(e)) {
      e.preventDefault();
      typeIn(active.inside);
    } else if (e.key === "Backspace" && atEnd(e) && folders && folderUp(query)) {
      e.preventDefault();
      typeIn(folderUp(query)!);
    } else if (e.key === "Enter" && active) {
      e.preventDefault();
      go(active);
    } else if (e.key === "Escape") {
      // A search field takes the first Esc to clear itself; the palette closes on it instead.
      e.preventDefault();
      onClose();
    }
  };
  const optionId = (i: number) => `${listId}-${i}`;
  return (
    <dialog ref={dialog} className="palette" aria-label="Search" onClose={onClose} onClick={(e) => { if (e.target === dialog.current) onClose(); }}>
      {open ? (
        <>
          <input
            type="search"
            aria-label={folders ? "Search pages, projects, folders and tasks" : "Search pages, projects and tasks"}
            placeholder={folders ? "Search pages, projects, folders and tasks" : "Search pages, projects and tasks"}
            autoComplete="off"
            value={query}
            aria-controls={listId}
            aria-activedescendant={active ? optionId(found.indexOf(active)) : undefined}
            onChange={(e) => typeIn(e.target.value)}
            onKeyDown={onKey}
          />
          <p className="visually-hidden" role="status">{query.trim() ? (found.length ? `${found.length} found` : "Nothing found") : ""}</p>
          {found.length ? (
            <div id={listId} role="listbox" aria-label="Found" className="palette-list">
              {groupsOf(found).map(([group, items]) => (
                <div key={group} role="group" aria-labelledby={`${listId}-${group}`}>
                  <p id={`${listId}-${group}`} className="palette-group">{group}</p>
                  {items.map((jump) => (
                    <div key={jump.to} id={optionId(found.indexOf(jump))} role="option" aria-selected={jump === active} className="palette-option" onMouseDown={(e) => e.preventDefault()} onClick={() => go(jump)}>
                      <span className={jump.group === "Folders" ? "palette-label mono" : "palette-label"}>{jump.label}</span>
                      {jump.detail ? <span className="palette-detail">{jump.detail}</span> : null}
                    </div>
                  ))}
                </div>
              ))}
            </div>
          ) : (
            <p className="palette-note">{query.trim() ? `Nothing matches “${query.trim()}”.` : folders ? "Type a page, a project, a task, or a folder's path from ~/." : "Type a page, a project or a task."}</p>
          )}
          {refused ? <p className="error" role="alert">{refused}</p> : null}
        </>
      ) : null}
    </dialog>
  );
}
