import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { csvLines } from "../../shared/csv";
import { api, manages, NotFound, tasksApi } from "./api";
import type { AuditFilter, OrchestratorEvent, EventPage, EventRecord, Principal, RepoRecord, RequestRecord, TaskRecord } from "./api";
import { PAGE_SIZE, Pager, pageOf } from "./Pager";
import { Loading, LoadFailed } from "./Status";
import { here, pathIn, placeOf } from "./router";
import { stateOf, stateSaid } from "./task-state";
import type { TaskState } from "./task-state";
import { Select } from "./Select";

const LOG_DAYS = 30;
const STATES: TaskState[] = ["waiting", "working", "usage-limit", "waiting-machine", "needs-you", "kept", "in-review", "merged", "undone", "failed", "stopped"];

export interface LogEntry { at: string; title: string; repoId: string; team: string; state: TaskState; status: string; by: string; to: string }

/** One row a task in the last days, newest first, its state in the one word every list says it in. */
export function logEntries(org: string, tasks: TaskRecord[], since: string, me?: string): LogEntry[] {
  return tasks
    .map((t): LogEntry => ({ at: t.createdAt, title: t.title, repoId: t.repoId, team: t.team, state: stateOf(t), status: stateSaid(stateOf(t), t.forge).word, by: me && t.createdBy === me ? "you" : t.createdBy, to: pathIn(org, "tasks", t.id) }))
    .filter((e) => e.at >= since)
    .sort((a, b) => b.at.localeCompare(a.at));
}

export function logCsv(entries: LogEntry[]): string {
  return csvLines(["time", "title", "repository", "team", "status", "by"], entries.map((e) => [e.at, e.title, e.repoId, e.team, e.status, e.by]));
}

function download(name: string, type: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}

export function LogsPage({ repos, me }: { repos: RepoRecord[] | null; me?: string }) {
  const [entries, setEntries] = useState<LogEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [state, setState] = useState("");
  const [repoId, setRepoId] = useState("");
  const [needle, setNeedle] = useState("");
  const [page, setPage] = useState(1);
  const read = () => {
    const since = new Date(Date.now() - LOG_DAYS * 86_400_000).toISOString();
    setError(null);
    tasksApi.since(since).then(
      (tasks) => setEntries(logEntries(placeOf(window.location.pathname).org ?? "", tasks, since, me)),
      (e: Error) => setError(e.message),
    );
  };
  useEffect(read, [repos, me]);
  const text = needle.trim().toLowerCase();
  const matching = (entries ?? []).filter((e) => (!state || e.state === state) && (!repoId || e.repoId === repoId) && (!text || `${e.title} ${e.by} ${e.status}`.toLowerCase().includes(text)));
  const shown = pageOf(matching, page);
  const filter = (set: (v: string) => void) => (e: { target: { value: string } }) => {
    set(e.target.value);
    setPage(1);
  };
  const stamp = new Date().toISOString().slice(0, 10);
  return (
    <>
      <div className="toolbar">
        <Select label="State" value={state} onChange={(v) => filter(setState)({ target: { value: v } })} options={[{ value: "", label: "Every state" }, ...STATES.map((x) => ({ value: x, label: stateSaid(x, null).word }))]} />
        <Select label="Repository" value={repoId} onChange={(v) => filter(setRepoId)({ target: { value: v } })} options={[{ value: "", label: "Every repository" }, ...(repos ?? []).map((r) => ({ value: r.id, label: r.name, hint: r.team }))]} />
        <label className="inline-label">Find<input type="search" value={needle} onChange={filter(setNeedle)} /></label>
        <span className="toolbar-end">
          <button type="button" className="secondary small" disabled={!matching.length} onClick={() => download(`logs-${stamp}.csv`, "text/csv", logCsv(matching))}>Export CSV</button>
          <button type="button" className="secondary small" disabled={!matching.length} onClick={() => download(`logs-${stamp}.json`, "application/json", JSON.stringify(matching, null, 2))}>Export JSON</button>
        </span>
      </div>
      <section className="panel" aria-labelledby="logs-h">
        <h2 id="logs-h">Tasks, last {LOG_DAYS} days <span className="count">{entries ? matching.length : ""}</span></h2>
        {error ? <LoadFailed what="the tasks" reason={error} onRetry={read} /> : !entries ? <Loading what="the tasks" /> : !matching.length ? <p className="muted">{entries.length ? "Nothing matches these filters." : `Nothing ran or was proposed in the last ${LOG_DAYS} days.`}</p> : (
          <table>
            <thead><tr><th>Time</th><th>What</th><th>Repository</th><th>Status</th><th>By</th></tr></thead>
            <tbody>
              {shown.shown.map((e) => (
                <tr key={`${e.to}:${e.title}`}>
                  <td>{e.at.slice(0, 16).replace("T", " ")}</td>
                  <td><a href={e.to}>{e.title}</a></td>
                  <td>{e.repoId}</td>
                  <td>{e.status}</td>
                  <td>{e.by}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <Pager page={shown.page} total={matching.length} pageSize={PAGE_SIZE} onPage={setPage} label="Pages of the log" />
      </section>
    </>
  );
}

function actorName(e: OrchestratorEvent): string {
  return e.actor.kind === "orchestrator" ? "System" : e.actor.name || e.actor.email || "someone removed since";
}

/** What changed, in one line: the first field as before and after and how many more, or the event's own detail. */
export function changeLine(e: OrchestratorEvent): string {
  const [first, ...rest] = e.changes ?? [];
  if (!first) return e.detail;
  const value = (v: string | null) => (v === null ? "none" : v);
  return `${first.field}: ${value(first.from)} → ${value(first.to)}${rest.length ? ` +${rest.length}` : ""}`;
}

export function AuditPage({ me, repos }: { me: Principal; repos: RepoRecord[] | null }) {
  const [filter, setFilter] = useState<AuditFilter>({});
  const [auditRepo, setAuditRepo] = useState("");
  const [pages, setPages] = useState<EventPage[] | null>(null);
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!manages(me)) return;
    let current = true;
    setPages(null);
    setError(null);
    api.audit(filter, null).then(
      (p) => {
        if (!current) return;
        if (p === null) setMissing(true);
        else setPages([p]);
      },
      (e: Error) => current && setError(e.message),
    );
    return () => {
      current = false;
    };
  }, [filter]);
  if (!manages(me)) return <div className="panel"><p className="muted">Owners and admins read the audit log.</p></div>;
  if (missing) return <div className="panel"><p className="muted">Audit recording has not started. Every request the orchestrator opens is on the Logs page meanwhile.</p></div>;
  const more = () => {
    const next = pages?.at(-1)?.next;
    if (!next) return;
    setBusy(true);
    api.audit(filter, next).then(
      (p) => {
        if (p) setPages([...(pages ?? []), p]);
        setBusy(false);
      },
      (e: Error) => {
        setError(e.message);
        setBusy(false);
      },
    );
  };
  const events = pages?.flatMap((p) => p.events) ?? [];
  const retention = pages?.[0]?.retentionDays;
  const apply = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const value = (key: string) => String(form.get(key) ?? "").trim() || undefined;
    setFilter({ repo: auditRepo || undefined, kind: value("kind"), since: value("since"), until: value("until") });
  };
  return (
    <>
      <form className="toolbar" onSubmit={apply} aria-label="Filter the audit log">
        <Select label="Repository" value={auditRepo} onChange={setAuditRepo} options={[{ value: "", label: "Every repository" }, ...(repos ?? []).map((r) => ({ value: r.id, label: r.name, hint: r.team }))]} />
        <label className="inline-label">Action<input name="kind" defaultValue={filter.kind ?? ""} placeholder="request" /></label>
        <label className="inline-label">From<input name="since" type="date" defaultValue={filter.since ?? ""} /></label>
        <label className="inline-label">To<input name="until" type="date" defaultValue={filter.until ?? ""} /></label>
        <button type="submit" className="secondary small">Filter</button>
        <span className="toolbar-end">
          <a className="button secondary small" href={api.auditExport(filter, "csv")} download>Export CSV</a>
          <a className="button secondary small" href={api.auditExport(filter, "jsonl")} download>Export JSON Lines</a>
        </span>
      </form>
      <section className="panel" aria-labelledby="audit-h">
        <h2 id="audit-h">Changes {retention ? <span className="count">kept {retention} days</span> : null}</h2>
        {error ? <LoadFailed what="changes" reason={error} onRetry={() => setFilter({ ...filter })} /> : !pages ? <Loading what="changes" /> : !events.length ? <p className="muted">No change matches these filters.</p> : (
          <table>
            <thead><tr><th>Time</th><th>Action</th><th>Resource</th><th>Change</th><th>Changed by</th></tr></thead>
            <tbody>
              {events.map((e) => (
                <tr key={e.id}>
                  <td><a href={here("activity", "audit", e.id)}>{e.at.slice(0, 16).replace("T", " ")}</a></td>
                  <td className="mono">{e.kind}</td>
                  <td>{[e.repoId, e.subject].filter(Boolean).join(" · ")}</td>
                  <td>{changeLine(e)}</td>
                  <td>{actorName(e)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {pages?.at(-1)?.next ? <div className="actions"><button type="button" className="secondary small" disabled={busy} onClick={more}>Show older changes</button></div> : null}
      </section>
    </>
  );
}

const ACTOR_KIND: Record<OrchestratorEvent["actor"]["kind"], string> = { user: "Person", service: "Service account", orchestrator: "The orchestrator itself" };

/** One recorded change on a page of its own: every field it changed, who changed it, and a link to share. */
export function AuditEntry({ me, id }: { me: Principal; id: string }) {
  const [read, setRead] = useState<EventRecord | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  useEffect(() => {
    if (!manages(me)) return;
    setRead(null);
    setError(null);
    api.event(id).then(setRead, (e: Error) => setError(e instanceof NotFound ? "This organization's audit log has no such change; it is from another organization, or older than the log keeps." : e.message));
  }, [id]);
  const back = <p><a href={here("activity", "audit")}>All changes</a></p>;
  if (!manages(me)) return <div className="panel"><p className="muted">Owners and admins read the audit log.</p></div>;
  if (error) return <div className="panel" role="alert"><p className="error">{error}</p>{back}</div>;
  if (!read) return <Loading what="the change" panel />;
  const { event, link } = read;
  const copy = () => {
    if (!navigator.clipboard) return setCopied("select it and copy");
    navigator.clipboard.writeText(link).then(() => setCopied("copied"), () => setCopied("select it and copy"));
  };
  return (
    <>
      {back}
      <section className="panel" aria-labelledby="entry-h">
        <h2 id="entry-h"><span className="mono">{event.kind}</span></h2>
        <dl className="facts wide">
          <div><dt>Time</dt><dd>{event.at.replace("T", " ").slice(0, 19)} UTC</dd></div>
          <div><dt>Changed by</dt><dd>{actorName(event)}{event.actor.email && event.actor.kind !== "orchestrator" ? <span className="muted"> · {event.actor.email}</span> : null}</dd></div>
          <div><dt>Kind of actor</dt><dd>{ACTOR_KIND[event.actor.kind]}</dd></div>
          <div><dt>Repository</dt><dd>{event.repoId ?? "none"}</dd></div>
          <div><dt>Resource</dt><dd className="mono">{event.subject ?? "none"}</dd></div>
        </dl>
        <p>{event.detail}</p>
      </section>
      {event.changes?.length ? (
        <section className="panel" aria-labelledby="entry-changes-h">
          <h2 id="entry-changes-h">Fields changed <span className="count">{event.changes.length}</span></h2>
          <table>
            <thead><tr><th>Field</th><th>Before</th><th>After</th></tr></thead>
            <tbody>{event.changes.map((ch) => <tr key={ch.field}><td>{ch.field}</td><td className="mono">{ch.from ?? "none"}</td><td className="mono">{ch.to ?? "none"}</td></tr>)}</tbody>
          </table>
        </section>
      ) : null}
      <section className="panel" aria-labelledby="entry-link-h">
        <h2 id="entry-link-h">Link to this change</h2>
        <p><code className="link">{link}</code> <button type="button" className="secondary small" onClick={copy}>Copy link</button>{copied ? <span className="muted" role="status"> {copied}</span> : null}</p>
        <p className="muted">It opens for owners and admins of this organization.</p>
      </section>
    </>
  );
}
