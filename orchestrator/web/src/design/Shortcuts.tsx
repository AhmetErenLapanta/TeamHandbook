import { useEffect, useRef, useState } from "react";
import { navigate, pathIn } from "../router";
import { goKey, readKey, typingIn } from "./keys";
import type { Tab } from "./keys";

/** How long "g" waits for the letter of the tab it goes to. */
const THEN_MS = 1500;

const MOD = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl";

/**
 * The keyboard shortcuts every page shares, and the list "?" opens: "/" and Cmd/Ctrl+K to search,
 * "g" and a tab's first letter to go there.
 */
export function Shortcuts({ org, tabs, onSearch }: { org: string; tabs: readonly Tab[]; onSearch: (anywhere: boolean) => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    let afterG = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      // Cmd or Ctrl with K searches from anywhere, a field included; a plain key is a field's own.
      if (e.defaultPrevented || e.altKey || (!mod && typingIn(e.target)) || dialog.current?.open) return;
      const action = readKey(e.key, afterG, tabs, mod);
      afterG = false;
      clearTimeout(timer);
      if (!action) return;
      e.preventDefault();
      if (action.kind === "then") {
        afterG = true;
        timer = setTimeout(() => { afterG = false; }, THEN_MS);
      } else if (action.kind === "help") setOpen(true);
      else if (action.kind === "search") onSearch(action.anywhere);
      else navigate(pathIn(org, action.section));
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      clearTimeout(timer);
    };
  }, [org, tabs, onSearch]);
  useEffect(() => {
    if (open && !dialog.current?.open) dialog.current?.showModal();
  }, [open]);
  return (
    <dialog ref={dialog} className="dialog" aria-labelledby="shortcuts-h" onClose={() => setOpen(false)}>
      {open ? (
        <>
          <div className="dialog-body">
            <h2 id="shortcuts-h">Keyboard shortcuts</h2>
            <dl className="shortcut-list">
              <div><dt><kbd>?</kbd></dt><dd>Show this list</dd></div>
              <div><dt><kbd>/</kbd></dt><dd>Search pages, projects and tasks, or this page's own list</dd></div>
              <div><dt><kbd>{MOD}</kbd> <kbd>K</kbd></dt><dd>Search pages, projects and tasks from anywhere, a field included</dd></div>
              {tabs.map((t) => <div key={t.section}><dt><kbd>g</kbd> <kbd>{goKey(t)}</kbd></dt><dd>Go to {t.label}</dd></div>)}
              <div><dt><kbd>Esc</kbd></dt><dd>Close a menu or this list</dd></div>
            </dl>
          </div>
          <form method="dialog" className="dialog-foot"><button type="submit">Close</button></form>
        </>
      ) : null}
    </dialog>
  );
}
