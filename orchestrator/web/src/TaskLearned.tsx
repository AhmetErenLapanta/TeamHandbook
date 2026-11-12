import { Fragment, useEffect, useState } from "react";
import { call } from "./api";
import { Markdown } from "./Markdown";

// "sent" is a lesson a team's orchestrator handed one of the person's machines: it is decided there.
export interface TaskLessonRow {
  slug: string;
  description: string | null;
  status: "pending" | "approved" | "rejected" | "archived" | "sent";
  createdAt: string;
  taskId: string;
  machine?: string | null;
}

export interface TaskLessons {
  skills: { team: string[]; project: string[]; used?: string[] };
  candidates: TaskLessonRow[] | null;
}

interface LessonDetail extends TaskLessonRow {
  skillMd: string;
  quote: string | null;
}

// The numbers OGRENME-sozlesme.md 1 promises: tasks decided after the lesson was kept against the
// same projects before it, a rate only once a side has `minimum` of them.
export interface OutcomeBucket {
  tasks: number;
  accepted: number;
  acceptedWithoutRevision: number;
  revisionRoundsMedian: number | null;
  rejected: number;
}

export interface SkillOutcomes {
  pivot: string | null;
  minimum: number;
  before: OutcomeBucket;
  with: OutcomeBucket;
}

const one = (task: string, slug: string, rest = "") => `/api/tasks/${encodeURIComponent(task)}/lessons/${encodeURIComponent(slug)}${rest}`;

export const lessonsApi = {
  ofTask: (task: string) => call<TaskLessons>("GET", `/api/tasks/${encodeURIComponent(task)}/lessons`),
  read: (task: string, slug: string) => call<{ lesson: LessonDetail }>("GET", one(task, slug)).then((b) => b.lesson),
  keep: (task: string, slug: string) => call<unknown>("POST", one(task, slug, "/keep")),
  reject: (task: string, slug: string, never: boolean) => call<unknown>("POST", one(task, slug, "/reject"), { never }),
  outcomes: (skill: string) => call<SkillOutcomes>("GET", `/api/skills/${encodeURIComponent(skill)}/outcomes?days=30`),
};

const count = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export function learnedSentence({ skills, candidates }: TaskLessons): string | null {
  const started = [skills.team.length ? count(skills.team.length, "team skill") : "", skills.project.length ? count(skills.project.length, "project skill") : ""].filter(Boolean);
  const lessons = candidates ?? [];
  const waiting = lessons.filter((l) => l.status === "pending").length;
  const kept = lessons.filter((l) => l.status === "approved").length;
  const sent = lessons.filter((l) => l.status === "sent");
  const machines = [...new Set(sent.map((l) => l.machine).filter((m): m is string => !!m))];
  const parts = [
    started.length ? `Started with ${started.join(" and ")}${skills.used?.length ? `, the agent called ${skills.used.length}` : ""}` : skills.used?.length ? `The agent called ${count(skills.used.length, "skill")}` : "",
    waiting ? `${count(waiting, "lesson")} ${waiting === 1 ? "waits" : "wait"} for your review` : "",
    kept ? `${count(kept, "lesson")} kept as your skill${kept === 1 ? "" : "s"}` : "",
    sent.length ? `${count(sent.length, "lesson")} ${sent.length === 1 ? "waits" : "wait"} in your review queue${machines.length === 1 ? ` on ${machines[0]}` : ""}` : "",
  ].filter(Boolean);
  if (!parts.length) return null;
  const sentence = parts.join("; ");
  return `${sentence[0]!.toUpperCase()}${sentence.slice(1)}.`;
}

// A task's review is read within a minute or two of its end, so a page opened at the end looks again
// for that long rather than waiting for a reload.
const LOOK_AGAIN_MS = 20_000;
const LOOK_FOR_MS = 5 * 60_000;

export const skillText = (skillMd: string) => skillMd.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "");

const ofTasks = (n: number, of: number) => `${n} of ${of}`;

export function outcomeWords(o: SkillOutcomes): { phrase: string; facts: { term: string; value: string }[] } | null {
  if (!o.pivot) return null;
  if (o.with.tasks < o.minimum) return { phrase: `${count(o.with.tasks, "task")} decided since, compared from ${o.minimum}`, facts: [] };
  const before = o.before.tasks >= o.minimum;
  const was = (now: string, then: string) => (before ? `${now}; before, ${then}` : now);
  return {
    phrase: `kept without a follow-up in ${ofTasks(o.with.acceptedWithoutRevision, o.with.tasks)} tasks since${before ? `, ${ofTasks(o.before.acceptedWithoutRevision, o.before.tasks)} before` : ""}`,
    facts: [
      { term: "Kept without a follow-up", value: was(ofTasks(o.with.acceptedWithoutRevision, o.with.tasks), ofTasks(o.before.acceptedWithoutRevision, o.before.tasks)) },
      { term: "Follow-ups, median", value: was(String(o.with.revisionRoundsMedian ?? 0), String(o.before.revisionRoundsMedian ?? 0)) },
      { term: "Undone or closed", value: was(ofTasks(o.with.rejected, o.with.tasks), ofTasks(o.before.rejected, o.before.tasks)) },
    ],
  };
}

export function TaskLearned({ task, finishedAt }: { task: string; finishedAt: string | null }) {
  const [read, setRead] = useState<TaskLessons | null>(null);
  const [reads, setReads] = useState(0);
  useEffect(() => {
    let current = true;
    lessonsApi.ofTask(task).then((r) => current && setRead(r), () => current && setRead(null));
    return () => {
      current = false;
    };
  }, [task, reads]);
  const fresh = !!finishedAt && Date.now() - Date.parse(finishedAt) < LOOK_FOR_MS;
  const waitingForOne = fresh && !!read?.candidates && read.candidates.length === 0;
  useEffect(() => {
    if (!waitingForOne) return;
    const timer = setTimeout(() => setReads((n) => n + 1), LOOK_AGAIN_MS);
    return () => clearTimeout(timer);
  }, [waitingForOne, reads]);
  const sentence = read ? learnedSentence(read) : null;
  if (!read || !sentence) return null;
  const shown = (read.candidates ?? []).filter((l) => l.status === "pending" || l.status === "sent" || l.status === "approved");
  return (
    <section aria-labelledby="task-learned-h">
      <h2 id="task-learned-h">Learned</h2>
      <p>{sentence}</p>
      {shown.length ? (
        <ul className="plain">
          {shown.map((l) => (
            <li key={l.slug}>{l.status === "approved" ? <KeptLesson slug={l.slug} /> : <LessonFold task={task} lesson={l} onDecided={() => setReads((n) => n + 1)} />}</li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function KeptLesson({ slug }: { slug: string }) {
  const [words, setWords] = useState<ReturnType<typeof outcomeWords>>(null);
  useEffect(() => {
    let current = true;
    lessonsApi.outcomes(slug).then((o) => current && setWords(outcomeWords(o)), () => current && setWords(null));
    return () => {
      current = false;
    };
  }, [slug]);
  const line = <><span className="mono">{slug}</span> kept as your skill{words ? `; ${words.phrase}` : ""}</>;
  if (!words?.facts.length) return line;
  return (
    <details>
      <summary>{line}</summary>
      <dl>{words.facts.map((f) => <Fragment key={f.term}><dt>{f.term}</dt><dd>{f.value}</dd></Fragment>)}</dl>
    </details>
  );
}

function LessonFold({ task, lesson, onDecided }: { task: string; lesson: TaskLessonRow; onDecided: () => void }) {
  const [detail, setDetail] = useState<LessonDetail | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [never, setNever] = useState(false);
  const [busy, setBusy] = useState(false);
  const open = () => {
    if (detail) return;
    setFailed(null);
    lessonsApi.read(task, lesson.slug).then(setDetail, (e: Error) => setFailed(e.message));
  };
  const decide = (action: Promise<unknown>) => {
    setBusy(true);
    setFailed(null);
    action.then(onDecided, (e: Error) => setFailed(e.message)).finally(() => setBusy(false));
  };
  return (
    <details onToggle={(e) => (e.currentTarget.open ? open() : undefined)}>
      <summary dir="auto">{lesson.description ?? <><span className="mono">{lesson.slug}</span>{lesson.machine ? `, on ${lesson.machine}` : ""}</>}</summary>
      {detail ? (
        <>
          {detail.quote ? <p dir="auto">You said: “{detail.quote}”</p> : null}
          <Markdown text={skillText(detail.skillMd)} />
          <div className="actions">
            <button type="button" className="small" disabled={busy} onClick={() => decide(lessonsApi.keep(task, lesson.slug))}>Keep</button>
            <button type="button" className="secondary small" disabled={busy} onClick={() => decide(lessonsApi.reject(task, lesson.slug, never))}>Reject</button>
            <label className="check"><input type="checkbox" checked={never} onChange={(e) => setNever(e.target.checked)} />Never suggest it again</label>
          </div>
        </>
      ) : failed ? null : (
        <p className="muted small">Loading the lesson…</p>
      )}
      {failed ? <p className="error" role="alert">{failed}</p> : null}
    </details>
  );
}
