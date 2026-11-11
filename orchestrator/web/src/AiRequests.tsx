import { useEffect, useState } from "react";
import { aiRequestsApi } from "./api";
import type { AiAnalytics, AiStats } from "./api";
import { Loading, LoadFailed } from "./Status";
import { WindowPicker } from "./Usage";

const percent = (share: number | null) => (share === null ? "—" : `${Math.round(share * 100)}%`);
const wait = (h: { median: number; p90: number } | null) => (h ? `${h.median} h (p90 ${h.p90} h)` : "—");

function Rows({ rows, first }: { rows: ({ key: string; label: string } & AiStats)[]; first: string }) {
  return (
    <table>
      <thead>
        <tr><th scope="col">{first}</th><th scope="col">Merged</th><th scope="col">AI-assisted</th><th scope="col">Share</th><th scope="col">Time to merge, AI-assisted</th><th scope="col">Time to merge, others</th></tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.key}><th scope="row">{r.label}</th><td>{r.merged}</td><td>{r.aiAssisted}</td><td>{percent(r.share)}</td><td>{wait(r.hoursToMerge.ai)}</td><td>{wait(r.hoursToMerge.other)}</td></tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * The merged requests a coding agent helped write, read from each team repository's own
 * history: the share, the agents, and how long they took to merge beside the others.
 */
export function AiRequestsPage() {
  const [days, setDays] = useState(30);
  const [report, setReport] = useState<AiAnalytics | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let current = true;
    setReport(null);
    setError(null);
    aiRequestsApi.read(days).then((r) => current && setReport(r), (e: Error) => current && setError(e.message));
    return () => {
      current = false;
    };
  }, [days, attempt]);
  return (
    <>
      <div className="toolbar"><WindowPicker days={days} onDays={setDays} /></div>
      {error ? <LoadFailed what="AI-assisted requests" reason={error} onRetry={() => setAttempt(attempt + 1)} panel /> : !report ? <Loading what="AI-assisted requests" panel /> : (
        <>
          <section className="panel" aria-labelledby="ai-total-h">
            <h2 id="ai-total-h">Merged requests <span className="count">last {report.days} days</span></h2>
            <dl className="facts wide">
              <div><dt>Merged</dt><dd>{report.total.merged}</dd></div>
              <div><dt>AI-assisted</dt><dd>{report.total.aiAssisted} ({percent(report.total.share)})</dd></div>
              <div><dt>Time to merge, AI-assisted</dt><dd>{wait(report.total.hoursToMerge.ai)}</dd></div>
              <div><dt>Time to merge, others</dt><dd>{wait(report.total.hoursToMerge.other)}</dd></div>
            </dl>
            {report.byAgent.some((a) => a.requests) ? <p>{report.byAgent.filter((a) => a.requests).map((a) => `${a.label}: ${a.requests}`).join(" · ")}</p> : null}
            <p className="muted">Read from each repository's history: a request counts as AI-assisted when one of its commits carries a coding agent's trailer, such as Co-Authored-By: Claude. An agent that leaves none, a fast-forward merge and a squash without its number are not counted, so these are a floor. Time to merge runs from a request's first commit.</p>
            {report.truncated.length ? <p className="muted">Only the latest requests were read in {report.truncated.join(", ")}; pick a shorter range for all of them.</p> : null}
          </section>
          {report.total.merged ? (
            <>
              <section className="panel" aria-labelledby="ai-teams-h"><h2 id="ai-teams-h">By team</h2><Rows first="Team" rows={report.byTeam.map((t) => ({ key: t.team, label: t.team, ...t }))} /></section>
              <section className="panel" aria-labelledby="ai-repos-h"><h2 id="ai-repos-h">By repository</h2><Rows first="Repository" rows={report.byRepo.map((r) => ({ key: r.repoId, label: `${r.team} · ${r.repoId}`, ...r }))} /></section>
              {report.byPerson ? (
                <section className="panel" aria-labelledby="ai-people-h"><h2 id="ai-people-h">By person <span className="count">owners and admins see this</span></h2><Rows first="Person" rows={report.byPerson.map((p) => ({ key: p.email, label: `${p.name} (${p.email})`, ...p }))} /></section>
              ) : null}
            </>
          ) : <p className="muted panel">No request was merged in this range.</p>}
        </>
      )}
    </>
  );
}
