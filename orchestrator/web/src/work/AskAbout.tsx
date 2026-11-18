import { useEffect, useId, useState } from "react";
import { tasksApi } from "../api";
import { here } from "../router";
import { whenShort } from "../task-board";
import type { WorkItem } from "./api";

export const FIRST_QUESTION = "How big is this, and which files would it touch?";

/** Where the latest question about an issue was answered, as a card's last line and the rail say it. */
export function AskedLine({ asked }: { asked: NonNullable<WorkItem["asked"]> }) {
  return <a href={here("tasks", asked.taskId)}>{askedSaid(asked.at)}</a>;
}

/** The lines of an answer the rail shows, and the characters each may take. */
const ANSWER_LINES = 2;
const ANSWER_LINE_AT_MOST = 160;

/** A line of Markdown as plain words: its heading, list and quote marks, emphasis, code marks and link syntax taken away, a table's bars made spaces. */
export function plain(line: string): string {
  return line
    .replace(/^\s{0,3}(#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)+/, "")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__|\*|_|`)/g, "")
    .replace(/\s*\|\s*/g, "  ")
    .trim();
}

/** The first lines of an agent's answer, plain text, cut: the rest is on its page. */
export function answerLines(said: string): string[] {
  return said.split("\n").filter((l) => !/^\s{0,3}(```|~~~)/.test(l) && !/^\s*\|?\s*:?-{2,}/.test(l)).map((l) => plain(l)).filter(Boolean).slice(0, ANSWER_LINES).map((l) => (l.length > ANSWER_LINE_AT_MOST ? `${l.slice(0, ANSWER_LINE_AT_MOST).trimEnd()}…` : l));
}

/**
 * The answer to the latest question about an issue, in the rail where it was asked: its first lines and a link to the rest.
 * While the agent is still reading, the rail says so and links the task.
 */
export function AskedAnswer({ asked }: { asked: NonNullable<WorkItem["asked"]> }) {
  const [said, setSaid] = useState<string | null | undefined>(undefined);
  const [asking, setAsking] = useState<string | null>(null);
  useEffect(() => {
    let current = true;
    setSaid(undefined);
    tasksApi.get(asked.taskId, 0).then((r) => {
      if (!current) return;
      setSaid(r.task.lastSaid ?? null);
      setAsking(r.task.description || null);
    }, () => current && setSaid(null));
    return () => {
      current = false;
    };
  }, [asked.taskId]);
  const lines = said ? answerLines(said) : [];
  return (
    <section aria-labelledby="asked-answer-h">
      {asking ? <p className="small asked-question" dir="auto"><strong>You asked:</strong> {asking.length > 300 ? `${asking.slice(0, 300).trimEnd()}…` : asking}</p> : null}
      <h2 id="asked-answer-h">The agent's answer, {whenShort(asked.at)}</h2>
      {said === undefined ? <p className="muted small">Reading it…</p> : lines.length ? lines.map((l) => <p key={l} dir="auto">{l}</p>) : <p className="muted small">The agent has not answered yet.</p>}
      <p className="small"><a href={here("tasks", asked.taskId)}>{lines.length ? "Read it" : "Open the question"}</a></p>
    </section>
  );
}

/** "Asked at 10:42" today; on an earlier day "Asked yesterday", "Asked Tue" or "Asked Nov 3", as whenShort says the day. */
export function askedSaid(at: string, now: Date = new Date()): string {
  const when = whenShort(at, now);
  return /^\d/.test(when) ? `Asked at ${when}` : `Asked ${when === "Yesterday" ? "yesterday" : when}`;
}

/**
 * A question about an issue, put to an agent that reads the issue and the folder and changes nothing: the answer is that
 * task's page. The agent and the folder are the ones a plain start would take.
 */
export function AskAbout({ item, local }: { item: WorkItem; local: boolean }) {
  const [open, setOpen] = useState(false);
  const [question, setQuestion] = useState(FIRST_QUESTION);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [started, setStarted] = useState<string | null>(null);
  const id = useId();
  const ask = async () => {
    setBusy(true);
    setProblem(null);
    try {
      const options = await tasksApi.options();
      const agent = options.agents[0]?.id;
      if (!agent) throw new Error("No agent is set up on this orchestrator yet.");
      const repo = (options.repos.find((r) => r.kind === "code") ?? options.repos[0])?.id;
      const folder = local ? (await tasksApi.where({ title: item.summary, description: "", issueUrl: item.url, agent })).folder?.path : null;
      const task = await tasksApi.start({ title: `Question about ${item.key}`, description: question.trim(), issueUrl: item.url, agent, template: null, readOnly: true, ...(folder ? { path: folder } : repo ? { repoId: repo } : {}) });
      setStarted(task.id);
    } catch (err) {
      setProblem((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  if (!open) return <button type="button" className="secondary" onClick={() => setOpen(true)}>Ask about it…</button>;
  return (
    <form className="form" aria-label={`Ask about ${item.key}`} onSubmit={(e) => { e.preventDefault(); void ask(); }}>
      <label>Your question<textarea className="short" value={question} onChange={(e) => setQuestion(e.target.value)} rows={3} maxLength={2000} aria-describedby={id} /></label>
      <p className="muted small" id={id}>It reads; nothing in your folder changes.</p>
      <div className="actions">
        <button type="submit" disabled={busy || !question.trim()}>{busy ? "Asking…" : "Ask"}</button>
        {started ? <a href={here("tasks", started)}>See the answer</a> : null}
      </div>
      {problem ? <p className="error" role="alert">{problem}</p> : null}
    </form>
  );
}
