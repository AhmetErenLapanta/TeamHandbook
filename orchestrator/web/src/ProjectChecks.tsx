import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import type { ApiError } from "./api";
import { checksToSay, verificationRead } from "./verification-read";
import type { DetectedStep, ProjectVerification } from "./verification-read";

/** One step as Start approves it: its command, what it runs when that differs, and whether it reaches the network or takes long. */
function StepLine({ step }: { step: DetectedStep }) {
  return (
    <li>
      <code>{step.command}</code>
      {step.runs !== step.command ? <>{" "}<span className="runs">runs <code>{step.runs}</code></span></> : null}
      {step.network ? <>{" "}<span className="state warn">reaches the network</span></> : null}
      {step.long ? <>{" "}<span className="muted">takes long</span></> : null}
    </li>
  );
}

/** Whether Start would approve or take back anything: no approval yet with checks found, or files changed since one. */
export function checksNeeded(v: ProjectVerification): boolean {
  return !v.configured && Boolean(v.detected?.checks.length) && (!v.approved || v.changed.length > 0);
}

/**
 * What a project's work is checked with, said where a task starts, and the approval its Start gives:
 * the list and what Start sends are built from one value, so Start approves what is in view and
 * nothing else. `when` is "always" for the first task box and "needed" for the task form, where a
 * project approved and unchanged asks nothing again. Someone who is no owner or admin is told who
 * approves rather than offered a list their Start could not approve.
 */
export function useProjectChecks(projectId: string | null, when: "always" | "needed", approver = true): { view: ReactNode; consent: () => Promise<void> } {
  const [checks, setChecks] = useState<ProjectVerification | null>(null);
  const [picked, setPicked] = useState<string[] | null>(null);
  const [changing, setChanging] = useState(false);
  const read = () => {
    if (!projectId) return Promise.resolve();
    return verificationRead.project(projectId).then(setChecks, () => setChecks(null));
  };
  useEffect(() => {
    setChecks(null);
    setPicked(null);
    setChanging(false);
    void read();
  }, [projectId]);
  const said = checks ? checksToSay(checks, picked) : null;
  const asked = Boolean(checks && (when === "always" || checksNeeded(checks) || picked !== null));
  const offered = asked && approver;
  const consent = (): Promise<void> => {
    if (!offered || !checks || !said || !projectId) return Promise.resolve();
    // None ticked takes back an earlier approval, so a task runs no check rather than one the person unticked.
    const sent = said.approve
      ? verificationRead.approve(projectId, said.approve.checks, said.approve.setup)
      : picked !== null && !picked.length && checks.approved ? verificationRead.forget(projectId) : null;
    if (!sent) return Promise.resolve();
    return sent.then(() => undefined, (err: ApiError) => {
      // A person who may not approve starts the task as it stands; files changed since they were shown stop the start and are read again.
      if (err.status === 403) return;
      if (err.code === "changed") void read();
      throw err;
    });
  };
  if (!checks || !said || !asked) return { view: null, consent };
  if (!approver) {
    return { view: checksNeeded(checks) ? <p className="muted small task-checks-note">An owner or an admin approves the checks this project's tasks run; until then a task here runs none.</p> : null, consent };
  }
  const view = (
    <div className="task-box-checks">
      {said.configured ? (
        <p className="muted small">Checked with <code>{said.configured}</code>.</p>
      ) : said.checks.length ? (
        <>
          <p className="muted small">{checks.approved && checks.changed.length ? "Its files changed since its checks were approved; Start approves these again:" : "Checked with"}</p>
          <ul className="task-checks" aria-label="Checks Start approves">
            {said.setup ? <StepLine step={said.setup} /> : null}
            {said.checks.map((c) => <StepLine key={c.command} step={c} />)}
          </ul>
        </>
      ) : <p className="muted small">No check runs: the task starts with none.</p>}
      {said.canChange && !changing ? <p><button type="button" className="link" onClick={() => {
        setPicked(said.checks.map((c) => c.command));
        setChanging(true);
      }}>Change</button></p> : null}
      {changing && checks.detected ? (
        <fieldset className="plain-fieldset checks-pick">
          <legend className="visually-hidden">Checks to run before and after the agent's work</legend>
          {checks.detected.checks.map((c) => (
            <label key={c.command} className="check">
              <input type="checkbox" checked={picked?.includes(c.command) ?? false} onChange={(e) => setPicked((now) => (e.target.checked ? [...(now ?? []), c.command] : (now ?? []).filter((x) => x !== c.command)))} />
              <code>{c.command}</code>
            </label>
          ))}
          <div className="actions"><button type="button" className="secondary small" onClick={() => setChanging(false)}>Done</button></div>
        </fieldset>
      ) : null}
    </div>
  );
  return { view, consent };
}
