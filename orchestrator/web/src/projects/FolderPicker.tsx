import { useEffect, useRef, useState } from "react";
import type { FormEvent, KeyboardEvent, ReactNode } from "react";
import { cloneName, homeRelative, looksLikePath, pastedPath, placeSteps, projectsRead } from "../projects-read";
import type { FolderEntry, FolderList, Project } from "../projects-read";
import { Hint } from "../Hint";
import { Loading, LoadFailed } from "../Status";

// A search waits for typing to stop, so one word is one read of the folders.
const SEARCH_DELAY_MS = 250;

/**
 * Where a task's change lands, said before the folder is opened: in the folder itself, or on a
 * branch of its own. The Git words are said only to someone whose folders have Git; to everyone
 * else the change is simply made in place.
 */
const WHERE_CHANGES = {
  none: "No Git: the agent changes its files in place, and you keep or undo each change.",
  git: "A Git repository: each task works on its own branch and ends in a request for review.",
  plain: "The agent changes a folder's files in place, and you keep or undo each change.",
} as const;

const repositories = (n: number) => (n === 1 ? "1 repository" : `${n} repositories`);

/** A folder that is no repository itself but holds some: each one a task changes gets a branch of its own. */
const manyRepositories = (n: number) => `A folder of ${repositories(n)}: each task works on its own branch of each one it changes and ends in a request for review.`;

/**
 * A browsing row goes into its folder and, focused, is the folder the foot's one Open acts on; a
 * suggested row is taken by its click. No row carries a button of its own: a Choose on every row
 * was a second action the eye had to sort from the first. A row in the list of one folder names
 * only its folder, since the place line above says where the list is; a suggestion or a match,
 * which can be anywhere under home, says its path too.
 */
function Row({ entry, home, selected, busy, withPath, withGit, onPick, onEnter, onBack, onFocus }: { entry: FolderEntry; home: string | null; selected: boolean; busy: boolean; withPath: boolean; withGit: boolean; onPick: () => void; onEnter?: () => void; onBack?: () => void; onFocus?: () => void }) {
  // Enter opens the folder, as the foot's Open would; the arrow keys look inside and climb out.
  const keys = (e: KeyboardEvent) => {
    if (e.key === "Enter" && onEnter) {
      e.preventDefault();
      onPick();
    } else if (e.key === "ArrowRight" && onEnter) {
      e.preventDefault();
      onEnter();
    } else if ((e.key === "ArrowLeft" || e.key === "Backspace") && onBack) {
      e.preventDefault();
      onBack();
    }
  };
  return (
    <li>
      <button type="button" className="folder-row" aria-selected={selected} disabled={busy} onClick={onEnter ?? onPick} onKeyDown={keys} onFocus={onFocus}>
        <span>
          <span className="folder-name" dir="auto">{entry.name}</span>
          {withPath ? <span className="folder-path" dir="auto">{homeRelative(entry.path, home)}</span> : null}
        </span>
        {withGit ? <span className="folder-git">{entry.repos ? repositories(entry.repos) : entry.git === "none" ? "No Git" : "Git"}</span> : <span />}
        {onEnter ? <span className="folder-into" aria-hidden="true" /> : <span />}
      </button>
    </li>
  );
}

/** A repository cloned with the person's own git sign-in, opened as a project once it is in place. */
function CloneForm({ home, onOpened, onCancel }: { home: string | null; onOpened: (project: Project, home: string | null) => void; onCancel: () => void }) {
  const [url, setUrl] = useState("");
  const [into, setInto] = useState("");
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  const name = cloneName(url);
  const clone = (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setRefused(null);
    projectsRead.clone(url.trim(), into.trim() ? pastedPath(into, home) : undefined).then(({ project }) => onOpened(project, home), (err: Error) => {
      setRefused(err.message);
      setBusy(false);
    });
  };
  return (
    <form className="form" onSubmit={clone} aria-label="Clone a repository">
      <label>Address<input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://github.com/team/shop" autoComplete="off" spellCheck={false} required /></label>
      <label>Place (optional)<input value={into} onChange={(e) => setInto(e.target.value)} placeholder={name ? `~/code/${name}` : "~/code/<name>"} autoComplete="off" spellCheck={false} /></label>
      <p className="muted small">Clones into {into.trim() || (name ? `~/code/${name}` : "~/code")} with your own git sign-in. <Hint label="cloning">An address over https or ssh. A folder already there is never written to.</Hint></p>
      {refused ? <p className="error" role="alert">{refused}</p> : null}
      <div className="actions">
        <button type="submit" disabled={busy || !url.trim()}>{busy ? "Cloning…" : "Clone"}</button>
        <button type="button" className="secondary" onClick={onCancel} disabled={busy}>Cancel</button>
      </div>
    </form>
  );
}

/**
 * The one question the first screen asks: which folder. It lists folders under home, the ones
 * that look like projects first, finds them by name, or takes a pasted path; picking one opens it
 * as a project through the server, which alone decides whether a folder may be one.
 */
/** Where a picker stands: the folder whose list it shows (none for home) and the home it reads paths from. */
export interface PickerPlace { under: string | undefined; home: string | null }

/** `where` names the machine the folders are on, as a plain label beside the path. */
export function FolderPicker({ onOpened, lead, selected, machine, where = "On this computer", from, verb = "Open" }: { onOpened: (project: Project, home: string | null, at: PickerPlace) => void; lead?: ReactNode; selected?: string; machine?: string; where?: string; from?: PickerPlace; verb?: "Open" | "Add" }) {
  const [list, setList] = useState<FolderList | null>(null);
  const [listFor, setListFor] = useState<string | undefined | null>(null);
  const [home, setHome] = useState<string | null>(from?.home ?? null);
  const [under, setUnder] = useState<string | undefined>(from?.under);
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [refused, setRefused] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [reads, setReads] = useState(0);
  const [cloning, setCloning] = useState(false);
  const [pasted, setPasted] = useState<string | null>(null);
  const [picked, setPicked] = useState<FolderEntry | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const searching = query.trim() && !looksLikePath(query) ? query.trim() : "";
  // A pasted path is the folder asked for: the list gives way to it, opened by its row or by Enter.
  const pastedAt = looksLikePath(query) ? query.trim() : "";
  useEffect(() => {
    let current = true;
    setError(null);
    setPicked(null);
    const timer = setTimeout(() => {
      projectsRead.folders({ ...(under ? { under } : {}), ...(searching ? { q: searching } : {}) }, machine).then((read) => {
        if (!current) return;
        setList(read);
        setListFor(under);
        // The first list, with no place asked for, is home's: every later step is shown from it.
        if (!under && !searching) setHome(read.under);
      }, (e: Error) => current && setError(e.message));
    }, searching ? SEARCH_DELAY_MS : 0);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [under, searching, reads, machine]);
  const open = (path: string) => {
    setBusy(true);
    setRefused(null);
    projectsRead.open(path, machine).then(({ project }) => onOpened(project, home, { under, home }), (e: Error) => setRefused(e.message)).finally(() => setBusy(false));
  };
  // A path from home pasted before the first list named home waits for it rather than reaching the server unexpanded.
  useEffect(() => {
    if (pasted === null || home === null) return;
    setPasted(null);
    open(pastedPath(pasted, home));
  }, [pasted, home]);
  // Up and down move between the rows, as in a list; Enter or a click opens the folder.
  const arrows = (e: KeyboardEvent) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const rows = [...(listRef.current?.querySelectorAll<HTMLButtonElement>("button.folder-row") ?? [])];
    if (!rows.length) return;
    e.preventDefault();
    const at = rows.indexOf(document.activeElement as HTMLButtonElement);
    rows[Math.min(Math.max(at + (e.key === "ArrowDown" ? 1 : -1), 0), rows.length - 1)]?.focus();
  };
  const place = list && home ? placeSteps(list.under, home) : [];
  const into = (path: string) => {
    setQuery("");
    setUnder(path === home ? undefined : path);
  };
  const back = place.length > 1 ? () => into(place[place.length - 2]!.path) : undefined;
  // Someone none of whose listed folders has Git is never shown the word: rows and the foot say "in place" alone.
  const listed = [...(list?.suggestions ?? []), ...(list?.folders ?? []), ...(list?.matches ?? [])];
  const usesGit = listed.some((f) => f.git !== "none" || Boolean(f.repos));
  const group = (title: string, entries: FolderEntry[], browse: boolean, withPath: boolean) =>
    entries.length ? (
      <>
        <h2 className="folder-group">{title}</h2>
        <ul className="folder-list">
          {entries.map((f) => <Row key={f.path} entry={f} home={home} selected={f.path === (picked?.path ?? selected)} busy={busy} withPath={withPath} withGit={usesGit} onPick={() => open(f.path)} {...(browse ? { onEnter: () => into(f.path), onFocus: () => setPicked(f) } : {})} {...(back ? { onBack: back } : {})} />)}
        </ul>
      </>
    ) : null;
  // The foot's one Open: the row picked, else the folder the list stands in; home itself is no project.
  const target: { name: string; path: string; git?: FolderEntry["git"]; repos?: number } | null = picked ?? (list && under && listFor === under && !searching ? { name: place[place.length - 1]?.label ?? list.under, path: list.under } : null);
  if (cloning) return <CloneForm home={home} onOpened={(project, at) => onOpened(project, at, { under, home })} onCancel={() => setCloning(false)} />;
  return (
    <div className="folder-picker" role="group" aria-label="Pick a folder">
      <div className="folder-picker-main">
        {lead}
        <div className="folder-picker-bar">
          {/* A field for a folder, not a second search; / and the bar's Search come here, so the page has one. */}
          <label>Folder name or path<input type="text" data-page-search placeholder="~/code/shop" value={query} onChange={(e) => setQuery(e.target.value)} autoComplete="off" spellCheck={false} onKeyDown={(e) => {
            if (e.key === "Enter" && looksLikePath(query)) {
              e.preventDefault();
              if (home === null && query.trim().startsWith("~")) setPasted(query);
              else open(pastedPath(query, home));
            } else arrows(e);
          }} /></label>
        </div>
        {list && !searching && !pastedAt ? (
          <p className="folder-place">
            <span className="folder-machine">{where}</span>
            <span className="folder-at" dir="auto">{homeRelative(list.under, home)}</span>
            {back ? <button type="button" className="ghost small folder-up" onClick={back}>Up one folder</button> : null}
          </p>
        ) : null}
        {refused ? <p className="error" role="alert">{refused}</p> : null}
        <div ref={listRef} onKeyDown={arrows}>
          {pastedAt ? (
            <>
              <h2 className="folder-group">This folder</h2>
              <ul className="folder-list">
                <li>
                  <button type="button" className="folder-row" disabled={busy} onClick={() => (home === null && pastedAt.startsWith("~") ? setPasted(pastedAt) : open(pastedPath(pastedAt, home)))}>
                    <span>
                      <span className="folder-name" dir="auto">{pastedAt.replace(/\/+$/, "").split("/").pop() || pastedAt}</span>
                      <span className="folder-path" dir="auto">{homeRelative(pastedPath(pastedAt, home), home)}</span>
                    </span>
                    <span className="muted small">{verb === "Add" ? "Enter adds it" : "Enter opens it"}</span>
                  </button>
                </li>
              </ul>
            </>
          ) : error ? <LoadFailed what="your folders" reason={error} onRetry={() => setReads((n) => n + 1)} />
            : !list ? <Loading what="your folders" />
              : searching ? (list.matches?.length ? group(`Matching “${searching}”`, list.matches, true, true) : <p className="muted">No folder under home is named like “{searching}”. Paste its path instead.</p>)
                : list.folders.length || list.suggestions.length ? (
                  <>
                    {under ? null : group("Suggested", list.suggestions.slice(0, 3), false, true)}
                    {group("Folders", list.folders, true, false)}
                  </>
                ) : (
                  <p className="muted">No folder here. Paste the path of the folder you work in.</p>
                )}
          {list?.truncated ? <p className="muted small">Some folders were left out; search by name to find one.</p> : null}
        </div>
        <div className="folder-picker-foot">
          {target && !pastedAt ? (
            <>
              {target.git ? <p className="muted">{target.repos ? manyRepositories(target.repos) : WHERE_CHANGES[target.git !== "none" ? "git" : usesGit ? "none" : "plain"]}</p> : null}
              <button type="button" disabled={busy} onClick={() => open(target.path)}>{verb} {target.name}</button>
            </>
          ) : null}
          {/* A clone lands on the orchestrator's own machine, so a connected machine's list offers none. */}
          {machine ? null : <button type="button" className="link" onClick={() => setCloning(true)}>Clone from GitHub or GitLab</button>}
        </div>
      </div>
    </div>
  );
}
