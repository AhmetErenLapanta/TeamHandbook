import { useEffect, useState } from "react";
import { ConfirmAction } from "./Confirm";
import type { ReactNode } from "react";
import { usePref } from "./prefs";
import { sentence } from "./said";
import { Loading, LoadFailed } from "./Status";
import { ChangeCounts } from "./ChangeCounts";
import { ChangeWeight } from "./design/ChangeWeight";
import { DiffPatch, PatchLines, useMoreRight } from "./design/DiffPatch";
import { quoteOf } from "./diff-quote";
import type { Quote } from "./diff-quote";
import type { ChangedFile, ChangeReads, FilePatch, RequestChanges } from "./request-reads";

const HIDE_TESTS_KEY = "orchestrator.diff.hide-tests";

const STATUS: Record<ChangedFile["status"], string> = { added: "added", modified: "changed", deleted: "deleted", renamed: "renamed" };

/** A path that may break after any of its slashes, so a narrow screen cuts it between folders rather than inside a name. */
function breakable(path: string): ReactNode[] {
  return path.split("/").flatMap((part, i, all) => (i < all.length - 1 ? [part, "/", <wbr key={i} />] : [part]));
}

/**
 * A file's patch as DiffPatch draws it, where lines selected with the mouse or the keyboard become
 * a quote the person adds to a follow-up for the agent; nothing is quoted until they press for it.
 */
function QuotablePatch({ path, patch, onQuote }: { path: string; patch: string; onQuote: (quote: Quote) => void }) {
  const [box, more] = useMoreRight<HTMLPreElement>();
  const [pending, setPending] = useState<Quote | null>(null);
  const lineOf = (node: Node | null) => {
    const at = (node instanceof Element ? node : node?.parentElement)?.closest<HTMLElement>("[data-i]");
    return at && box.current?.contains(at) ? Number(at.dataset.i) : null;
  };
  const read = () => {
    const picked = window.getSelection();
    const from = picked && !picked.isCollapsed ? lineOf(picked.anchorNode) : null;
    const to = picked && !picked.isCollapsed ? lineOf(picked.focusNode) : null;
    setPending(from === null || to === null ? null : quoteOf(path, patch, from, to));
  };
  return (
    <>
      <div className="patch-scroll" data-more-right={more || undefined}>
        <pre ref={box} className="pre mono diff-patch" onMouseUp={read} onKeyUp={read}>
          <PatchLines patch={patch} />
        </pre>
      </div>
      {pending ? (
        <div className="actions">
          <button type="button" className="secondary small" onClick={() => {
            onQuote(pending);
            setPending(null);
            window.getSelection()?.removeAllRanges();
          }}>Quote lines {pending.lines} in a follow-up</button>
        </div>
      ) : null}
    </>
  );
}


export const UNDO_WHY = { label: "Why", note: "Goes in the task's log" };

/** One changed file, folded; its patch is read the first time it opens. `onDrop` takes it out of the request and `onUndo` puts it back in place, each asked first; an undone file says so and offers neither. */
function FileRow({ file, read, onQuote, onDrop, onUndo, undone = false, ownCopy = false, opened = false }: { file: ChangedFile; read: (path: string) => Promise<FilePatch>; onQuote: ((quote: Quote) => void) | undefined; onDrop?: (path: string) => Promise<unknown>; onUndo?: (path: string, why: string) => Promise<unknown>; undone?: boolean; ownCopy?: boolean; opened?: boolean }) {
  const [patch, setPatch] = useState<FilePatch | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const open = (now: boolean) => {
    if (now && !patch && !problem && !file.binary) read(file.path).then(setPatch, (e: Error) => setProblem(e.message));
  };
  useEffect(() => open(opened), []);
  // On one person's own orchestrator the request is its own copy's, so a file's change is discarded from the task's branch, never taken out of a request.
  const dropWords = ownCopy
    ? {
      trigger: "Discard this file's change…",
      triggerLabel: `Discard the change to ${file.path}`,
      consequence: file.status === "added" ? `${file.path} is dropped from the task's branch; the other files stay as they are.` : `${file.path} goes back to how it was before the task on the task's branch; the other files stay as they are.`,
      confirm: "Discard its change",
      keep: "Keep it",
    }
    : {
      trigger: "Take out of the request…",
      triggerLabel: `Take ${file.path} out of the request`,
      consequence: file.status === "added" ? "The file is deleted from the request's branch in one commit, and the request is checked again." : "The file goes back to how it was before the task, in one commit on the request's branch, and the request is checked again.",
      confirm: "Take it out",
      keep: "Keep it in",
    };
  return (
    <li>
      <details open={opened} onToggle={(e) => open((e.currentTarget as HTMLDetailsElement).open)}>
        <summary>
          <span className="mono">{breakable(file.previousPath && file.status === "renamed" ? `${file.previousPath} → ${file.path}` : file.path)}</span>{" "}
          <span className="muted small">{undone ? "undone" : STATUS[file.status]}{file.binary ? ", binary" : null}</span>
          {file.binary || undone ? null : <>{" "}<span className="diff-stat"><ChangeWeight added={file.additions ?? 0} removed={file.deletions ?? 0} /> <ChangeCounts added={file.additions ?? 0} removed={file.deletions ?? 0} /></span></>}
        </summary>
        {file.binary ? <p className="muted small">A binary file; its contents are not shown.</p>
          : problem ? <p className="muted small">{problem}</p>
            : !patch ? <Loading what="the patch" />
              : patch.patch === null ? null
                : onQuote ? <QuotablePatch path={file.path} patch={patch.patch} onQuote={onQuote} /> : <DiffPatch patch={patch.patch} />}
        {patch?.note ? <p className="muted small">{sentence(patch.note)}</p> : null}
        {onUndo && !undone ? (
          <div className="actions">
            <ConfirmAction
              small
              trigger="Undo this file…"
              triggerLabel={`Undo ${file.path}`}
              consequence={file.status === "added" ? `${file.path} is deleted; the other files stay as they are.` : `${file.path} goes back to how it was before the task; the other files stay as they are.`}
              confirm="Undo this file"
              keep="Keep it"
              reason={UNDO_WHY}
              onConfirm={(why) => onUndo(file.path, why)}
            />
          </div>
        ) : null}
        {onDrop ? (
          <div className="actions">
            <ConfirmAction
              small
              {...dropWords}
              onConfirm={() => onDrop(file.path)}
            />
          </div>
        ) : null}
      </details>
    </li>
  );
}

// Where the changes are the page, a short list opens every patch; a long one opens none, so a page of fifty files reads one patch at a time.
const OPEN_AT_MOST = 10;

/**
 * A request's changes, file by file, folded until opened: what each file gains and loses, and its
 * patch as the forge would show it. Read when the fold opens, since most rows are never opened.
 * `bare` shows them with no fold of their own, under a heading that already says what they are.
 */
export function RequestDiff({ reads: given, open = false, bare = false, onClosed, onQuote, onDrop, onUndo, undone = [], ownCopy = false, onRead }: { reads: ChangeReads; open?: boolean; bare?: boolean; onClosed?: () => void; onQuote?: (quote: Quote) => void; onDrop?: (path: string) => Promise<unknown>; onUndo?: (path: string, why: string) => Promise<unknown>; undone?: string[]; ownCopy?: boolean; onRead?: (read: boolean) => void }) {
  const [reads] = useState(() => given);
  const [read, setRead] = useState<RequestChanges | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [hideTests, setHideTests] = usePref(HIDE_TESTS_KEY);
  const load = (open: boolean, again = false) => {
    if (!open || read || (problem && !again)) return;
    setProblem(null);
    reads.changes().then((r) => {
      setRead(r);
      onRead?.(true);
    }, (e: Error) => {
      setProblem(e.message);
      onRead?.(false);
    });
  };
  useEffect(() => load(open || bare), [open, bare]);
  const shown = read ? (hideTests === "yes" ? read.files.filter((f) => !f.test) : read.files) : [];
  const tests = read ? read.files.filter((f) => f.test).length : 0;
  const body = problem ? <LoadFailed what="the changes" reason={problem} onRetry={() => load(true, true)} /> : !read ? <Loading what="the changes" /> : (
    <>
      {/* Under a heading that counts the files, with each row's own counts, a sum would be a third count of the same. */}
      {bare ? (read.omitted ? <p className="muted small">{read.omitted} more not shown.</p> : null) : (
        <p className="muted small">
          {read.files.length} {read.files.length === 1 ? "file" : "files"}, +{read.files.reduce((n, f) => n + (f.additions ?? 0), 0)} −{read.files.reduce((n, f) => n + (f.deletions ?? 0), 0)}
          {read.omitted ? `; ${read.omitted} more not shown` : ""}
        </p>
      )}
      {tests ? <label className="check small"><input type="checkbox" checked={hideTests === "yes"} onChange={(e) => setHideTests(e.target.checked ? "yes" : null)} />Hide test files ({tests})</label> : null}
      <ul className="plain diff-files">
        {shown.map((f) => <FileRow key={f.path} file={f} read={reads.file} onQuote={onQuote} {...(onDrop ? { onDrop } : {})} {...(onUndo ? { onUndo } : {})} undone={undone.includes(f.path)} ownCopy={ownCopy} opened={bare && shown.length <= OPEN_AT_MOST && !undone.includes(f.path)} />)}
      </ul>
      {read.untracked?.length ? (
        <>
          <p className="muted small">The orchestrator keeps no copy of these files, such as one that looks like it holds a secret, so Undo leaves them as the agent left them.</p>
          <ul className="plain">{read.untracked.map((u) => <li key={u.path} className="mono small">{u.path}</li>)}</ul>
        </>
      ) : null}
    </>
  );
  if (bare) return <div className="request-diff">{body}</div>;
  return (
    <details className="request-diff" open={open} onToggle={(e) => {
      const now = (e.currentTarget as HTMLDetailsElement).open;
      load(now);
      if (!now) onClosed?.();
    }}>
      <summary>Changes</summary>
      {body}
    </details>
  );
}
