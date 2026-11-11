import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { manages, taskLimitsApi } from "../api";
import type { Principal, TaskLimits } from "../api";
import { LoadFailed, Loading } from "../Status";

/** What a saved pair of limits means for the next task, said once it is saved. */
export function limitsSaid({ maxUsd, maxMinutes }: TaskLimits): string {
  if (maxUsd !== null && maxMinutes !== null) return `A task now stops at $${maxUsd.toFixed(2)} or after ${maxMinutes} minutes, whichever comes first.`;
  if (maxUsd !== null) return `A task now stops at $${maxUsd.toFixed(2)}; how long it runs has no limit.`;
  if (maxMinutes !== null) return `A task now stops after ${maxMinutes} minutes; what it spends has no limit.`;
  return "A task now has no limit on what it spends or how long it runs.";
}

/** What every task stops at, said before one starts. */
export function limitsLine({ maxUsd, maxMinutes }: TaskLimits): string {
  if (maxUsd !== null && maxMinutes !== null) return `A task stops at $${maxUsd.toFixed(2)} or after ${maxMinutes} minutes, whichever comes first.`;
  if (maxUsd !== null) return `A task stops at $${maxUsd.toFixed(2)}; how long it runs has no limit.`;
  if (maxMinutes !== null) return `A task stops after ${maxMinutes} minutes; what it spends has no limit.`;
  return "A task has no limit on what it spends or how long it runs.";
}

/**
 * The two limits every task stops at, whichever comes first: what it spends and how long its run
 * goes. Each can be off; the task form says both before Start. Anyone reads them; an owner or an
 * admin changes them.
 */
export function TaskLimitsSettings({ me }: { me: Principal }) {
  const canChange = manages(me);
  const [usd, setUsd] = useState("");
  const [minutes, setMinutes] = useState("");
  const [noUsd, setNoUsd] = useState(false);
  const [noMinutes, setNoMinutes] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refused, setRefused] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const show = (limits: TaskLimits) => {
    setUsd(limits.maxUsd === null ? "" : String(limits.maxUsd));
    setMinutes(limits.maxMinutes === null ? "" : String(limits.maxMinutes));
    setNoUsd(limits.maxUsd === null);
    setNoMinutes(limits.maxMinutes === null);
    setLoaded(true);
  };
  const load = () => taskLimitsApi.read().then(show, (e: Error) => setError(e.message));
  useEffect(() => {
    void load();
  }, []);
  if (error) return <LoadFailed what="the task limits" reason={error} onRetry={() => { setError(null); void load(); }} />;
  if (!loaded) return <Loading what="the task limits" />;
  const save = (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setRefused(null);
    setNotice(null);
    taskLimitsApi.change({ maxUsd: noUsd ? null : Number(usd), maxMinutes: noMinutes ? null : Number(minutes) }).then((limits) => {
      show(limits);
      setNotice(limitsSaid(limits));
    }, (err: Error) => setRefused(err.message)).finally(() => setBusy(false));
  };
  return (
    <section className="section">
      <p className="muted">A task stops at whichever comes first; the task form says both before Start.{canChange ? "" : " An owner or an admin changes them."}</p>
      {refused ? <p className="error" role="alert">{refused}</p> : null}
      {notice ? <p className="notice" role="status">{notice}</p> : null}
      <form className="form task-limits" onSubmit={save} aria-label="Task limits">
        <div className="task-limit">
          <label>Most a task spends, in dollars<input type="number" inputMode="decimal" min={0.01} max={1000} step={0.01} value={usd} disabled={noUsd || !canChange} required={!noUsd} onChange={(e) => setUsd(e.target.value)} /></label>
          <label className="check"><input type="checkbox" checked={noUsd} disabled={!canChange} onChange={(e) => setNoUsd(e.target.checked)} />No limit</label>
        </div>
        <div className="task-limit">
          <label>Longest a task runs, in minutes<input type="number" inputMode="numeric" min={1} max={1440} step={1} value={minutes} disabled={noMinutes || !canChange} required={!noMinutes} onChange={(e) => setMinutes(e.target.value)} /></label>
          <label className="check"><input type="checkbox" checked={noMinutes} disabled={!canChange} onChange={(e) => setNoMinutes(e.target.checked)} />No limit</label>
        </div>
        {canChange ? <div className="actions"><button type="submit" disabled={busy}>Save</button></div> : null}
      </form>
    </section>
  );
}
