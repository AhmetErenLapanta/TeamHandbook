import { useEffect, useState } from "react";
import { tasksApi } from "../api";
import type { CheckStatus, Readiness } from "../api";

const CHECK_TONE: Record<CheckStatus, string> = { ok: "ok", warn: "warn", fail: "error", unknown: "warn" };

/** Every offered agent as the last check found it, for an admin, who can ask for a fresh check. */
export function AgentReadinessSettings() {
  const [readiness, setReadiness] = useState<Readiness | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const load = (fresh: boolean) => {
    setBusy(true);
    setError(null);
    tasksApi.readiness(fresh).then(setReadiness, (e: Error) => setError(e.message)).finally(() => setBusy(false));
  };
  useEffect(() => load(false), []);
  return (
    <section className="panel" aria-label="Agent readiness">
      <p className="muted">How each agent's CLI, version, credential and sign-in look to a task; a check never stops a task from starting.</p>
      {error ? <p className="error">{error}</p> : null}
      {!readiness ? <p className="muted">{busy ? "Checking…" : null}</p> : (
        <table className="row-cards">
          <thead><tr><th>Agent</th><th>Status</th><th>Checks</th></tr></thead>
          <tbody>
            {readiness.agents.map((agent) => (
              <tr key={agent.id} data-agent={agent.id}>
                <td className="rc-title">{agent.label}</td>
                <td className="rc-status"><span className={`badge ${agent.ready ? "ok" : "error"}`}>{agent.ready ? "ready" : "not ready"}</span></td>
                <td className="rc-wide">
                  <ul className="checks">
                    {agent.checks.map((check) => (
                      <li key={check.name}><span className={`badge ${CHECK_TONE[check.status]}`}>{check.status}</span><strong>{check.name}</strong> {check.detail}</li>
                    ))}
                  </ul>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="actions">
        <button type="button" onClick={() => load(true)} disabled={busy}>Check again</button>
        {readiness ? <span className="muted">Checked at {readiness.checkedAt.slice(11, 19)}.</span> : null}
      </div>
    </section>
  );
}
