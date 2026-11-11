import { useId, useState } from "react";
import type { RequestRecord } from "../api";
import type { PolicyProposal, PolicySaved, RequestConfirmation } from "./api";
import { sharedMessage } from "./policy";

type RequestPlan = Extract<PolicyProposal, { applies: "request" }>;

const CHANGE: Record<RequestPlan["repos"][number]["change"], string> = { add: "adds the policy", change: "changes the policy", remove: "removes the policy" };

/** The requests a save or a removal opens, one per repository, with the message and branches the person confirms. */
export function ConfirmRequests({ plan, action, onConfirm, onCancel }: { plan: RequestPlan; action: string; onConfirm: (confirm: RequestConfirmation) => Promise<void>; onCancel: () => void }) {
  const id = useId();
  const [message, setMessage] = useState(() => sharedMessage(plan.repos.map((r) => r.proposal)));
  const [branches, setBranches] = useState<Record<string, string>>(() => Object.fromEntries(plan.repos.map((r) => [r.repoId, r.branch])));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const open = async () => {
    setBusy(true);
    setError(null);
    await onConfirm({ message, branches, baseShas: Object.fromEntries(plan.repos.map((r) => [r.repoId, r.head])) }).catch((e: Error) => setError(e.message));
    setBusy(false);
  };
  const n = plan.repos.length;
  return (
    // Enter in a field here confirms nothing on its own, and inside a removal form it would submit that form instead.
    <section className="panel confirm" aria-labelledby={`${id}-h`} onKeyDown={(e) => e.key === "Enter" && e.target instanceof HTMLInputElement && e.preventDefault()}>
      <h2 id={`${id}-h`}>{action} as {n === 1 ? "a request" : `${n} requests`}</h2>
      <p className="muted">Each team repository gets its own request, and teammates get the change once it is merged there.</p>
      <div className="field">
        <label htmlFor={`${id}-msg`}>Commit message</label>
        <input id={`${id}-msg`} value={message} onChange={(e) => setMessage(e.target.value)} />
      </div>
      <ul className="plain confirm-repos">
        {plan.repos.map((r) => (
          <li key={r.repoId}>
            <p><strong>{r.name}</strong> <span className="muted">({CHANGE[r.change]})</span></p>
            <p className="muted small-print">Proposed: <span className="mono">{r.proposal}</span></p>
            <label className="inline-label" htmlFor={`${id}-b-${r.repoId}`}>Branch</label>
            <input id={`${id}-b-${r.repoId}`} className="mono" value={branches[r.repoId] ?? ""} onChange={(e) => setBranches({ ...branches, [r.repoId]: e.target.value })} />
          </li>
        ))}
      </ul>
      {error ? <p className="error" role="alert">{error}</p> : null}
      <div className="actions">
        <button type="button" onClick={open} disabled={busy || !message.trim()}>{busy ? "Opening…" : n === 1 ? "Open the request" : `Open ${n} requests`}</button>
        <button type="button" className="secondary" onClick={onCancel} disabled={busy}>Back to the policy</button>
      </div>
    </section>
  );
}

/** What a save that opened requests left behind: a link to each, and any repository where it did not open. */
export function OpenedRequests({ saved, repoName, back }: { saved: Extract<PolicySaved, { saved: "request" }>; repoName: (id: string) => string; back: string }) {
  return (
    <section className="panel" role="status" aria-labelledby="opened-h">
      <h2 id="opened-h">{saved.requests.length ? "Saved as a request; reaches teammates when merged" : "No request opened"}</h2>
      {saved.requests.length ? (
        <ul className="plain">
          {saved.requests.map((r: RequestRecord) => <li key={`${r.repoId}/${r.number}`}><a href={r.url} target="_blank" rel="noreferrer">{repoName(r.repoId)} #{r.number}</a> <span className="muted">{r.title}</span></li>)}
        </ul>
      ) : null}
      {saved.failed.length ? (
        <>
          <p className="error">These repositories did not get a request:</p>
          <ul className="plain">{saved.failed.map((f) => <li key={f.repoId}><strong>{repoName(f.repoId)}</strong>: {f.error}</li>)}</ul>
        </>
      ) : null}
      <p><a href={back}>Back to policies</a></p>
    </section>
  );
}
