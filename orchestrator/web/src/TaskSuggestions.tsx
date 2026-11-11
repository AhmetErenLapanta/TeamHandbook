import { useState } from "react";
import { tasksApi } from "./api";
import type { TaskRecord, TaskSuggestion } from "./api";

/** How an answered suggestion stands, as its card says it to the starter and to whoever wrote it. */
function settled(s: TaskSuggestion, starter: string, mine: boolean): string {
  if (s.status === "continued") return mine ? "You continued with it." : `${starter} continued with it.`;
  if (s.status === "dismissed") return mine ? "You dismissed it." : `${starter} dismissed it.`;
  if (s.status === "expired") return "The request ended before it was answered.";
  return `Waiting for ${starter} to continue with it or dismiss it.`;
}

function SuggestionCard({ task, suggestion, starter, mine, onAnswered }: { task: TaskRecord; suggestion: TaskSuggestion; starter: string; mine: boolean; onAnswered: (continued: boolean) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const answer = (how: "continue" | "dismiss") => {
    setBusy(true);
    setError(null);
    tasksApi.answerSuggestion(task.id, suggestion.id, how).then(() => onAnswered(how === "continue"), (err: Error) => {
      setError(err.message);
      setBusy(false);
    });
  };
  const waiting = suggestion.status === "waiting";
  return (
    <li className={`approval${waiting ? " pending" : ""}`} aria-label={`${suggestion.by.name} suggests a follow-up`}>
      <p><strong dir="auto">{suggestion.by.name} suggests:</strong> <span className="pre" dir="auto">{suggestion.text}</span></p>
      {suggestion.quotes?.length ? (
        <ul className="plain" aria-label="Quoted lines">
          {suggestion.quotes.map((q) => <li key={`${q.path}:${q.lines}`} className="mono small">{q.path}:{q.lines}</li>)}
        </ul>
      ) : null}
      {suggestion.canAnswer ? (
        <div className="actions">
          <button type="button" disabled={busy} onClick={() => answer("continue")}>Continue with it</button>
          <button type="button" className="secondary" disabled={busy} onClick={() => answer("dismiss")}>Dismiss</button>
        </div>
      ) : <p className="muted small">{settled(suggestion, starter, mine)}</p>}
      {error ? <p className="error" role="alert">{error}</p> : null}
    </li>
  );
}

/**
 * Follow-ups teammates reviewing the request suggested, each as a card: only the person who
 * started the task sends one on to the agent or dismisses it, and its writer reads how it stands.
 */
export function TaskSuggestions({ task, me, onAnswered }: { task: TaskRecord; me: { email: string }; onAnswered: (continued: boolean) => void }) {
  const list = task.suggestions ?? [];
  if (!list.length) return null;
  const mine = task.createdBy === me.email;
  const starter = task.startedBy?.name ?? "the person who started this task";
  const waiting = list.filter((s) => s.status === "waiting").length;
  const ordered = [...list].reverse().sort((a, b) => Number(b.status === "waiting") - Number(a.status === "waiting"));
  return (
    <section className="section" aria-labelledby="task-suggestions-h">
      <h2 id="task-suggestions-h">Suggested follow-ups <span className="count">{waiting ? `${waiting} waiting` : list.length}</span></h2>
      <ul className="plain approvals">
        {ordered.map((s) => <SuggestionCard key={s.id} task={task} suggestion={s} starter={starter} mine={mine} onAnswered={onAnswered} />)}
      </ul>
    </section>
  );
}
