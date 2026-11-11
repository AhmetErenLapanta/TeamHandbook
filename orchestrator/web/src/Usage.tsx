import { useEffect, useState } from "react";
import { USAGE_WINDOWS } from "../../shared/activity";
import { api, manages } from "./api";
import { Loading, LoadFailed } from "./Status";
import type { Leaderboard, Principal, RepoRecord, UsageReport } from "./api";
import { PeopleOutcomes } from "./PeopleOutcomes";
import { Select } from "./Select";

const WIDTH = 720;
const HEIGHT = 180;
const AXIS = 22;

function shortDay(day: string): string {
  return new Date(`${day}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

/** A bar standing on the baseline, its top corners rounded. */
function barPath(x: number, base: number, width: number, h: number): string {
  const r = Math.min(4, width / 2, h);
  const top = base - h;
  return `M${x},${base}V${top + r}Q${x},${top} ${x + r},${top}H${x + width - r}Q${x + width},${top} ${x + width},${top + r}V${base}Z`;
}

/** Skill use per day as bars from one baseline; the same numbers are in the table under it. */
function DailyChart({ series }: { series: UsageReport["series"] }) {
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(1, ...series.map((d) => d.count));
  const slot = WIDTH / series.length;
  const bar = Math.max(2, Math.min(28, slot - 2));
  const height = HEIGHT - AXIS;
  const ticks = [0, Math.round(series.length / 2), series.length - 1].filter((v, i, all) => all.indexOf(v) === i);
  const shown = hover === null ? null : series[hover];
  return (
    <figure className="chart">
      <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="img" aria-label={`Skill use per day, ${series.length} days, highest ${max}`} onMouseLeave={() => setHover(null)}>
        <line x1={0} x2={WIDTH} y1={height} y2={height} className="chart-axis" />
        {series.map((d, i) => {
          const h = d.count ? Math.max(2, (d.count / max) * (height - 8)) : 0;
          const x = i * slot + (slot - bar) / 2;
          return (
            <g key={d.day} onMouseEnter={() => setHover(i)}>
              <rect x={i * slot} y={0} width={slot} height={height} className="chart-hit" />
              {h ? <path className={`chart-bar ${hover === i ? "active" : ""}`} d={barPath(x, height, bar, h)} /> : null}
            </g>
          );
        })}
        {ticks.map((i) => (
          <text key={i} x={i * slot + slot / 2} y={HEIGHT - 6} textAnchor={i === 0 ? "start" : i === series.length - 1 ? "end" : "middle"} className="chart-label">{shortDay(series[i]!.day)}</text>
        ))}
      </svg>
      <figcaption className="muted">{shown ? `${shortDay(shown.day)}: ${shown.count.toLocaleString("en-US")} ${shown.count === 1 ? "use" : "uses"}` : "Point at a day to read its count."}</figcaption>
    </figure>
  );
}

export function WindowPicker({ days, onDays }: { days: number; onDays: (days: number) => void }) {
  return (
    <div className="segmented" role="group" aria-label="Time range">
      {USAGE_WINDOWS.map((d) => <button key={d} type="button" className="secondary small" aria-pressed={d === days} onClick={() => onDays(d)}>{d} days</button>)}
    </div>
  );
}

export function UsagePage({ me, repos }: { me: Principal; repos: RepoRecord[] | null }) {
  const [days, setDays] = useState(30);
  const [repoId, setRepoId] = useState("");
  const [report, setReport] = useState<UsageReport | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let current = true;
    setReport(null);
    setError(null);
    api.usageReport(days, repoId || undefined).then((r) => current && setReport(r), (e: Error) => current && setError(e.message));
    return () => {
      current = false;
    };
  }, [days, repoId, attempt]);
  return (
    <>
      <div className="toolbar">
        <WindowPicker days={days} onDays={setDays} />
        <Select label="Repository" value={repoId} onChange={setRepoId} options={[{ value: "", label: "Every repository" }, ...(repos ?? []).map((r) => ({ value: r.id, label: r.name, hint: r.team }))]} />
        {report?.byTeam.length ? (
          <span className="toolbar-end">
            <a className="button secondary small" href={api.usageExport(days, "csv", repoId || undefined)} download>Export CSV</a>
            <a className="button secondary small" href={api.usageExport(days, "json", repoId || undefined)} download>Export JSON</a>
          </span>
        ) : null}
      </div>
      {error ? <LoadFailed what="skill use" reason={error} onRetry={() => setAttempt(attempt + 1)} panel /> : !report ? <Loading what="skill use" panel /> : (
        <>
          <section className="panel" aria-labelledby="usage-chart-h">
            <h2 id="usage-chart-h">Skill use per day <span className="count">{report.total.toLocaleString("en-US")} in {report.days} days</span></h2>
            {report.total ? <DailyChart series={report.series} /> : <p className="muted">No skill use reported in this range. A team reports once it is asked from its repository's page and each teammate agrees on their own machine.</p>}
            {report.total ? (
              <details>
                <summary>Show as a table</summary>
                <table>
                  <thead><tr><th>Day</th><th>Uses</th></tr></thead>
                  <tbody>{report.series.map((d) => <tr key={d.day}><td>{d.day}</td><td>{d.count}</td></tr>)}</tbody>
                </table>
              </details>
            ) : null}
          </section>
          {report.scope ? <p className="muted">{report.byTeam.length ? `By team and by skill for the teams you own: ${report.scope.teams.join(", ")}. Owners and admins see every team.` : `The teams you own (${report.scope.teams.join(", ")}) reported no skill use in this range.`}</p> : null}
          {report.total && !report.byTeam.length && !report.scope ? <p className="muted">Owners and admins see use by team and by skill; an owner can show it to members under Settings, Privacy.</p> : null}
          {report.total && report.byTeam.length ? (
            <div className="tiles">
              <section className="panel" aria-labelledby="by-team-h">
                <h2 id="by-team-h">By team</h2>
                <table>
                  <thead><tr><th>Team</th><th>Uses</th></tr></thead>
                  <tbody>{report.byTeam.map((t) => <tr key={t.team}><td>{t.team}</td><td><Share count={t.count} total={report.total} /></td></tr>)}</tbody>
                </table>
              </section>
              <section className="panel" aria-labelledby="by-skill-h">
                <h2 id="by-skill-h">By skill <span className="count">{report.bySkill.length}</span></h2>
                <table>
                  <thead><tr><th>Skill</th><th>Team</th><th>Uses</th></tr></thead>
                  <tbody>{report.bySkill.slice(0, 20).map((s) => <tr key={`${s.repoId}/${s.skill}`}><td className="mono">{s.skill}</td><td>{s.team}</td><td>{s.count}</td></tr>)}</tbody>
                </table>
                {report.bySkill.length > 20 ? <p className="muted">The export lists the other {report.bySkill.length - 20}.</p> : null}
              </section>
            </div>
          ) : null}
        </>
      )}
      <p className="muted">Only skill names and counts arrive, from teams that were asked and teammates who agreed. No one's name, prompt or file is reported.</p>
      {/* Read from the tasks started here, not from usage reports; one person's machine has nobody to compare. */}
      {me.mode === "local" ? null : <PeopleOutcomes days={days} />}
    </>
  );
}

function Share({ count, total }: { count: number; total: number }) {
  return (
    <span className="share">
      <span className="share-bar" aria-hidden="true"><span style={{ width: `${Math.round((count / total) * 100)}%` }} /></span>
      {count.toLocaleString("en-US")}
    </span>
  );
}

export function LeaderboardPage({ me }: { me: Principal }) {
  const [days, setDays] = useState(30);
  const [board, setBoard] = useState<Leaderboard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reads, setReads] = useState(0);
  useEffect(() => {
    let current = true;
    setBoard(null);
    setError(null);
    api.leaderboard(days).then((b) => current && setBoard(b), (e: Error) => current && setError(e.message));
    return () => {
      current = false;
    };
  }, [days, reads]);
  if (!manages(me) && error) return <div className="panel"><p className="muted">{error}</p></div>;
  return (
    <>
      <div className="toolbar"><WindowPicker days={days} onDays={setDays} /></div>
      {board?.scope ? <p className="muted">Ranked among the teams you own: {board.scope.teams.join(", ")}. Owners and admins see every team.</p> : null}
      {error ? <LoadFailed what="the leaderboard" reason={error} onRetry={() => setReads((n) => n + 1)} panel /> : !board ? <Loading what="the leaderboard" panel /> : !board.teams.length ? (
        <div className="panel"><p className="muted">No skill use reported in the last {board.days} days.</p></div>
      ) : (
        <div className="tiles">
          <section className="panel" aria-labelledby="lb-teams-h">
            <h2 id="lb-teams-h">Teams</h2>
            <table>
              <thead><tr><th>Rank</th><th>Team</th><th>Skills used</th><th>Uses</th></tr></thead>
              <tbody>{board.teams.map((t, i) => <tr key={t.team}><td>{i + 1}</td><td>{t.team}</td><td>{t.skills}</td><td>{t.count}</td></tr>)}</tbody>
            </table>
          </section>
          <section className="panel" aria-labelledby="lb-skills-h">
            <h2 id="lb-skills-h">Skills</h2>
            <table>
              <thead><tr><th>Rank</th><th>Skill</th><th>Team</th><th>Uses</th></tr></thead>
              <tbody>{board.skills.map((s, i) => <tr key={`${s.repoId}/${s.skill}`}><td>{i + 1}</td><td className="mono">{s.skill}</td><td>{s.team}</td><td>{s.count}</td></tr>)}</tbody>
            </table>
          </section>
        </div>
      )}
      <p className="muted">Teams and skills are ranked; people are not, since a usage report carries no one's name.</p>
    </>
  );
}
