import { useState } from "react";
import type { WorkColumn } from "./api";
import { workApi } from "./api";

/**
 * How a person groups the statuses of a board read through their own server, which reads no
 * board configuration: each status gets the name of the column it sits in, and statuses given one
 * name share a column, in the order they first appear. It is the person's own; the tracker is
 * never changed.
 */
export function ArrangeColumns({ board, columns, onSaved }: { board: string; columns: WorkColumn[]; onSaved: () => void }) {
  const statuses = columns.flatMap((c) => c.statuses.map((s) => ({ status: s, column: c.name })));
  const [names, setNames] = useState<Record<string, string>>(() => Object.fromEntries(statuses.map((s) => [s.status, s.column])));
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const save = (next: WorkColumn[] | null) => {
    setBusy(true);
    setError(null);
    workApi.saveColumns(board, next).then(() => {
      setSaid(next ? "Your columns are saved. Only you see them; Jira is not changed." : "The board shows a column per status again.");
      onSaved();
    }, (e: Error) => setError(e.message)).finally(() => setBusy(false));
  };
  const grouped = () => {
    const order: string[] = [];
    const by = new Map<string, string[]>();
    for (const { status } of statuses) {
      const name = (names[status] ?? status).trim() || status;
      if (!by.has(name)) {
        by.set(name, []);
        order.push(name);
      }
      by.get(name)!.push(status);
    }
    return order.map((name) => ({ name, statuses: by.get(name)! }));
  };
  return (
    <details className="arrange-columns">
      <summary>Arrange columns</summary>
      <p className="muted small">Your server reads no board configuration, so the board shows a column per status. Name the column each status sits in; statuses with the same name share one.</p>
      <ul className="plain">
        {statuses.map(({ status }) => (
          <li key={status}>
            <label>
              {status}
              <input value={names[status] ?? ""} maxLength={60} onChange={(e) => setNames({ ...names, [status]: e.target.value })} aria-label={`Column for ${status}`} />
            </label>
          </li>
        ))}
      </ul>
      <div className="actions">
        <button type="button" className="secondary" disabled={busy} onClick={() => save(grouped())}>Save the columns</button>
        <button type="button" className="ghost" disabled={busy} onClick={() => save(null)}>A column per status</button>
      </div>
      {said ? <p role="status">{said}</p> : null}
      {error ? <p className="error" role="alert">{error}</p> : null}
    </details>
  );
}
