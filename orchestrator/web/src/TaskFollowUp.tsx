import { useState } from "react";
import type { ReactNode } from "react";
import { ApiError, tasksApi } from "./api";
import type { QueuedMessage, TaskRecord } from "./api";
import { AGENT_LOG } from "./diff-quote";
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

/** The passages the follow-up carries, each with a way to leave it out. */
function QuoteChips({ quotes, onQuotes }: { quotes: Quote[]; onQuotes: (next: Quote[]) => void }) {
  if (!quotes.length) return null;
  return (
    <ul className="plain chips" aria-label="Quoted lines">
      {quotes.map((q) => (
        <li key={`${q.path}:${q.lines}`} className="chip-pick on">
          <span className="mono">{q.path === AGENT_LOG ? `log ${q.lines}` : `${q.path}:${q.lines}`}</span>{" "}
          <button type="button" className="ghost small" aria-label={`Leave out ${q.path} lines ${q.lines}`} onClick={() => onQuotes(quotes.filter((x) => x !== q))}>×</button>
        </li>
      ))}
    </ul>
  );
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
    : kind === "continue" && task.requestNumber === null
      ? { ...MODE.continue, note: "A new run starts where this one left off, with your words, and its changes join this review." }
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
        <QuoteChips quotes={quotes} onQuotes={onQuotes} />
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
      <form className="form follow-form" onSubmit={send} aria-labelledby="follow-up-h">
        <QuoteChips quotes={quotes} onQuotes={onQuotes} />
        <label>
          What the agent should do
          <textarea className="follow-text" dir="auto" value={text} onChange={(e) => setText(e.target.value)} rows={3} maxLength={MOST_TEXT} />
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

/**
 * The messages to the agent that have not reached it, under the box they were written in: each can
 * be changed or taken back until the agent takes it. Once it has, the page reads it gone from here.
 */
export function QueuedMessages({ task, messages, onChanged }: { task: string; messages: QueuedMessage[]; onChanged: () => void }) {
  const [editing, setEditing] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!messages.length) return null;
  const act = (run: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    run().then(
      () => {
        setEditing(null);
        onChanged();
      },
      (err: Error) => {
        setError(err.message);
        // One that reached the agent meanwhile is no longer here to change.
        if (err instanceof ApiError && err.code === "message-not-waiting") onChanged();
      },
    ).finally(() => setBusy(false));
  };
  return (
    <section className="queued" aria-label="Messages waiting for the agent">
      <p className="muted small">Waiting for the agent's next step:</p>
      <ul className="plain">
        {messages.map((m) => (
          <li key={m.id}>
            {editing === m.id ? (
              <form className="form" onSubmit={(e) => { e.preventDefault(); act(() => tasksApi.editMessage(task, m.id, { text: text.trim(), ...(m.quotes?.length ? { quotes: m.quotes } : {}) })); }}>
                <textarea className="follow-text" dir="auto" aria-label="Change the message" value={text} onChange={(e) => setText(e.target.value)} rows={2} maxLength={MOST_TEXT} />
                <div className="actions">
                  <button type="submit" className="small" disabled={busy || !text.trim()}>Save</button>
                  <button type="button" className="ghost small" onClick={() => setEditing(null)}>Cancel</button>
                </div>
              </form>
            ) : (
              <>
                <span className="pre" dir="auto">{m.text}</span>{m.quotes?.length ? <span className="muted small"> with {m.quotes.length} quoted {m.quotes.length === 1 ? "passage" : "passages"}</span> : null}{" "}
                <button type="button" className="ghost small" disabled={busy} onClick={() => { setEditing(m.id); setText(m.text); }}>Edit</button>
                <button type="button" className="ghost small" disabled={busy} onClick={() => act(() => tasksApi.removeMessage(task, m.id))}>Remove</button>
              </>
            )}
          </li>
        ))}
      </ul>
      {error ? <p className="error" role="alert">{error}</p> : null}
    </section>
  );
}
