import { useEffect, useState } from "react";
import { call } from "./api";
import { Loading, LoadFailed } from "./Status";
import type { PeopleOutcomes as PeopleAnswer, PersonOutcomes } from "../../shared/activity";

/** Of the tasks that ended with a decision, the share that was kept: merged or kept against closed or undone. */
export function landedShare(p: Pick<PersonOutcomes, "merged" | "kept" | "closed" | "undone">): number | null {
  const landed = p.merged + p.kept;
  const decided = landed + p.closed + p.undone;
  return decided ? Math.round((landed / decided) * 100) : null;
}

/**
 * Where a team's tasks end, person by person: started, landed (merged or kept), dropped (closed
 * or undone) and failed. It reads only the tasks the reader sees: an owner or admin everyone's,
 * a team's owner their team's, a member their own. Listed by tasks started, not ranked.
 */
export function PeopleOutcomes({ days }: { days: number }) {
  const [people, setPeople] = useState<PersonOutcomes[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reads, setReads] = useState(0);
  useEffect(() => {
    let current = true;
    setPeople(null);
    setError(null);
    call<PeopleAnswer>("GET", `/api/analytics/people?days=${days}`).then((r) => current && setPeople(r.people), (e: Error) => current && setError(e.message));
    return () => {
      current = false;
    };
  }, [days, reads]);
  return (
    <section className="panel" aria-labelledby="people-outcomes-h">
      {/* The repository picker above narrows skill use only; tasks are counted across every repository. */}
      <h2 id="people-outcomes-h">Tasks by person <span className="count">every repository, {days} days</span></h2>
      {error ? <LoadFailed what="tasks by person" reason={error} onRetry={() => setReads((n) => n + 1)} /> : !people ? <Loading what="tasks by person" /> : !people.length ? (
        <p className="muted">No task was started in the last {days} days; each person's tasks and how they ended land here.</p>
      ) : (
        <table className="row-cards">
          <thead><tr><th scope="col">Person</th><th scope="col">Tasks</th><th scope="col">Landed</th><th scope="col">Dropped</th><th scope="col">Failed</th><th scope="col">Kept of decided</th></tr></thead>
          <tbody>
            {people.map((p) => {
              const share = landedShare(p);
              return (
                <tr key={p.email}>
                  <td className="rc-title">{p.name ?? p.email}</td>
                  <td className="rc-meta">{p.tasks}</td>
                  <td className="rc-meta">{p.merged + p.kept}</td>
                  <td className="rc-meta">{p.closed + p.undone}</td>
                  <td className="rc-meta">{p.failed}</td>
                  <td className="rc-status">{share === null ? <span className="muted">none decided</span> : `${share}%`}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}
