import { useState } from "react";
import { ApiError, tasksApi } from "./api";
import type { Principal, RequestDecision, TaskRecord, TaskRequest } from "./api";
import { answerLine, answerReady, emptyAnswers, OTHER_MAX, pick, write } from "./questions";
import type { AgentQuestion, QuestionAnswers } from "./questions";
import { here } from "./router";
import { PlanCard } from "./TaskPlan";

/** The kinds a person decides on; a question has its own card, and a secret none until the runner asks one. */
const KIND: Partial<Record<TaskRequest["kind"], string>> = {
  command: "run a command",
  "file-read": "read a file",
  "file-change": "change a file",
  mcp: "use an MCP tool",
  permission: "use a tool",
  plan: "start with a plan",
};

const ANSWER: Record<RequestDecision, string> = { allow_once: "allowed once", allow_for_task: "allowed for this task", deny: "denied" };

function Card({ task, request, mine, onAnswered }: { task: TaskRecord; request: TaskRequest; mine: boolean; onAnswered: () => void }) {
  const [note, setNote] = useState("");
  const [denying, setDenying] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const answer = (decision: RequestDecision) => {
    setBusy(true);
    setError(null);
    tasksApi.answer(task.id, request.id, decision, note.trim() || undefined).then(onAnswered, (e: Error) => {
      setError(e.message);
      setBusy(false);
      // Someone answered first: the card reads the answer that won.
      if (e instanceof ApiError && e.status === 409) onAnswered();
    });
  };
  const pending = waiting(request);
  const what = [request.payload.tool, request.payload.summary].filter(Boolean).join(": ");
  return (
    <li className={`approval${pending ? " pending" : ""}`} aria-label={`The agent asks to ${KIND[request.kind]}`}>
      <p><strong>The agent asks to {KIND[request.kind]}</strong></p>
      {what ? <pre className="pre mono">{what}</pre> : null}
      {request.status === "answered" && request.answer ? (
        "decision" in request.answer ? <p className="muted small">{request.answeredBy ?? "Its starter"} {ANSWER[request.answer.decision]}{request.answer.note ? `: ${request.answer.note}` : ""}.</p> : null
      ) : request.status === "withdrawn" ? (
        <p className="muted small">The agent took this back; it needs no answer.</p>
      ) : !pending ? (
        <p className="muted small">The agent stopped before this was answered.</p>
      ) : !mine ? (
        <p className="muted small">Waiting for the person who started this task to answer.</p>
      ) : denying ? (
        <div className="form">
          <label>A note for the agent (optional)<textarea className="short" value={note} onChange={(e) => setNote(e.target.value)} rows={2} maxLength={2000} /></label>
          <div className="actions">
            <button type="button" disabled={busy} onClick={() => answer("deny")}>Deny</button>
            <button type="button" className="secondary" onClick={() => setDenying(false)}>Don't deny</button>
          </div>
        </div>
      ) : (
        <div className="actions">
          <button type="button" disabled={busy} onClick={() => answer("allow_once")}>Allow once</button>
          <button type="button" className="secondary" disabled={busy} onClick={() => answer("allow_for_task")}>Allow for this task</button>
          <button type="button" className="secondary" disabled={busy} onClick={() => setDenying(true)}>Deny…</button>
        </div>
      )}
      {error ? <p className="error" role="alert">{error}</p> : null}
    </li>
  );
}

const SECRET_LIKE = "Not sent: part of it looks like a password or key. Write it without that, then send.";

/**
 * The agent's questions, answered whole by the person who started the task: a choice, several,
 * or their own words for each, sent together, or turned down with a note. The questions are the
 * agent's own words, shown as plain text.
 */
function QuestionCard({ task, request, mine, agent, onAnswered }: { task: TaskRecord; request: TaskRequest; mine: boolean; agent: string; onAnswered: () => void }) {
  const questions: AgentQuestion[] = Array.isArray(request.payload.questions) ? request.payload.questions : [];
  const [answers, setAnswers] = useState<QuestionAnswers>(() => emptyAnswers(questions));
  const [declining, setDeclining] = useState(false);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = waiting(request);
  const who = agent || "The agent";
  const failed = (e: Error) => {
    setError(e instanceof ApiError && e.code === "answer-looks-secret" ? SECRET_LIKE : e.message);
    setBusy(false);
    if (e instanceof ApiError && e.status === 409) onAnswered();
  };
  const send = (e: React.FormEvent) => {
    e.preventDefault();
    if (!answerReady(questions, answers)) return;
    setBusy(true);
    setError(null);
    const sent = Object.fromEntries(Object.entries(answers).map(([key, a]) => [key, { chosen: a.chosen, other: a.other?.trim() || null }]));
    tasksApi.answerQuestions(task.id, request.id, sent).then(onAnswered, failed);
  };
  const decline = () => {
    setBusy(true);
    setError(null);
    tasksApi.answer(task.id, request.id, "deny", note.trim() || undefined).then(onAnswered, failed);
  };
  // Keys 1 to 9 pick an option of the question in focus, unless the person is typing their own words.
  const keys = (question: AgentQuestion) => (e: React.KeyboardEvent) => {
    if (e.target instanceof HTMLTextAreaElement || !/^[1-9]$/.test(e.key)) return;
    const option = question.options?.[Number(e.key) - 1];
    if (!option) return;
    e.preventDefault();
    setAnswers(pick(answers, question, option.value));
  };
  const answer = request.answer;
  return (
    <li className={`approval${pending ? " pending" : ""}`} aria-label={`${who} asks you`}>
      {!questions.length ? (
        <p className="muted small">The agent asked something this page cannot show.</p>
      ) : request.status === "answered" && answer ? (
        "answers" in answer ? (
          <dl className="facts">
            {questions.map((q) => <div key={q.key}><dt dir="auto">{q.title}</dt><dd dir="auto">{answerLine(q, answer.answers[q.key])}</dd></div>)}
            <div><dt>Answered by</dt><dd>{request.answeredBy ?? "its starter"}</dd></div>
          </dl>
        ) : <p className="muted small">{request.answeredBy ?? "Its starter"} did not answer{answer.note ? `: ${answer.note}` : ""}.</p>
      ) : request.status === "withdrawn" ? (
        <p className="muted small">The agent took this back; it needs no answer.</p>
      ) : !pending ? (
        <p className="muted small">The agent stopped before this was answered.</p>
      ) : !mine ? (
        <>
          {questions.map((q) => <p key={q.key} dir="auto">{q.title}</p>)}
          <p className="muted small">Waiting for the person who started this task to answer.</p>
        </>
      ) : declining ? (
        <div className="form">
          <label>A note for the agent (optional)<textarea className="short" value={note} onChange={(e) => setNote(e.target.value)} rows={2} maxLength={2000} /></label>
          <div className="actions">
            <button type="button" disabled={busy} onClick={decline}>Don't answer</button>
            <button type="button" className="secondary" onClick={() => setDeclining(false)}>Back to the question</button>
          </div>
        </div>
      ) : (
        <form className={`form${questions.length > 1 ? " questions" : ""}`} onSubmit={send} aria-label={`Answer ${who}`}>
          {questions.map((q) => (
            <fieldset key={q.key} className="plain-fieldset question" onKeyDown={keys(q)}>
              <legend dir="auto">{q.title}</legend>
              {q.description ? <p className="muted small" dir="auto">{q.description}</p> : null}
              {(q.options ?? []).map((o, i) => (
                <label key={o.value} className="check">
                  <input type={q.choice === "many" ? "checkbox" : "radio"} name={`${request.id}-${q.key}`} checked={answers[q.key]?.chosen.includes(o.value) ?? false} onChange={() => setAnswers(pick(answers, q, o.value))} />
                  <span>
                    <span dir="auto">{o.label}</span>{i < 9 ? <> <kbd aria-label={`key ${i + 1}`}>{i + 1}</kbd></> : null}
                    {o.description ? <span className="muted small" dir="auto"> {o.description}</span> : null}
                  </span>
                </label>
              ))}
              {q.choice === "text" || q.other ? (
                <label>
                  {q.choice === "text" ? "Your answer" : "Something else"}
                  <textarea dir="auto" className="short" rows={2} maxLength={OTHER_MAX} value={answers[q.key]?.other ?? ""} onChange={(e) => setAnswers(write(answers, q, e.target.value))} />
                </label>
              ) : null}
            </fieldset>
          ))}
          <div className="actions">
            <button type="submit" disabled={busy || !answerReady(questions, answers)}>Send the answers</button>
            <button type="button" className="secondary" disabled={busy} onClick={() => setDeclining(true)}>Don't answer…</button>
          </div>
        </form>
      )}
      {error ? <p className="error" role="alert">{error}</p> : null}
    </li>
  );
}

const waiting = (r: TaskRequest) => r.status === "pending" && r.responseCapability === "live";

/** Whether the agent stands on a card for its answer now; the card is then the one thing to do on the page. */
export function asksNow(task: Pick<TaskRecord, "requests">): boolean {
  return (task.requests ?? []).some(waiting);
}

/** The newest first, with what still waits on an answer ahead of everything already settled. */
export function waitingFirst(asked: TaskRequest[]): TaskRequest[] {
  return [...asked].reverse().sort((a, b) => Number(waiting(b)) - Number(waiting(a)));
}

/**
 * What the agent asked while it ran, each as a card: the person who started the task answers it
 * here, from this browser alone, and everyone else who can see the task reads who it waits on.
 */
export function TaskRequests({ task, me, agent, onAnswered }: { task: TaskRecord; me: { email: string }; agent: string; onAnswered: () => void }) {
  const asked = (task.requests ?? []).filter((r) => KIND[r.kind] || r.kind === "question");
  if (!asked.length) return null;
  const mine = task.createdBy === me.email;
  const open = asked.filter(waiting).length;
  return (
    <section className="section" aria-labelledby="task-requests-h">
      <h2 id="task-requests-h">{agent || "The agent"} asks you <span className="count">{open ? `${open} waiting` : asked.length}</span></h2>
      <ul className="plain approvals">
        {waitingFirst(asked).map((r) => (r.kind === "plan" ? <PlanCard key={r.id} task={task} request={r} mine={mine} onAnswered={onAnswered} /> : r.kind === "question" ? <QuestionCard key={r.id} task={task} request={r} mine={mine} agent={agent} onAnswered={onAnswered} /> : <Card key={r.id} task={task} request={r} mine={mine} onAnswered={onAnswered} />))}
      </ul>
    </section>
  );
}

const DAY_MS = 86_400_000;

/**
 * A task held at its plan's usage limit, in the person's own time: one that resets within a day
 * goes on by itself then, and one further off waits for the person, since its branch and context
 * would be old by then.
 */
export function limitLine(resetAt: string | null, now = new Date()): string {
  if (!resetAt) return "Your plan's usage limit is reached; continue the task once it resets.";
  const at = new Date(resetAt);
  const clock = at.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  if (at.getTime() - now.getTime() > DAY_MS) return `Your plan's usage limit is reached until ${at.toLocaleDateString(undefined, { month: "short", day: "numeric" })} at ${clock}; continue the task then.`;
  return `Your plan's usage limit is reached; the task goes on by itself at ${clock}${at.toDateString() === now.toDateString() ? "" : " tomorrow"}.`;
}

/**
 * A task that waits for its starter's machine, in one sentence and the one place that moves it:
 * connecting a machine, or seeing why the connected one is not answering. One person's own
 * orchestrator runs every task where it is, so it never waits for a machine there.
 */
export function machineWait(task: Pick<TaskRecord, "waitingFor">, me: Pick<Principal, "mode">): { badge: string; line: string; link: string } | null {
  if (me.mode === "local") return null;
  if (task.waitingFor === "connect") return { badge: "waiting for your machine", line: "This task waits for your machine: none of yours is connected yet.", link: "Connect your machine" };
  if (task.waitingFor === "machine") return { badge: "waiting for your machine", line: "This task waits for your machine to come online.", link: "Your machines" };
  return null;
}

/**
 * Why a task on a person's machine is not running and the one thing that moves it: connecting a
 * machine, the machine coming online, a limit resetting, or signing in to the agent there.
 */
export function WaitingNote({ task, me, onContinued }: { task: TaskRecord; me: Principal; onContinued: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const go = () => {
    setBusy(true);
    setError(null);
    tasksApi.continue(task.id).then(onContinued, (e: Error) => {
      setError(e.message);
      setBusy(false);
    });
  };
  const machines = <a href={here("settings", "machines")}>Your machines</a>;
  const wait = machineWait(task, me);
  // On one's own machine the agent's sign-in command is on Agent readiness; there are no machines to list.
  const signIn = me.mode === "local" ? <a href={here("settings", "agents")}>Agent readiness</a> : machines;
  const resume = task.status === "interrupted" && task.createdBy === me.email ? <button type="button" disabled={busy} onClick={go}>Pick up where it stopped</button> : null;
  const line =
    wait ? <>{wait.line} <a href={here("settings", "machines")}>{wait.link}</a></>
      : task.waitingFor === "connect" || task.waitingFor === "machine" ? null
        : task.waitingFor === "limit" ? <>{limitLine(task.resetAt ?? null)}</>
          : task.waitingFor === "sign-in" ? <>The agent on your machine is signed out. Sign in there ({signIn} has the command), then continue.</>
            : task.status === "interrupted" ? <>{task.interruptedBy === "restart" ? "Stopped when the orchestrator restarted." : "Stopped when your machine went away."}</>
              : null;
  if (!line) return null;
  return (
    <div className="waiting" role="status">
      <p>{line}</p>
      {resume}
      {error ? <p className="error" role="alert">{error}</p> : null}
    </div>
  );
}
