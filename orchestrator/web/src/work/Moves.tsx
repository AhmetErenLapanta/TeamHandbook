import { useEffect, useState } from "react";
import { NotFound } from "../api";
import { usePref } from "../prefs";
import { here } from "../router";
import { Select } from "../Select";
import { Loading, LoadFailed } from "../Status";
import { workApi } from "./api";
import type { WorkBoard, WorkColumn, WorkMoves, WorkMoveTrigger } from "./api";

const TRIGGERS: { id: WorkMoveTrigger; label: string }[] = [
  { id: "started", label: "When its agent starts" },
  { id: "requestOpened", label: "When its request opens" },
  { id: "merged", label: "When its request is merged" },
];

/** Where a person allows the orchestrator to move Jira issues: their own server's tool picker, opened on that tool. */
const ALLOW_WRITES = () => `${here("integrations")}?allow=transitionJiraIssue`;

/**
 * The board's one switch for moving its issues as their agents work. Nothing else is asked: it
 * writes only where the person's server or the organization's token already can. The first time
 * a board opens, the server's guess from the column names is offered as a card, on in one click.
 */
export function MovesSwitch({ board, columns }: { board: WorkBoard; columns: WorkColumn[] }) {
  const [moves, setMoves] = useState<WorkMoves | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [notNow, setNotNow] = usePref(`orchestrator.work.moves.offered.${board.id}`);
  const load = () => {
    setError(null);
    // An orchestrator whose tracker cannot be moved from here has no such setting; the board stays read-only.
    workApi.moves(board.id).then(setMoves, (e: Error) => (e instanceof NotFound ? setMoves(null) : setError(e.message)));
  };
  useEffect(load, [board.id]);
  if (moves === undefined) return error ? <LoadFailed what="the issue moves" reason={error} onRetry={load} /> : <Loading what="the issue moves" />;
  if (!moves) return null;
  const save = (next: Pick<WorkMoves, "enabled" | "moves">) => {
    setBusy(true);
    setError(null);
    workApi.saveMoves(board.id, next).then((saved) => {
      setMoves(saved);
      setEditing(false);
    }, (e: Error) => setError(e.message)).finally(() => setBusy(false));
  };
  const blocked = !moves.write.allowed ? moves.write.reason ?? "The orchestrator cannot move this tracker's issues." : !moves.canChange ? "Only an owner or an admin changes this for the organization's tracker." : null;
  const mapping = TRIGGERS.filter((t) => moves.moves[t.id]).map((t) => `${t.label.toLowerCase()}, to ${moves.moves[t.id]}`).join("; ");
  const offer = moves.guessed && !moves.enabled && !blocked && notNow !== "yes" && mapping;
  return (
    <div className="moves">
      {offer ? (
        <section className="panel moves-offer" aria-labelledby="moves-offer-h">
          <h2 id="moves-offer-h">Move issues as the agent works?</h2>
          <p>Each issue moves on this board {mapping}. Every move is in the audit log.</p>
          <div className="actions">
            <button type="button" disabled={busy} onClick={() => save({ enabled: true, moves: moves.moves })}>Turn on</button>
            <button type="button" className="secondary" onClick={() => setEditing(true)}>Change the columns</button>
            <button type="button" className="secondary" onClick={() => setNotNow("yes")}>Not now</button>
          </div>
        </section>
      ) : null}
      <div className="moves-switch">
        <button
          type="button"
          role="switch"
          aria-checked={moves.enabled}
          aria-describedby={blocked ? "moves-why" : undefined}
          disabled={busy || Boolean(blocked)}
          onClick={() => save({ enabled: !moves.enabled, moves: moves.moves })}
          className="switch"
        >
          <span className="switch-track" aria-hidden="true"><span className="switch-knob" /></span>
          Move issues as the agent works
        </button>
        {!blocked ? <button type="button" className="link small" aria-expanded={editing} onClick={() => setEditing(!editing)}>Columns</button> : null}
        {blocked ? (
          <p id="moves-why" className="muted small">
            {blocked}
            {moves.write.off ? <> <a href={`${here("integrations")}?open=tracker`}>Open the issue tracker card</a></> : !moves.write.allowed ? <> <a href={ALLOW_WRITES()}>Allow Jira writes</a></> : null}
          </p>
        ) : null}
      </div>
      {editing ? <MovesForm key={JSON.stringify(moves.moves)} moves={moves} columns={columns} busy={busy} onSave={(next) => save({ enabled: moves.enabled || Boolean(offer), moves: next })} onCancel={() => setEditing(false)} /> : null}
      {error ? <p className="error" role="alert">{error}</p> : null}
    </div>
  );
}

function MovesForm({ moves, columns, busy, onSave, onCancel }: { moves: WorkMoves; columns: WorkColumn[]; busy: boolean; onSave: (next: WorkMoves["moves"]) => void; onCancel: () => void }) {
  const [draft, setDraft] = useState(moves.moves);
  const options = [{ value: "", label: "Don't move it" }, ...columns.map((c) => ({ value: c.name, label: c.name }))];
  return (
    <form className="form inline-form" aria-label="Where issues move" onSubmit={(e) => {
      e.preventDefault();
      onSave(draft);
    }}>
      {TRIGGERS.map((t) => (
        <Select key={t.id} label={t.label} value={draft[t.id] ?? ""} options={options} onChange={(v) => setDraft({ ...draft, [t.id]: v || undefined })} />
      ))}
      <div className="actions">
        <button type="submit" disabled={busy}>Save</button>
        <button type="button" className="secondary" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}
