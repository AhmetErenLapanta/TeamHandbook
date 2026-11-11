import { useState } from "react";
import { tasksApi } from "./api";
import type { TaskRecord } from "./api";

const ANSWER_MAX = 4000;
/** The option a refused read of the task's own issue offers: the person pastes the issue's text and the agent reads that instead. */
export const PASTE_ISSUE = "Paste the issue text";
const PASTE_MAX = 8000;

/**
 * What a run stopped to ask, answered by the person who started it: one of the options it offered
 * or their own words, sent as the answer; the task goes back in line and its next run takes it.
 * Everyone else who can see the task reads who it waits on.
 */
export function TaskQuestion({ task, mine, agent, onAnswered }: { task: TaskRecord; mine: boolean; agent: string; onAnswered: (task: TaskRecord) => void }) {
  const [chosen, setChosen] = useState("");
  const [own, setOwn] = useState("");
  const [pasted, setPasted] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const question = task.question;
  if (!question || question.answer) return null;
  const pasting = chosen === PASTE_ISSUE && !own.trim();
  const answer = pasting ? pasted.trim() : own.trim() || chosen;
  const send = (e: React.FormEvent) => {
    e.preventDefault();
    if (!answer) return;
    setBusy(true);
    setError(null);
    tasksApi.answerStopped(task.id, answer).then(onAnswered, (err: Error) => {
      setError(err.message);
      setBusy(false);
    });
  };
  return (
    <section className="section" aria-labelledby="task-question-h">
      <h2 id="task-question-h">{agent || "The agent"} stopped to ask{mine ? " you" : ` ${task.createdBy}`}</h2>
      <p dir="auto" className="pre">{question.text}</p>
      {mine ? (
        <form className="form" onSubmit={send} aria-label="Answer the agent">
          {question.options.length ? (
            <fieldset className="plain-fieldset question">
              <legend className="visually-hidden">Options</legend>
              {question.options.map((option) => (
                <label key={option} className="check">
                  <input type="radio" name="stopped-question" checked={!own.trim() && chosen === option} onChange={() => setChosen(option)} />
                  <span dir="auto">{option}</span>
                </label>
              ))}
            </fieldset>
          ) : null}
          {pasting ? (
            <label>
              The issue's text
              <textarea dir="auto" rows={6} maxLength={PASTE_MAX} value={pasted} onChange={(e) => setPasted(e.target.value)} autoFocus />
            </label>
          ) : null}
          <label>
            {question.options.length ? "Something else" : "Your answer"}
            <textarea dir="auto" className="short" rows={2} maxLength={ANSWER_MAX} value={own} onChange={(e) => setOwn(e.target.value)} />
          </label>
          <div className="actions">
            <button type="submit" disabled={busy || !answer}>Send the answer</button>
          </div>
          {error ? <p className="error" role="alert">{error}</p> : null}
        </form>
      ) : <p className="muted">The answer is {task.createdBy}'s to give.</p>}
    </section>
  );
}
