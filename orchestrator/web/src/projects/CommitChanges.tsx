import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { projectsRead } from "../projects-read";
import type { CommitPlan } from "../projects-read";
import { Loading, LoadFailed } from "../Status";

const STATUS: Record<CommitPlan["files"][number]["status"], string> = { added: "added", modified: "changed", deleted: "deleted", renamed: "renamed" };

/** The message a commit starts from: the server's for a repository's first, the task's title after. */
export function commitMessage(plan: Pick<CommitPlan, "first" | "message">, title: string): string {
  return plan.first || !title.trim() ? plan.message : title.trim();
}

/**
 * A commit of what is in the folder now, made as the person with their own git settings. Every
 * file is listed and ticked but one that looks like a secret, which stays out unless ticked.
 */
export function CommitChanges({ projectId, title, onCommitted, onCancel }: { projectId: string; title: string; onCommitted: (headSha: string) => void; onCancel: () => void }) {
  const [plan, setPlan] = useState<CommitPlan | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [reads, setReads] = useState(0);
  const [message, setMessage] = useState("");
  const [left, setLeft] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  useEffect(() => {
    setFailed(null);
    projectsRead.commitPlan(projectId).then((read) => {
      setPlan(read);
      setMessage(commitMessage(read, title));
      setLeft(new Set(read.files.filter((f) => f.secretLike).map((f) => f.path)));
    }, (e: Error) => setFailed(e.message));
  }, [projectId, reads]);
  if (failed) return <LoadFailed what="what the commit takes" reason={failed} onRetry={() => setReads((n) => n + 1)} />;
  if (!plan) return <Loading what="what the commit takes" />;
  const flip = (path: string) => setLeft((now) => {
    const next = new Set(now);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    return next;
  });
  const taken = plan.files.length - left.size;
  const commit = (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setRefused(null);
    projectsRead.commit(projectId, message.trim(), [...left]).then((r) => onCommitted(r.headSha), (err: Error) => {
      setRefused(err.message);
      setBusy(false);
    });
  };
  return (
    <form className="form" onSubmit={commit} aria-label="Commit these changes">
      <label>Message<input value={message} onChange={(e) => setMessage(e.target.value)} maxLength={200} required /></label>
      <fieldset className="plain-fieldset">
        <legend>Files in the commit <span className="count">{taken} of {plan.files.length}</span></legend>
        <ul className="checks">
          {plan.files.map((f) => (
            <li key={f.path}>
              <label className="check">
                <input type="checkbox" checked={!left.has(f.path)} onChange={() => flip(f.path)} />
                <span className="mono" dir="auto">{f.path}</span> <span className="muted">{STATUS[f.status]}{f.secretLike ? ", looks like it holds a secret, left out" : ""}</span>
              </label>
            </li>
          ))}
        </ul>
        {plan.omitted ? <p className="muted small">{plan.omitted} more {plan.omitted === 1 ? "file is" : "files are"} not listed.</p> : null}
      </fieldset>
      {refused ? <p className="error" role="alert">{refused}</p> : null}
      <div className="actions">
        <button type="submit" disabled={busy || !message.trim() || !taken}>Commit</button>
        <button type="button" className="secondary" onClick={onCancel} disabled={busy}>Cancel</button>
      </div>
    </form>
  );
}
