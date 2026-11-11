import { useEffect, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { directory, manages, members } from "../api";
import type { MemberPage, MemberTag, Principal } from "../api";
import { MemberConfigSection } from "../controls/MemberConfig";
import { here, navigate } from "../router";
import { LoadFailed, Loading } from "../Status";
import { MemberAccess, signInLabel } from "./Members";

function day(at: string): string {
  return new Date(at).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function Tags({ id, tags, editable }: { id: string; tags: MemberTag[]; editable: boolean }) {
  const [shown, setShown] = useState(tags);
  const [text, setText] = useState(tags.filter((t) => t.source === "manual").map((t) => t.tag).join(" "));
  const [error, setError] = useState<string | null>(null);
  const save = (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    directory.setTags(id, text.split(/[\s,]+/).filter(Boolean)).then(setShown, (err: Error) => setError(err.message));
  };
  return (
    <>
      <p>{shown.length ? shown.map((t) => `${t.tag}${t.source === "directory" ? " (from a group)" : ""}`).join(", ") : <span className="muted">no tag</span>}</p>
      {editable ? (
        <form className="form inline-form" onSubmit={save} aria-label="Tags added by hand">
          <label>Tags added by hand<input value={text} onChange={(e) => setText(e.target.value)} placeholder="on-call backend" /></label>
          <button type="submit" className="secondary">Save tags</button>
          {error ? <p className="error" role="alert">{error}</p> : null}
        </form>
      ) : null}
    </>
  );
}

/** One member: their role, teams and tags, and what they opened and started in the orchestrator. */
export function MemberView({ id, me, nav }: { id: string; me: Principal; nav: ReactNode }) {
  const [page, setPage] = useState<MemberPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    let current = true;
    setError(null);
    members.page(id).then((p) => current && setPage(p), (e: Error) => current && setError(e.message));
    return () => {
      current = false;
    };
  }, [id, version]);
  const head = (title: string) => (
    <>
      <header className="page-head">
        <nav className="crumbs" aria-label="Breadcrumb"><a href={here("settings", "members")}>Members</a></nav>
        <h1>{title}</h1>
      </header>
      {nav}
    </>
  );
  if (error && !page) return <>{head("Member")}<LoadFailed what="the member" reason={error} panel onRetry={() => setVersion(version + 1)} /></>;
  if (!page) return <>{head("Member")}<Loading what="the member" panel /></>;
  const { member, requests, tasks, totals } = page;
  return (
    <>
      {head(member.name)}
      <section className="panel" aria-label={`${member.name}'s account`}>
        <dl className="facts">
          <div><dt>Email</dt><dd>{member.email}</dd></div>
          <div><dt>Joined</dt><dd>{day(member.createdAt)}</dd></div>
          <div><dt>Signs in with</dt><dd>{signInLabel(member.signIn)}</dd></div>
        </dl>
        <MemberAccess user={member} me={me} onChanged={() => setVersion(version + 1)} onRemoved={() => navigate(here("settings", "members"))} />
        <h2>Tags</h2>
        <Tags id={member.id} tags={page.tags} editable={manages(me)} />
      </section>
      <MemberConfigSection id={member.id} />
      <section className="panel" aria-labelledby="member-req-h">
        <h2 id="member-req-h">Requests opened <span className="count">{totals.requests}</span></h2>
        {requests.length ? (
          <table>
            <thead><tr><th>Request</th><th>Repository</th><th>Status</th><th>Opened</th></tr></thead>
            <tbody>
              {requests.map((r) => (
                <tr key={`${r.repoId}-${r.number}`}>
                  <td>#{r.number} {r.title}</td>
                  <td><a href={here("repositories", r.repoId)}>{r.repoId}</a></td>
                  <td>{r.status}</td>
                  <td>{day(r.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : <p className="muted">No request opened from the orchestrator yet.</p>}
      </section>
      <section className="panel" aria-labelledby="member-task-h">
        <h2 id="member-task-h">Tasks started <span className="count">{totals.tasks}</span></h2>
        {tasks.length ? (
          <table>
            <thead><tr><th>Task</th><th>Repository</th><th>Status</th><th>Started</th></tr></thead>
            <tbody>
              {tasks.map((t) => (
                <tr key={t.id}>
                  <td><a href={here("tasks", t.id)}>{t.title}</a></td>
                  <td>{t.repoId}</td>
                  <td>{t.status}</td>
                  <td>{day(t.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : <p className="muted">No task started yet.</p>}
      </section>
    </>
  );
}
