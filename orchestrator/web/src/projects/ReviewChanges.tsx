import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { ApiError, tasksApi } from "../api";
import type { TaskRecord } from "../api";
import { ConfirmAction } from "../Confirm";
import { Hint } from "../Hint";
import { projectsRead } from "../projects-read";
import type { GitState } from "../projects-read";
import { machineChangeReads, taskChangeReads } from "../request-reads";
import { RequestDiff, UNDO_WHY } from "../RequestDiff";
import { CommitChanges } from "./CommitChanges";

/** The files an undo left alone, said as what the person did to them. */
export function keptLine(kept: string[]): string | null {
  if (!kept.length) return null;
  return `${kept.length === 1 ? "One file was" : `${kept.length} files were`} edited after the task and kept as you left ${kept.length === 1 ? "it" : "them"}: ${kept.join(", ")}.`;
}

/**
 * What a task changed in a folder without Git, in place, in two parts its page places apart: the
 * answers, which stay in view in the page's header (Keep to close the review with the files as they
 * are, Undo to put them back, and a commit once the person has made the folder a Git repository in
 * its Settings), and the changes themselves, each file and its diff, as the page's main surface. A
 * person who does not use Git meets no word of it here.
 */
export function useFolderReview({ task, mine, onChanged }: { task: TaskRecord | null; mine: boolean; onChanged: () => void }): { actions: ReactNode; section: ReactNode } {
  const inPlace = task?.result === "changes";
  // On a machine the files stay there: the paths the machine reported are listed instead.
  const [away, setAway] = useState(false);
  const reads = useMemo(() => (task ? machineChangeReads(taskChangeReads(task.id), task.changes?.files ?? [], () => setAway(true)) : null), [task?.id]);
  const [untouched, setUntouched] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [git, setGit] = useState<GitState | null>(null);
  const [committing, setCommitting] = useState(false);
  const [committed, setCommitted] = useState<string | null>(null);
  // Keep is the person saying they read the changes, so it waits until the changes are on the page.
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (!inPlace || !task) return;
    projectsRead.list().then(({ projects }) => setGit(projects.find((p) => p.id === task.repoId)?.facts?.git ?? null), () => setGit(null));
  }, [task?.repoId, inPlace]);
  if (!inPlace || !task || !reads) return { actions: null, section: null };
  const undone = task.changes?.undone ?? null;
  const keptBy = task.changes?.kept ?? null;
  const ended = task.status !== "queued" && task.status !== "running";
  // Undone or kept from elsewhere, or the task moved on: the page reads where it stands.
  const refused = (e: Error) => {
    setError(e.message);
    if (e instanceof ApiError && e.status === 409) onChanged();
  };
  const undo = (why: string) =>
    tasksApi.undo(task.id, why ? { reason: why } : {}).then((r) => {
      setUntouched(r.kept);
      onChanged();
    }, refused);
  // A file taken back alone: the rest stay to be kept, and the review reads the task again to show it undone.
  const undoFile = (path: string, why: string) => tasksApi.undo(task.id, { paths: [path], ...(why ? { reason: why } : {}) }).then(onChanged);
  const undoneFiles = (task.changes?.files ?? []).filter((f) => f.state === "undone").map((f) => f.path);
  const keep = () => {
    setBusy(true);
    setError(null);
    tasksApi.keep(task.id).then(onChanged, refused).finally(() => setBusy(false));
  };
  const keptNow = keptLine(untouched ?? undone?.kept ?? []);
  const at = (time: string) => time.slice(0, 16).replace("T", " ");
  const answering = mine && ended && !undone;
  const actions = answering ? (
    <>
      {keptBy ? null : (
        <>
          <button type="button" disabled={busy || !shown} onClick={keep} title={shown ? undefined : "The changes are read first, then kept."}>Keep these changes</button>
          <ConfirmAction
            trigger="Undo these changes…"
            consequence="Each file goes back to how it was before the task."
            confirm="Undo changes"
            keep="Not now"
            reason={UNDO_WHY}
            onConfirm={undo}
          />
        </>
      )}
      {git && git !== "none" && !committed && !committing ? <button type="button" className="secondary" onClick={() => setCommitting(true)}>Commit these changes</button> : null}
    </>
  ) : null;
  const section = (
    <section className="section" aria-labelledby="review-h">
      <h2 id="review-h">Changes {task.changes ? <span className="count">{task.changes.files.length}</span> : null} <Hint label="undoing changes">Undo puts each file back as it was before the task. A file you edited since stays as you left it, and a file the orchestrator keeps no copy of, such as one that looks like it holds a secret, cannot be put back.</Hint></h2>
      {undone ? <p className="muted">Undone by {undone.by} at {at(undone.at)}{undone.reason ? `: ${undone.reason}` : ""}. {keptNow}</p>
        : keptBy ? <p className="muted">Kept by {keptBy.by} at {at(keptBy.at)}. The files stay as the agent left them.</p> : null}
      {error ? <p className="error" role="alert">{error}</p> : null}
      {committing ? <CommitChanges projectId={task.repoId} title={task.title} onCancel={() => setCommitting(false)} onCommitted={(sha) => {
        setCommitting(false);
        setCommitted(sha);
      }} /> : null}
      {committed ? <p className="notice" role="status">Committed as <span className="mono">{committed.slice(0, 7)}</span>.</p> : null}
      {!undone && keptNow ? <p className="muted">{keptNow}</p> : null}
      {away ? <p className="muted">These files changed on the computer the task ran on; open the folder there to read them.</p> : null}
      <RequestDiff key={task.id} reads={reads} bare onRead={setShown} undone={undoneFiles} {...(answering && !keptBy && task.runner !== "local" ? { onUndo: undoFile } : {})} />
    </section>
  );
  return { actions, section };
}
