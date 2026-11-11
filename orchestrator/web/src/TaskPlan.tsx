import { useRef, useState } from "react";
import { ApiError, tasksApi } from "./api";
import type { TaskRecord, TaskRequest } from "./api";
import { CopyButton } from "./Confirm";
import { Markdown } from "./Markdown";

const PLAN_MAX = 20_000;

/** How many steps a plan lists: its numbered or bulleted lines. */
export function planSteps(plan: string): number {
  return plan.split("\n").filter((line) => /^\s*(\d+[.)]|[-*])\s+\S/.test(line)).length;
}

/**
 * The plan the agent made before it changed anything, as it wrote it: read, started with, changed in
 * place or declined. Nothing is saved or opened anywhere for the person; Copy is how a plan is kept.
 */
export function PlanCard({ task, request, mine, onAnswered }: { task: TaskRecord; request: TaskRequest; mine: boolean; onAnswered: () => void }) {
  const plan = request.payload.plan ?? "";
  const [changing, setChanging] = useState(false);
  const [text, setText] = useState(plan);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const shown = useRef<HTMLDivElement>(null);
  const pending = request.status === "pending" && request.responseCapability === "live";
  const send = (decision: "allow_once" | "deny", edited?: string) => {
    setBusy(true);
    setError(null);
    tasksApi.answerPlan(task.id, request.id, decision, edited).then(onAnswered, (e: Error) => {
      setError(e.message);
      setBusy(false);
      if (e instanceof ApiError && e.status === 409) onAnswered();
    });
  };
  const steps = planSteps(plan);
  const answered = request.status === "answered" && request.answer && "decision" in request.answer ? request.answer.decision : null;
  return (
    <li className={`approval plan${pending ? " pending" : ""}`} aria-label="The agent's plan">
      {answered === "deny" ? <p className="muted small">{request.answeredBy ?? "Its starter"} declined the plan; nothing changed.</p>
        : answered ? <p className="muted small">{request.answeredBy === null || mine ? "You" : request.answeredBy} started with the plan{steps ? `, ${steps} ${steps === 1 ? "step" : "steps"}` : ""}.</p>
          : (
            <>
              <p><strong>The agent made a plan before it changes anything</strong></p>
              {changing ? (
                <label>
                  The plan
                  <textarea dir="auto" rows={12} maxLength={PLAN_MAX} value={text} onChange={(e) => setText(e.target.value)} disabled={busy} />
                </label>
              ) : <div ref={shown} className="plan-text" dir="auto"><Markdown text={plan} /></div>}
              {request.status === "withdrawn" ? <p className="muted small">The agent took this back; it needs no answer.</p>
                : !pending ? <p className="muted small">The agent stopped before this was answered.</p>
                  : !mine ? <p className="muted small">Waiting for the person who started this task to answer.</p>
                    : (
                      <div className="actions">
                        <button type="button" disabled={busy || !text.trim()} onClick={() => send("allow_once", changing && text.trim() !== plan.trim() ? text.trim() : undefined)}>Start with this plan</button>
                        {changing
                          ? <button type="button" className="secondary" disabled={busy} onClick={() => { setChanging(false); setText(plan); }}>Keep the agent's plan</button>
                          : <button type="button" className="secondary" disabled={busy} onClick={() => setChanging(true)}>Change the plan</button>}
                        <CopyButton text={changing ? text : plan} target={shown} label="Copy the plan" small={false} />
                      </div>
                    )}
            </>
          )}
      {error ? <p className="error" role="alert">{error}</p> : null}
    </li>
  );
}
