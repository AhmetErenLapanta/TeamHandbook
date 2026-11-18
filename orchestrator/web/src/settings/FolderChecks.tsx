import { useEffect, useState } from "react";
import { verificationRead } from "../verification-read";
import type { DetectedCheck, ProjectVerification } from "../verification-read";

const list = (items: string[]) => (items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`);

/** "npm test and npm run lint were found for this folder; approve them to run after each task." */
export function foundSaid(commands: string[]): string {
  return `${list(commands)} ${commands.length === 1 ? "was" : "were"} found for this folder; approve ${commands.length === 1 ? "it" : "them"} to run after each task.`;
}

/**
 * The one thing a folder carries: the checks its tasks are held to. Found ones run only once approved here, as a
 * whole or by picking which to keep; approved, the line says what runs after each task and Change… picks again.
 */
export function FolderChecks({ project, canChange }: { project: string; canChange: boolean }) {
  const [read, setRead] = useState<ProjectVerification | null>(null);
  const [picking, setPicking] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    verificationRead.project(project).then(setRead, () => setRead(null));
  }, [project]);
  if (!read || read.configured) return null;
  const found = read.detected?.checks ?? [];
  const approved = read.approved && !read.changed.length ? read.approved.checks : null;
  if (!approved && !found.length) return null;
  const approve = (checks: DetectedCheck[]) => {
    setBusy(true);
    setProblem(null);
    const sent = checks.length ? verificationRead.approve(project, checks, read.detected?.setup ?? null) : verificationRead.forget(project);
    sent.then((next) => {
      setRead(next);
      setPicking(null);
    }, (e: Error) => setProblem(e.message)).finally(() => setBusy(false));
  };
  const say = (checks: { command: string; source?: string }[]) => checks.map((c) => (c.source ? `${c.command} from ${c.source}` : c.command)).join(", ");
  return (
    <div className="folder-checks small">
      {picking ? (
        <>
          <ul className="plain">
            {found.map((c) => (
              <li key={c.command}><label className="check"><input type="checkbox" checked={picking.includes(c.command)} onChange={(e) => setPicking(e.target.checked ? [...picking, c.command] : picking.filter((x) => x !== c.command))} /><code>{c.command}</code> <span className="muted">from {c.source}</span></label></li>
            ))}
          </ul>
          <p className="actions">
            <button type="button" disabled={busy} onClick={() => approve(found.filter((c) => picking.includes(c.command)))}>Approve these</button>
            <button type="button" className="secondary" disabled={busy} onClick={() => setPicking(null)}>Cancel</button>
          </p>
        </>
      ) : approved ? (
        <p>Checks after each task: <code>{approved.map((c) => c.command).join(", ")}</code>{canChange && found.length ? <> <button type="button" className="link" onClick={() => setPicking(approved.map((c) => c.command))}>Change…</button></> : null}</p>
      ) : (
        <p>
          Found: {say(found)}
          {canChange ? <> <button type="button" disabled={busy} onClick={() => approve(found)}>Approve</button> <button type="button" className="secondary" onClick={() => setPicking(found.map((c) => c.command))}>Not these…</button></> : null}
        </p>
      )}
      {problem ? <p className="error" role="alert">{problem}</p> : null}
    </div>
  );
}
