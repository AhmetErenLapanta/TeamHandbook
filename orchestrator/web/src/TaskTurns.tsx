import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { tasksApi } from "./api";
import type { TaskTurnRead } from "./api";
import { ConfirmAction } from "./Confirm";
import { RequestDiff, UNDO_WHY } from "./RequestDiff";
import { turnReads } from "./request-reads";
import { here, navigate } from "./router";
import { Select } from "./Select";
import { whenShort } from "./task-board";
import type { Quote } from "./diff-quote";

const ALL = "all";
const NAME_AT_MOST = 40;

const turnName = (t: TaskTurnRead) => {
  const words = t.said.length > NAME_AT_MOST ? `${t.said.slice(0, NAME_AT_MOST).trimEnd()}…` : t.said;
  return `“${words}” at ${whenShort(t.at)}`;
};

/** What undoing from a turn does, said before it is done. */
export function undoFromSaid(turns: TaskTurnRead[], n: number): string {
  const turn = turns.find((t) => t.n === n);
  const after = turns.filter((t) => t.n > n && !t.undone).length;
  const tail = after ? `; the ${after === 1 ? "turn" : `${after} turns`} after it go${after === 1 ? "es" : ""} too, and the conversation stays.` : "; the conversation stays.";
  return `The files go back to how they were before “${turn?.said ?? ""}”${tail}`;
}

/** Starts another task from the files as one turn left them, with a word on what to do differently; the task it came from stays. */
function NewFromTurn({ taskId, turn }: { taskId: string; turn: TaskTurnRead }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  if (!open) return <button type="button" className="secondary small" onClick={() => setOpen(true)}>Start a new task from here…</button>;
  const start = () => {
    setBusy(true);
    setProblem(null);
    tasksApi.newFromTurn(taskId, turn.n, text.trim()).then((task) => navigate(here("tasks", task.id)), (e: Error) => {
      setProblem(e.message);
      setBusy(false);
    });
  };
  return (
    <form className="form" aria-label="Start a new task from here" onSubmit={(e) => { e.preventDefault(); start(); }}>
      <p>A new task starts from the files as this turn left them; this task and its branch stay as they are.</p>
      <label>What should it do differently?<textarea className="short" value={text} onChange={(e) => setText(e.target.value)} rows={2} maxLength={2000} /></label>
      <div className="actions">
        <button type="submit" disabled={busy}>Start new task</button>
        <button type="button" className="secondary" disabled={busy} onClick={() => setOpen(false)}>Keep reading</button>
      </div>
      {problem ? <p className="error" role="alert">{problem}</p> : null}
    </form>
  );
}

/** The turns of a task's change and the one picked; read where the page holds the Changes heading, so the Select can sit at its end. */
export function useTaskTurns(taskId: string) {
  const [turns, setTurns] = useState<TaskTurnRead[]>([]);
  const [picked, setPicked] = useState(ALL);
  useEffect(() => {
    let current = true;
    setPicked(ALL);
    tasksApi.turns(taskId).then((t) => current && setTurns(t), () => undefined);
    return () => {
      current = false;
    };
  }, [taskId]);
  return { turns, setTurns, picked, setPicked };
}
export type TurnPick = ReturnType<typeof useTaskTurns>;

/** One turn is the whole change, so there is nothing to choose; the Select is for two turns or more. */
const choosable = (turns: TaskTurnRead[]) => turns.length > 1;

/** At the end of the Changes heading, "All changes" first and then a turn each; its name is for screen readers. */
export function TurnSelect({ pick }: { pick: TurnPick }) {
  if (!choosable(pick.turns)) return null;
  return (
    <div className="turn-select">
      <Select label="Show" labelHidden value={pick.picked} onChange={pick.setPicked} options={[{ value: ALL, label: "All changes" }, ...pick.turns.map((t) => ({ value: String(t.n), label: turnName(t), ...(t.undone ? { hint: "undone" } : {}) }))]} />
    </div>
  );
}

/**
 * A task's change a turn at a time: with a turn picked in the Select over the changes, that turn's files show alone and
 * the section's own action undoes from it. Where there is no choice to make, `all` is all there is.
 */
export function TaskTurns({ taskId, pick, all, canUndo, onUndone, onQuote }: { taskId: string; pick: TurnPick; all: ReactNode; canUndo: boolean; onUndone: () => void; onQuote?: (quote: Quote) => void }) {
  const { turns, setTurns, picked, setPicked } = pick;
  const n = picked === ALL ? null : Number(picked);
  const turn = choosable(turns) ? turns.find((t) => t.n === n) : undefined;
  const undo = (why: string) => tasksApi.undoFromTurn(taskId, n!, why).then((next) => {
    setTurns(next);
    setPicked(ALL);
    onUndone();
  });
  if (!turn) return <>{all}</>;
  return (
    <>
      <RequestDiff key={turn.n} reads={turnReads(taskId, turn.n)} bare {...(onQuote ? { onQuote } : {})} />
      {turn.newTaskId ? <p className="muted small">A new task started from here: <a href={here("tasks", turn.newTaskId)}>open it</a></p> : null}
      {canUndo && !turn.undone ? (
        <div className="actions">
          <NewFromTurn key={turn.n} taskId={taskId} turn={turn} />
          <ConfirmAction small trigger="Undo from this turn…" consequence={undoFromSaid(turns, turn.n)} confirm="Undo these turns" keep="Keep them" reason={UNDO_WHY} onConfirm={undo} />
        </div>
      ) : null}
    </>
  );
}
