import { useState } from "react";
import type { ReactNode } from "react";
import { ChangeCounts } from "./ChangeCounts";
import { ChangeWeight } from "./design/ChangeWeight";
import { DiffPatch } from "./design/DiffPatch";
import { commandLine, OUTPUT_KEPT, toolResult, toolSaid, writtenDocument } from "./live-run";
import type { CallStatus, LiveRun as Run, PlanStep, ToolLine } from "./live-run";
import { Markdown } from "./Markdown";

const clock = (at: string) => new Date(at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

const lines = (n: number) => `${n.toLocaleString("en-US")} ${n === 1 ? "line" : "lines"}`;

const MARK: Record<CallStatus, string> = { started: "running", done: "done", failed: "failed", refused: "refused" };

/** Why a refused call was refused, said in its fold. */
const REFUSED = "This task does not allow this tool.";

/**
 * One call, or calls of one kind in a row, as one line under the agent's words: its mark, what it
 * did and to what, and its result in its tone. The line is a closed fold holding what it did: the
 * output, the patch, each joined call, why it was refused, and the tool's own name.
 */
function ToolRow({ line, current }: { line: ToolLine; current: boolean }) {
  const { before, target, after } = toolSaid(line);
  const result = toolResult(line);
  const [all, setAll] = useState(false);
  const read = line.calls.every((c) => c.tool === "Read");
  const shown = all ? line.output : line.output.slice(-OUTPUT_KEPT);
  const document = writtenDocument(line);
  return (
    <li className="run-line" data-kind="tool" data-status={MARK[line.status]} {...(current ? { "data-current": "" } : {})}>
      <details>
        <summary>
          <span className="run-mark" data-status={MARK[line.status]} aria-hidden="true" />
          {before}
          {target ? <> <span className="mono" dir="auto">{line.verb === "Ran" ? commandLine(target) : target}</span></> : null}
          {after}
          {line.change ? <> <ChangeWeight added={line.change.additions} removed={line.change.deletions} /> <span className="diff-stat"><ChangeCounts added={line.change.additions} removed={line.change.deletions} /></span></> : null}
          {result ? <> <span className={`state ${result.tone}`}>{result.word}</span></> : null}
        </summary>
        {read && line.outputTotal ? <p className="muted small">{lines(line.outputTotal)}{line.calls.length === 1 && line.calls[0]!.target ? <> of <span className="mono" dir="auto">{line.calls[0]!.target}</span></> : null}</p> : null}
        {line.output.length ? <pre className={`pre mono${all ? " run-output-all" : ""}`}>{shown.join("\n")}</pre> : null}
        {line.outputTotal > OUTPUT_KEPT && !read ? <button type="button" className="link small" aria-expanded={all} onClick={() => setAll(!all)}>{all ? "Show the last lines" : `Show all ${lines(line.outputTotal)}`}</button> : null}
        {document !== null ? <div className="plan-text" dir="auto"><Markdown text={document} /></div> : line.change?.patch ? <DiffPatch patch={line.change.patch} /> : null}
        {line.status === "refused" ? <p className="muted small">{line.calls[0]?.reason ?? REFUSED}</p> : null}
        <ul className="plain muted small">
          {line.calls.map((c, i) => <li key={i}><span className="mono" dir="auto">{c.tool}</span>{c.target ? <> <span className="mono run-command" dir="auto">{c.target}</span></> : null}</li>)}
        </ul>
      </details>
    </li>
  );
}

// Past this many steps the plan shows the one in progress and folds the rest behind "N more"; on a phone it folds past one.
const PLAN_SHOWN = 5;

/**
 * A running task's plan under its head: one line a step, each marked, changing in place. A long one
 * shows the step in progress, or the first not done, and opens the rest on asking.
 */
export function RunPlan({ plan }: { plan: PlanStep[] }) {
  const [open, setOpen] = useState(false);
  const doing = plan.findIndex((s) => s.state === "doing");
  const next = plan.findIndex((s) => s.state !== "done");
  const at = doing >= 0 ? doing : next >= 0 ? next : plan.length - 1;
  const long = plan.length > PLAN_SHOWN;
  return (
    <>
      <ol className="run-plan" aria-label="The agent's plan" {...(long ? { "data-long": "" } : {})} {...(open ? { "data-open": "" } : {})}>
        {plan.map((step, i) => <li key={i} data-state={step.state} dir="auto" {...(i === at ? { "data-at": "" } : {})}>{step.text}</li>)}
      </ol>
      {plan.length > 1 ? (
        <button type="button" className="link small run-plan-more" aria-expanded={open} onClick={() => setOpen(!open)} {...(long ? { "data-long": "" } : {})}>
          {open ? "Show less" : `${plan.length - 1} more`}
        </button>
      ) : null}
    </>
  );
}

/**
 * A run as the agent works it: its plan with each step marked, unless the page holds the plan
 * elsewhere, then where it works when the page says so, then its words and, under them, its calls
 * in order. The newest running call is the current step; between calls, while the agent
 * works, "Thinking…" stands in its place. Every word comes from the orchestrator already masked,
 * and is drawn as text, never as markup.
 */
export function LiveRun({ run, working = false, withPlan = true, first = null }: { run: Run; working?: boolean; withPlan?: boolean; first?: ReactNode }) {
  const last = run.stream.at(-1);
  const running = working && last?.kind === "tool" && last.status === "started" ? last.key : null;
  return (
    <>
      {withPlan && run.plan.length ? (
        <ol className="run-plan" aria-label="The agent's plan">
          {run.plan.map((step, i) => <li key={i} data-state={step.state} dir="auto">{step.text}</li>)}
        </ol>
      ) : null}
      <ol className="run-stream" aria-label="What the agent did">
        {first}
        {run.stream.map((line) =>
          line.kind === "tool" ? <ToolRow key={line.key} line={line} current={line.key === running} />
            : line.kind === "time" ? <li key={line.key} className="run-line" data-kind="time"><time dateTime={line.at}>{clock(line.at)}</time></li>
              : line.kind === "you" ? <li key={line.key} className="run-line" data-kind="you" dir="auto"><strong>{line.by ?? "You"}</strong> {line.text}</li>
              : line.kind === "say" ? <li key={line.key} className="run-line" data-kind="say"><Markdown text={line.text} /></li>
              : <li key={line.key} className="run-line" data-kind={line.kind} dir="auto">{line.text}</li>,
        )}
        {working && !running ? <li className="run-line" data-kind="now">Thinking…</li> : null}
      </ol>
    </>
  );
}
