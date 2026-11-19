import { useEffect, useState } from "react";
import { Markdown } from "../Markdown";
import { Select } from "../Select";
import { here } from "../router";
import { Loading } from "../Status";
import { TurnSection } from "../design/TurnSection";
import { decidedOf, lessonsReview, PAGE, refusedSaid, skillText, stillThere, toggled } from "./lessons-review";
import type { ReviewRow, ReviewTarget, Settled, useLessonsReview } from "./lessons-review";

const TARGETS = [
  { value: "yours", label: "Yours" },
  { value: "folder", label: "This folder" },
  { value: "team", label: "Team" },
];

const day = (iso: string) => iso.slice(0, 10);

type Review = ReturnType<typeof useLessonsReview>;

/**
 * Every lesson waiting for the person in one list, whether a task or one of their own sessions taught it: its title, where it
 * came from, when, and its first line. A row opens in the rail; the boxes pick any number for one Keep or Reject, and a kept
 * lesson lands in the one place picked. Only the first page is drawn until "Show more".
 */
export function LessonsReview({ review, picked, onPick }: { review: Review; picked: string | null; onPick: (row: ReviewRow) => void }) {
  const { rows, waiting, hasMore, more, settled } = review;
  const [shown, setShown] = useState(PAGE);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [target, setTarget] = useState<ReviewTarget>("yours");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [wording, setWording] = useState<{ slugs: string[]; message: string } | null>(null);
  useEffect(() => {
    if (rows) setSelected((now) => stillThere(now, rows));
  }, [rows]);
  if (!rows) return null;
  if (!rows.length) return null;
  const done = (r: Settled) => {
    settled(r);
    setProblem(refusedSaid(r.results));
    const asked = r.results.find((x) => !x.ok && x.proposedMessage);
    setWording(asked ? { slugs: r.results.filter((x) => !x.ok && x.proposedMessage).map((x) => x.slug), message: asked.proposedMessage! } : null);
  };
  const act = (run: Promise<Settled>) => {
    setBusy(true);
    setProblem(null);
    setWording(null);
    run.then(done, (e: Error) => setProblem(e.message)).finally(() => setBusy(false));
  };
  const drawn = rows.slice(0, shown);
  const hidden = rows.length - drawn.length;
  return (
    <TurnSection name="Lessons to review" count={waiting ?? rows.length} why="What a task or a session taught, offered as a skill; keep it and every later task loads it." empty="No lesson waits. A task you correct or finish leaves its lesson here.">
      {selected.size ? (
        <div className="lessons-bulk" role="group" aria-label="Decide the picked lessons">
          <span>{selected.size} picked</span>
          <Select label="Keep in" labelHidden value={target} onChange={(v) => setTarget(v as ReviewTarget)} options={TARGETS} disabled={busy} />
          <button type="button" disabled={busy} onClick={() => act(lessonsReview.keep([...selected], target))}>Keep</button>
          <button type="button" className="secondary" disabled={busy} onClick={() => act(lessonsReview.reject([...selected]))}>Reject</button>
          <button type="button" className="link" disabled={busy} onClick={() => setSelected(new Set())}>Clear</button>
        </div>
      ) : null}
      {problem ? <p className="error" role="alert">{problem}</p> : null}
      {wording ? (
        <div className="lessons-bulk" role="group" aria-label="Commit wording for the team">
          <label>Commit message <input type="text" value={wording.message} onChange={(e) => setWording({ ...wording, message: e.target.value })} /></label>
          <button type="button" disabled={busy || !wording.message.trim()} onClick={() => act(lessonsReview.keep(wording.slugs, "team", wording.message.trim()))}>Keep for the team</button>
        </div>
      ) : null}
      <ul className="team-rows lessons-rows">
        {drawn.map((r) => (
          <li key={r.slug} className={r.slug === picked ? "picked" : undefined}>
            <input type="checkbox" aria-label={`Pick ${r.slug}`} checked={selected.has(r.slug)} onChange={() => setSelected(toggled(selected, r.slug))} />
            <div className="lesson-text">
              <button type="button" className="row-pick" aria-pressed={r.slug === picked} onClick={() => onPick(r)} dir="auto">{r.firstLine ?? r.slug}</button>
              <p className="muted small">{r.taskId ? <a href={here("tasks", r.taskId)}>{r.source.label}</a> : r.source.label}, {day(r.createdAt)}</p>
            </div>
          </li>
        ))}
      </ul>
      {hidden > 0 || hasMore ? <p><button type="button" className="link small" disabled={busy} onClick={() => (hidden > 0 ? setShown(shown + PAGE) : more().then(() => setShown(shown + PAGE), (e: Error) => setProblem(e.message)))}>Show more{waiting !== null ? ` (${waiting - drawn.length})` : ""}</button></p> : null}
    </TurnSection>
  );
}

/** The picked lesson in the rail: where it came from, the skill's text, and the decision with its one landing place. */
export function LessonRail({ row, onDecided }: { row: ReviewRow; onDecided: (r: Settled) => void }) {
  const [detail, setDetail] = useState<Awaited<ReturnType<typeof lessonsReview.read>> | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [never, setNever] = useState(false);
  const [target, setTarget] = useState<ReviewTarget>("yours");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setDetail(null);
    setFailed(null);
    lessonsReview.read(row.slug).then(setDetail, (e: Error) => setFailed(e.message));
  }, [row.slug]);
  const act = (run: Promise<Settled>) => {
    setBusy(true);
    setFailed(null);
    run.then((r) => (decidedOf(r.results).length ? onDecided(r) : setFailed(refusedSaid(r.results))), (e: Error) => setFailed(e.message)).finally(() => setBusy(false));
  };
  return (
    <section aria-labelledby="lesson-h">
      <h2 id="lesson-h" dir="auto">{row.firstLine ?? row.slug}</h2>
      <p className="muted small">{row.taskId ? <a href={here("tasks", row.taskId)}>{row.source.label}</a> : row.source.label}, {day(row.createdAt)}</p>
      {failed ? <p className="error" role="alert">{failed}</p> : null}
      {!detail ? (failed ? null : <Loading what="the lesson" />) : (
        <>
          {detail.quote ? <p dir="auto">You said: “{detail.quote}”</p> : null}
          <Markdown text={skillText(detail.skillMd)} />
          <div className="actions">
            <Select label="Keep in" value={target} onChange={(v) => setTarget(v as ReviewTarget)} options={TARGETS} disabled={busy} />
            <button type="button" className="secondary" disabled={busy} onClick={() => act(lessonsReview.keep([row.slug], target))}>Keep</button>
            <button type="button" className="secondary" disabled={busy} onClick={() => act(lessonsReview.reject([row.slug], never))}>Reject</button>
          </div>
          <label className="check"><input type="checkbox" checked={never} onChange={(e) => setNever(e.target.checked)} /> Never suggest it again</label>
        </>
      )}
    </section>
  );
}
