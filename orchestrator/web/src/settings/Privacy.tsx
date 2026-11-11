import { useEffect, useId, useState } from "react";
import type { FormEvent } from "react";
import { manages, privacyApi } from "../api";
import type { Principal, PrivacyView } from "../api";
import { here } from "../router";
import { LoadFailed, Loading } from "../Status";
import { Hint } from "../Hint";

export function PrivacySettings({ me }: { me: Principal }) {
  const [view, setView] = useState<PrivacyView | null>(null);
  const [days, setDays] = useState("");
  const [usageDays, setUsageDays] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const daysHint = useId();
  const usageHint = useId();
  const managing = manages(me);
  const load = () => privacyApi.read().then((v) => {
    setView(v);
    setDays(String(v.privacy.taskLogDays));
    setUsageDays(String(v.privacy.usageDays));
  }, (e: Error) => setError(e.message));
  useEffect(() => {
    if (managing) void load();
  }, [managing]);
  if (!managing) return <section className="panel"><p>Only owners and admins see privacy settings.</p></section>;
  if (!view) return error ? <LoadFailed what="privacy settings" reason={error} panel onRetry={() => { setError(null); void load(); }} /> : <Loading what="privacy settings" panel />;
  const change = (input: Partial<PrivacyView["privacy"]>, said: string) => {
    setError(null);
    setNotice(null);
    privacyApi.change(input).then((privacy) => {
      setView({ ...view, privacy });
      setNotice(said);
    }, (e: Error) => setError(e.message));
  };
  const saveDays = (e: FormEvent) => {
    e.preventDefault();
    change({ taskLogDays: Number(days) }, `Task logs are kept ${days} days; older lines are deleted now.`);
  };
  const saveUsageDays = (e: FormEvent) => {
    e.preventDefault();
    change({ usageDays: Number(usageDays) }, `Skill use is kept ${usageDays} days; older counts are deleted now.`);
  };
  return (
    <>
      {error ? <p className="error" role="alert">{error}</p> : null}
      {notice ? <p className="notice" role="status">{notice}</p> : null}
      {/* Skill use teammates report and who sees the leaderboard are about other people; one person's own machine keeps only its retention. */}
      {me.mode !== "local" ? (
        <>
          <section className="panel" aria-labelledby="usage-h">
            <h2 id="usage-h">Usage reporting</h2>
            <p className="muted">A team reports skill use only once a request asking it to is merged into its repository. <Hint label="usage reporting">It stops the same way. Counts arrive as totals per skill and hour; no session text leaves a teammate's machine.</Hint></p>
            <table>
              <thead><tr><th>Repository</th><th>Team</th><th>Reports skill use</th></tr></thead>
              <tbody>
                {view.usage.map((u) => (
                  <tr key={u.repoId}>
                    <td><a href={here("repositories", u.repoId)}>{u.name}</a></td>
                    <td>{u.team}</td>
                    <td>{u.reporting === null ? "not read yet" : u.reporting ? "yes" : "no"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="muted">To ask a team or stop asking, open its repository and use the usage reporting request there.</p>
          </section>
          <section className="panel" aria-labelledby="board-h">
            <h2 id="board-h">Leaderboard visibility</h2>
            <fieldset className="plain-fieldset">
              <legend className="visually-hidden">Who sees the usage leaderboard</legend>
              <label className="check">
                <input type="radio" name="leaderboard" checked={view.privacy.leaderboard === "admins"} onChange={() => change({ leaderboard: "admins" }, "The leaderboard is visible to owners and admins.")} />
                Owners and admins only
              </label>
              <label className="check">
                <input type="radio" name="leaderboard" checked={view.privacy.leaderboard === "members"} onChange={() => change({ leaderboard: "members" }, "The leaderboard is visible to members.")} />
                Leaderboard visible to members
              </label>
            </fieldset>
          </section>
        </>
      ) : null}
      <section className="panel" aria-labelledby="logs-h">
        <h2 id="logs-h">Task log retention</h2>
        <form className="form inline-form" onSubmit={saveDays} aria-label="Task log retention">
          <label>Days to keep task logs<input type="number" min={1} max={365} value={days} onChange={(e) => setDays(e.target.value)} required aria-describedby={daysHint} /></label>
          <button type="submit" className="secondary">Save</button>
        </form>
        <p className="muted" id={daysHint}>The agent's output lines go after this many days; the task, its outcome and its request stay.</p>
      </section>
      <section className="panel" aria-labelledby="usage-days-h">
        <h2 id="usage-days-h">Skill use retention</h2>
        <form className="form inline-form" onSubmit={saveUsageDays} aria-label="Skill use retention">
          <label>Days to keep skill use<input type="number" min={90} max={3650} value={usageDays} onChange={(e) => setUsageDays(e.target.value)} required aria-describedby={usageHint} /></label>
          <button type="submit" className="secondary">Save</button>
        </form>
        <p className="muted" id={usageHint}>Counts older than this are deleted, not summed; the minimum is 90 days. <Hint label="skill use retention">90 days is the longest range Usage shows and exports, so no chart or export loses a day it shows.</Hint></p>
      </section>
    </>
  );
}
