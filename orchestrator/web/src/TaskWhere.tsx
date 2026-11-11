import { useEffect, useState } from "react";
import { tasksApi } from "./api";
import type { TaskRecord } from "./api";
import { FolderPicker } from "./projects/FolderPicker";
import { homeRelative, pastedPath, projectsRead } from "./projects-read";
import { verificationRead } from "./verification-read";
import type { WorkFolder } from "./projects-read";
import { here, navigate } from "./router";
import { Disclosure } from "./Shell";

/** How the folder a task works in is said: from what is known of the folder, never from the model's own words for why it was picked. */
export function whereSaid(routing: NonNullable<TaskRecord["routing"]>, about: string | null): string {
  if (routing.fallback) return ", the folder you use most";
  return about ? `, which its CLAUDE.md calls ${about}` : "";
}

/** What the folder gives the task of the person's own Claude Code: "Loaded: 1 skill, CLAUDE.md, memory from ~/code/payments-api." */
export function loadedFolder(loaded: { skills: number; claudeMd: boolean; memory: boolean }, place: string): string {
  const parts = [loaded.skills ? `${loaded.skills} ${loaded.skills === 1 ? "skill" : "skills"}` : "", loaded.claudeMd ? "CLAUDE.md" : "", loaded.memory ? "memory" : ""].filter(Boolean);
  return parts.length ? `Loaded: ${parts.join(", ")} from ${place}.` : `Nothing of ${place}'s own is loaded: it has no CLAUDE.md, skills or memory.`;
}

/** The checks the task's work is held to, said after the folder: "checked with npm test". */
export function checkedSaid(commands: string[]): string {
  return commands.length ? `, checked with ${commands.join(" and ")}` : "";
}

/**
 * Where a task on one person's own orchestrator works, as its run's first line, with Change for
 * its starter: the other folders tasks work in, the most recently used first, or another from the
 * picker. Picking one asks first, since the task starts again there and what it did is dropped.
 */
export function TaskWhere({ task, routing, canMove, checked = [], onChecksOff }: { task: TaskRecord; routing: NonNullable<TaskRecord["routing"]>; canMove: boolean; checked?: string[]; onChecksOff?: () => void }) {
  const [dropping, setDropping] = useState(false);
  const [typed, setTyped] = useState("");
  const [folders, setFolders] = useState<WorkFolder[] | null>(null);
  const [home, setHome] = useState<string | null>(null);
  const [asked, setAsked] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  useEffect(() => {
    projectsRead.workFolders().then((r) => setFolders(r.folders), () => setFolders([]));
    projectsRead.list().then((r) => setHome(r.home ?? null), () => setHome(null));
  }, []);
  const place = (path: string) => homeRelative(path, home);
  const about = folders?.find((f) => f.path === routing.path)?.about ?? null;
  const others = (folders ?? []).filter((f) => f.path !== routing.path);
  const move = () => {
    if (!asked) return;
    setBusy(true);
    setRefused(null);
    tasksApi.move(task.id, asked).then(({ task: next }) => navigate(here("tasks", next.id)), (e: Error) => {
      setRefused(e.message);
      setBusy(false);
    });
  };
  const dropChecks = () => {
    setBusy(true);
    setRefused(null);
    verificationRead.forget(task.repoId).then(() => {
      setDropping(false);
      setBusy(false);
      onChecksOff?.();
    }, (e: Error) => {
      setRefused(e.message);
      setBusy(false);
    });
  };
  return (
    <li className="run-line" data-kind="where">
      {/* The line waits for the folders, so what it says of the folder does not change under the reader. */}
      {folders === null ? null : <>Working in <span className="mono" dir="auto">{place(routing.path)}</span>{whereSaid(routing, about)}{checkedSaid(checked)}</>}
      {canMove && folders !== null && !asked && !picking && !dropping ? (
        <>
          {" "}
          <Disclosure label="Change where the task works" summary="Change" className="run-where-change">
            {(close) => (
              <ul className="plain run-where-folders">
                <li>
                  <form onSubmit={(e) => {
                    e.preventDefault();
                    if (!typed.trim()) return;
                    setAsked(pastedPath(typed, home));
                    setTyped("");
                    close();
                  }}>
                    <label>A folder's path<input type="text" value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="~/code" dir="auto" /></label>
                  </form>
                </li>
                {others.map((f) => (
                  <li key={f.path}>
                    <button type="button" className="ghost" onClick={() => { setAsked(f.path); close(); }}>
                      <span dir="auto">{f.name}</span> <span className="mono muted" dir="auto">{place(f.path)}</span>
                    </button>
                  </li>
                ))}
                <li><button type="button" className="ghost" onClick={() => { setPicking(true); close(); }}>Another folder…</button></li>
                {checked.length ? <li><button type="button" className="ghost" onClick={() => { setDropping(true); close(); }}>Run without checks</button></li> : null}
              </ul>
            )}
          </Disclosure>
        </>
      ) : null}
      {folders !== null && routing.loaded ? <span className="muted small run-loaded">{loadedFolder(routing.loaded, place(routing.path))}</span> : null}
      {picking ? (
        <>
          <FolderPicker onOpened={(project) => {
            setPicking(false);
            setAsked(project.machine?.path ?? project.url.replace(/^file:\/\//, ""));
          }} />
          <p><button type="button" className="secondary small" onClick={() => setPicking(false)}>Keep it here</button></p>
        </>
      ) : null}
      {dropping ? (
        <div className="confirm" role="group" aria-label="Run without checks">
          <p>The checks for <span className="mono" dir="auto">{place(routing.path)}</span> are taken back; tasks there run none until you approve them again.</p>
          <div className="actions">
            <button type="button" className="confirm-go small" onClick={dropChecks} disabled={busy}>{busy ? "Take them back…" : "Take them back"}</button>
            <button type="button" className="secondary small" onClick={() => { setDropping(false); setRefused(null); }} disabled={busy}>Keep the checks</button>
          </div>
          {refused ? <p className="error" role="alert">{refused}</p> : null}
        </div>
      ) : null}
      {asked ? (
        <div className="confirm" role="group" aria-label="Start it there">
          <p>The task starts again in <span className="mono" dir="auto">{place(asked)}</span>; what it did so far is dropped.</p>
          <div className="actions">
            <button type="button" className="confirm-go small" onClick={move} disabled={busy}>{busy ? "Start it there…" : "Start it there"}</button>
            <button type="button" className="secondary small" onClick={() => { setAsked(null); setRefused(null); }} disabled={busy}>Keep it here</button>
          </div>
          {refused ? <p className="error" role="alert">{refused}</p> : null}
        </div>
      ) : null}
    </li>
  );
}
