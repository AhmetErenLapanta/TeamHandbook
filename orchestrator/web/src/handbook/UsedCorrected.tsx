import { useEffect, useState } from "react";
import { call, tasksApi } from "../api";
import type { TaskRecord } from "../api";
import { ConfirmAction } from "../Confirm";
import { here, navigate } from "../router";
import { lessonsApi } from "../TaskLearned";
import { handbookRead } from "./handbook-read";

/** What corrected a task, in the words its review says it: a change undone, or a request of the agent's denied. */
export function correctionOf(task: Pick<TaskRecord, "changes" | "requests">): string | null {
  if (task.changes?.undone) return "its change was undone";
  if (task.requests?.some((r) => r.answer && "decision" in r.answer && r.answer.decision === "deny")) return "a request it made was denied";
  return null;
}

/** A plugin's skill copied into the person's own skills under its own name; a name already taken is refused by the orchestrator. */
async function copyToYours(source: string, name: string): Promise<void> {
  const content = await handbookRead.skill(source, name);
  await call("PUT", "/api/handbook/file", { source: "yours", kind: "skill", name, content, expectedDigest: null });
}

function CopyToYours({ source, name }: { source: string; name: string }) {
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  if (done) return <span className="muted">Copied to yours.</span>;
  return (
    <>
      <button type="button" className="link" disabled={busy} onClick={() => {
        setBusy(true);
        setProblem(null);
        copyToYours(source, name).then(() => setDone(true), (e: Error) => setProblem(e.message)).finally(() => setBusy(false));
      }}>Copy to Yours</button>
      {problem ? <span className="error small" role="alert"> {problem}</span> : null}
    </>
  );
}

/** Starts an Improve a skill task on the team's skills repository, asked first; nothing changes until its change is kept. */
async function improve(task: TaskRecord, skill: string, repoId: string): Promise<void> {
  const options = await tasksApi.options();
  const agent = options.agents[0]?.id;
  if (!agent) throw new Error("No agent is set up on this orchestrator yet.");
  const started = await tasksApi.start({ title: `Improve the ${skill} skill`, description: `${skill} was used in "${task.title}", and that task was corrected.`, issueUrl: "", repoId, agent, template: { kind: "skill.improve", skill } });
  navigate(here("tasks", started.id));
}

/** The team's skills repository a skill came from: the task's own record of it, else the team's one skills repository. */
async function repoOf(task: TaskRecord, skill: string): Promise<string | null> {
  const recorded = task.used?.skills.find((u) => u.name === skill && u.source.startsWith("team:"))?.source.slice("team:".length);
  if (recorded) return recorded;
  const options = await tasksApi.options();
  return options.repos.find((r) => r.kind === "skills" && r.team === task.team)?.id ?? options.repos.find((r) => r.kind === "skills")?.id ?? null;
}

/**
 * Said once in a task's review, not in the list: a skill the agent used in a task the person then corrected, with its one way
 * to get better. The team's skills come from the orchestrator's own reading of the task (`improvable`) and start an Improve a
 * skill task on their repository; one's own are edited on Team; a plugin's is copied to the person's own first.
 */
export function UsedCorrected({ task }: { task: TaskRecord }) {
  const [improvable, setImprovable] = useState<string[]>([]);
  useEffect(() => {
    let current = true;
    lessonsApi.ofTask(task.id).then((r) => current && setImprovable(r.improvable ?? []), () => undefined);
    return () => {
      current = false;
    };
  }, [task.id]);
  const why = correctionOf(task);
  const others = why ? (task.used?.skills ?? []).filter((u) => !u.source.startsWith("team:")) : [];
  if (!improvable.length && !others.length) return null;
  return (
    <ul className="plain used-corrected">
      {improvable.map((name) => (
        <li key={`team\n${name}`} className="small">
          <span className="mono">{name}</span> was used{why ? `, and ${why}` : " in a task you corrected"}.{" "}
          <ConfirmAction small trigger="Improve this skill…" consequence={`This starts a task that improves ${name} in the team's skills; nothing changes until its change is kept.`} confirm="Start the task" keep="Not now" onConfirm={async () => {
            const repoId = await repoOf(task, name);
            if (!repoId) throw new Error("No team skills repository is connected here.");
            await improve(task, name, repoId);
          }} />
        </li>
      ))}
      {others.map((u) => (
        <li key={`${u.source}\n${u.name}`} className="small">
          <span className="mono">{u.name}</span> was used, and {why}.{" "}
          {u.source.startsWith("plugin:") ? <CopyToYours source={u.source} name={u.name} /> : <a href={here("team")}>Improve this skill…</a>}
        </li>
      ))}
    </ul>
  );
}
