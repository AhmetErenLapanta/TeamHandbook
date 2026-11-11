import { useEffect, useState } from "react";
import { people } from "../api";
import { Select } from "../Select";
import { LoadFailed } from "../Status";
import { workApi } from "./api";
import type { WorkBoard } from "./api";

/**
 * For an owner or an admin on an organization board: which team works on it. A member sees an
 * organization board only once it is mapped to their team, so an unmapped one asks here first.
 */
export function BoardTeam({ board, onMapped }: { board: WorkBoard; onMapped: (team: string | null) => void }) {
  const [teams, setTeams] = useState<string[] | null>(null);
  const [team, setTeam] = useState(board.team ?? "");
  const [editing, setEditing] = useState(!board.team);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const load = () => {
    setLoadError(null);
    people.teams().then((t) => setTeams(t.map((x) => x.team)), (e: Error) => setLoadError(e.message));
  };
  useEffect(load, []);
  const save = () => {
    setBusy(true);
    setError(null);
    workApi.mapBoard(board.id, team || null).then(() => {
      setEditing(false);
      onMapped(team || null);
    }, (e: Error) => setError(e.message)).finally(() => setBusy(false));
  };
  if (!editing) {
    return (
      <p className="muted small board-team">
        Shown to the {board.team} team. <button type="button" className="link small" onClick={() => setEditing(true)}>Change</button>
      </p>
    );
  }
  return (
    <div className={board.team ? "board-team" : "panel board-team"} role="group" aria-label="Who works on this board">
      {!board.team ? <p>Pick the team that works on this board; its members see it from then on.</p> : null}
      <div className="actions">
        <Select label="Team" value={team} onChange={setTeam} placeholder={teams === null ? "Loading the teams…" : "Pick a team"} options={(teams ?? []).map((t) => ({ value: t, label: t }))} disabled={!teams?.length} />
        <button type="button" disabled={busy || !team} onClick={save}>Save</button>
        {board.team ? <button type="button" className="secondary" onClick={() => setEditing(false)}>Cancel</button> : null}
      </div>
      {loadError ? <LoadFailed what="the teams" reason={loadError} onRetry={load} /> : null}
      {teams !== null && !teams.length ? <p className="muted small">A team appears here once one of its repositories is connected under Repositories.</p> : null}
      {error ? <p className="error" role="alert">{error}</p> : null}
    </div>
  );
}
