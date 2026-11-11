import { useState } from "react";
import type { ReactNode } from "react";
import { ApiError, tasksApi } from "./api";
import type { TaskRecord } from "./api";
import type { Quote } from "./diff-quote";
import { Hint } from "./Hint";

/** The most a follow-up's own words hold, as the orchestrator takes them. */
const MOST_TEXT = 8_000;

const MODE: Record<NonNullable<TaskRecord["followUp"]>, { label: string; note: string; send: string }> = {
  steer: { label: "Tell the agent while it works", note: "It reaches the agent now, in the middle of its work.", send: "Send" },
  queue: { label: "Message for the agent", note: "It waits until the agent's current step ends, then reaches it.", send: "Queue message" },
  continue: { label: "Continue with a follow-up", note: "A new run starts on the request's branch with your words, and the request gets its new changes.", send: "Start the next run" },
};

/** Quotes one follow-up carries at most, as the orchestrator takes them. */
export const MOST_QUOTES = 20;

/** Two quotes of the same lines of the same file are one, and a follow-up holds no more than it can send. */
export function addQuote(quotes: Quote[], quote: Quote): Quote[] {
  return quotes.length >= MOST_QUOTES || quotes.some((q) => q.path === quote.path && q.lines === quote.lines) ? quotes : [...quotes, quote];
}

/** What a box sends: words for the agent, or (`suggest`) a teammate's follow-up kept for the person who started the task. */
export type FollowUpMode = NonNullable<TaskRecord["followUp"]> | "suggest";

/**
 * Words for the agent from the person who started the task, with any lines of its request quoted
 * as data beside them, or a teammate's suggestion of them. Shown only while the orchestrator takes
 * one, and never sent twice: a retry after a lost answer carries the same command.
 */
export function TaskFollowUp({ task, kind, jump = null, stop = null, suggestTo = "", quotes, onQuotes, onSent }: { task: TaskRecord; jump?: ReactNode; stop?: ReactNode; kind: FollowUpMode; suggestTo?: string; quotes: Quote[]; onQuotes: (next: Quote[]) => void; onSent: () => void }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [commandId, setCommandId] = useState(() => crypto.randomUUID());
  const suggesting = kind === "suggest";
  // A teammate's words go to the starter first, who passes them on to the agent or not; the server takes no suggestion without words.
  const mode = suggesting
    ? { label: `Suggest a follow-up to ${suggestTo}`, note: `${suggestTo} reads it first; the agent gets it only if they continue with it.`, send: "Suggest" }
    : MODE[kind];
  const ready = suggesting ? Boolean(text.trim()) : Boolean(text.trim() || quotes.length);
  const send = (e: React.FormEvent) => {
    e.preventDefault();
    if (!ready) return;
    setBusy(true);
    setError(null);
    (suggesting ? tasksApi.suggest(task.id, { text: text.trim(), quotes }, commandId) : tasksApi.message(task.id, { text: text.trim(), quotes }, commandId)).then(() => {
      setText("");
      onQuotes([]);
      setCommandId(crypto.randomUUID());
      onSent();
    }, (err: Error) => {
      setError(err.message);
      // The task moved on and takes no follow-up now: its page reads where it stands.
      if (err instanceof ApiError && (err.code === "follow-up-not-offered" || err.code === "use-messages")) onSent();
    }).finally(() => setBusy(false));
  };
  // While the agent works the box is one line at the run's foot: Enter sends, Shift+Enter starts a new line.
  if (kind === "steer" || kind === "queue") {
    return (
      <form className="run-steer" onSubmit={send} aria-label={mode.label}>
        {jump}
        <textarea
          dir="auto"
          aria-label="Tell the agent something while it works"
          placeholder="Tell the agent something while it works"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing) return;
            e.preventDefault();
            e.currentTarget.form?.requestSubmit();
          }}
          rows={1}
          maxLength={MOST_TEXT}
        />
        <button type="submit" className={text.trim() ? undefined : "secondary"} disabled={busy || !text.trim()}>{mode.send}</button>
        {stop}
        <Hint label="what you tell the agent">{mode.note}</Hint>
        {error ? <p className="error" role="alert">{error}</p> : null}
      </form>
    );
  }
  return (
    <section className="panel" aria-labelledby="follow-up-h">
      <h2 id="follow-up-h">{mode.label}</h2>
      <form className="form" onSubmit={send} aria-labelledby="follow-up-h">
        {quotes.length ? (
          <ul className="plain chips" aria-label="Quoted lines">
            {quotes.map((q) => (
              <li key={`${q.path}:${q.lines}`} className="chip-pick on">
                <span className="mono">{q.path}:{q.lines}</span>{" "}
                <button type="button" className="ghost small" aria-label={`Leave out ${q.path} lines ${q.lines}`} onClick={() => onQuotes(quotes.filter((x) => x !== q))}>×</button>
              </li>
            ))}
          </ul>
        ) : null}
        <label>
          What the agent should do
          <textarea dir="auto" value={text} onChange={(e) => setText(e.target.value)} rows={3} maxLength={MOST_TEXT} />
        </label>
        <p className="muted small">{mode.note}{quotes.length >= MOST_QUOTES ? ` A follow-up holds ${MOST_QUOTES} quotes; send these before quoting more.` : quotes.length ? " Quoted lines go to the agent as they are in the request." : null}{quotes.length ? null : <> <Hint label="quoting lines">Select lines in the request's changes to quote them.</Hint></>}</p>
        <div className="actions">
          <button type="submit" className="secondary" disabled={busy || !ready}>{mode.send}</button>
        </div>
        {error ? <p className="error" role="alert">{error}</p> : null}
      </form>
    </section>
  );
}
