import { useEffect, useId, useState } from "react";
import type { FormEvent } from "react";
import { tasksApi } from "../api";
import type { TaskOptions } from "../api";
import { machinesApi } from "../machines/api";
import type { MachineAgent } from "../machines/api";
import { AgentLine } from "../AgentLine";
import { NextStep } from "../NextStep";
import { folderPlace } from "../projects-read";
import type { Project } from "../projects-read";
import { useProjectChecks } from "../ProjectChecks";
import { workApi } from "../work/api";
import type { WorkStarter } from "../work/api";
import { splitWork, taskTitle } from "../Tasks";

/** How often a computer that runs no agent yet is read again; its first report comes after it is first seen. */
const MACHINE_AGENTS_MS = 3_000;

/** The agent a first task goes to: the first one ready, else the first there is; the person picks none. */
export function firstAgent(agents: TaskOptions["agents"]): string | null {
  return (agents.find((a) => a.readiness?.ready) ?? agents[0])?.id ?? null;
}

/**
 * The agent a first task on the person's own computer goes to: one that computer runs, signed in
 * first. The orchestrator's own list says nothing about it, and a task for an agent the computer
 * does not run fails there the moment it arrives.
 */
export function machineAgent(agents: MachineAgent[]): string | null {
  const usable = agents.filter((a) => a.installed && a.supported !== "unsupported");
  return (usable.find((a) => a.signIn === "signed-in") ?? usable[0])?.id ?? null;
}

/**
 * The second and last decision of the first screen: what the agent should do in the folder just
 * opened. The agent is chosen for the person; a folder with no Git is told once that the agent
 * edits its files where they are, with every change shown for review and undo after.
 */
export function FirstTask({ project, home = null, onStarted, onChange, onCancel, machine }: { project: Project; home?: string | null; onStarted: (taskId: string) => void; onChange?: () => void; onCancel?: () => void; machine?: string }) {
  const [work, setWork] = useState("");
  const [agents, setAgents] = useState<TaskOptions["agents"] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; code?: string; status?: number } | null>(null);
  const fieldId = useId();
  const errorId = useId();
  // What the folder suggests by being read; a refusal or an empty list offers nothing, the box alone stays.
  const [starters, setStarters] = useState<WorkStarter[]>([]);
  // What the project is checked with, read off its files: said once here, and approved by the Start that follows it.
  const checks = useProjectChecks(project.id, "always");
  useEffect(() => {
    tasksApi.options().then((o) => setAgents(o.agents), () => setAgents([]));
    workApi.starters(project.id).then((r) => setStarters(r.starters.slice(0, 3)), () => setStarters([]));
  }, [project.id]);
  const [onMachine, setOnMachine] = useState<MachineAgent[] | null>(null);
  const machineChosen = onMachine ? machineAgent(onMachine) : null;
  useEffect(() => {
    if (!machine || machineChosen) return;
    let live = true;
    const read = () => machinesApi.list().then(({ machines }) => {
      if (live) setOnMachine(machines.find((m) => m.id === machine)?.agents ?? []);
    }, () => undefined);
    read();
    const timer = window.setInterval(read, MACHINE_AGENTS_MS);
    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, [machine, machineChosen]);
  const agent = machine ? machineChosen : agents ? firstAgent(agents) : null;
  const inPlace = project.facts?.git === "none" && !project.facts.repos;
  const start = (e: FormEvent) => {
    e.preventDefault();
    const words = work.trim();
    if (!words || !agent) return;
    setBusy(true);
    setError(null);
    const { issue, notes } = splitWork(words);
    const failed = (err: Error & { code?: string; status?: number }) => {
      setError({ message: err.message, ...(err.code ? { code: err.code } : {}), ...(err.status ? { status: err.status } : {}) });
      setBusy(false);
    };
    // The run is what the box showed: the checks shown are approved by their digests first, and none
    // ticked takes back an earlier approval; files changed since they were shown stop the start.
    const approved = checks.consent();
    approved.then(() => tasksApi.start({ title: taskTitle("", null, null, issue ? notes : words), description: issue ? notes : words, issueUrl: issue, repoId: project.id, agent, template: null }))
      .then((task) => onStarted(task.id), failed);
  };
  return (
    <form className="task-box" onSubmit={start} aria-label="First task">
      <p className="task-box-where">
        <strong dir="auto">{project.facts?.name ?? project.name}</strong>{" "}
        <span className="folder-at" dir="auto">{folderPlace(project, home)}</span>
        {onChange ? <>{" "}<button type="button" className="link" onClick={onChange}>Pick another folder</button></> : null}
      </p>
      <label htmlFor={fieldId}>What should the agent do here?</label>
      <textarea id={fieldId} dir="auto" value={work} onChange={(e) => setWork(e.target.value)} rows={3} maxLength={8500} {...(error ? { "aria-describedby": errorId, "aria-invalid": true } : {})} />
      {starters.length && !work.trim() ? (
        <div className="starters">
          <p className="muted small" id={`${fieldId}-starters`}>Or start with</p>
          {/* A row fills the box with the whole of what the agent is asked, so the person reads it before Start. */}
          <ul className="plain starter-list" aria-labelledby={`${fieldId}-starters`}>
            {starters.map((s) => (
              <li key={`${s.kind}:${s.where}:${s.title}`}>
                <button type="button" className="ghost" onClick={() => setWork(`${s.title}\n\n${s.description}`)}>
                  <span dir="auto">{s.title}</span> <span className="mono muted small" dir="auto">{s.where}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {checks.view}
      {inPlace ? <p className="muted small">The agent edits these files in place, and you can undo every change.</p> : null}
      {machine && onMachine && !agent ? <p className="muted small" role="status">Your computer runs no agent for tasks yet: install Claude Code or OpenCode there and sign in.</p> : null}
      <div className="actions">
        <button type="submit" disabled={busy || !work.trim() || !agent}>Start</button>
        {onCancel ? <button type="button" className="secondary" onClick={onCancel} disabled={busy}>Cancel</button> : null}
        <AgentLine />
      </div>
      {error ? <p className="error" role="alert" id={errorId}>{error.message}<NextStep {...(error.code ? { code: error.code } : {})} {...(error.status ? { status: error.status } : {})} /></p> : null}
    </form>
  );
}
