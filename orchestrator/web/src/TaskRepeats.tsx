import { useEffect, useState } from "react";
import { tasksApi } from "./api";
import type { TaskRepeat, TaskRepeatEvery } from "./api";
import { ConfirmAction } from "./Confirm";
import { TurnSection } from "./design/TurnSection";

/** Fired when a repeat is made, so the list of repeats on the page reads them again. */
export const REPEATS_CHANGED = "orchestrator:repeats";

export const REPEAT_DAYS: TaskRepeatEvery[] = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];

const DAY_NAME: Record<TaskRepeatEvery, string> = { day: "day", weekday: "weekday", monday: "Monday", tuesday: "Tuesday", wednesday: "Wednesday", thursday: "Thursday", friday: "Friday", saturday: "Saturday", sunday: "Sunday" };

/** "9:00": the hour without a leading zero, as the page says a time of day. */
export const timeSaid = (at: string) => at.replace(/^0/, "");

/** "every weekday at 9:00". */
export const repeatSaid = (every: TaskRepeatEvery, at: string) => `every ${DAY_NAME[every]} at ${timeSaid(at)}`;

export const repeatWhen = (iso: string) => {
  const date = new Date(iso);
  return `${date.toLocaleDateString(undefined, { weekday: "short" })} ${timeSaid(date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }))}`;
};

/** The tasks that start by themselves, each with its next run and the run it skipped; nothing is drawn when there are none. */
export function TaskRepeats() {
  const [repeats, setRepeats] = useState<TaskRepeat[]>([]);
  const read = () => {
    tasksApi.repeats().then(setRepeats, () => undefined);
  };
  useEffect(() => {
    read();
    window.addEventListener(REPEATS_CHANGED, read);
    return () => window.removeEventListener(REPEATS_CHANGED, read);
  }, []);
  if (!repeats.length) return null;
  return (
    <TurnSection name="Repeats" count={repeats.length} why="Each starts by itself; every run is an ordinary task in the list." empty="">
      <ul className="plain repeats">
        {repeats.map((r) => (
          <li key={r.id}>
            <p><strong dir="auto">{r.title}</strong> <span className="muted">{repeatSaid(r.every, r.at)}, next {repeatWhen(r.next)}</span></p>
            {r.skipped ? <p className="muted small">Skipped {repeatWhen(r.skipped.at)}: {r.skipped.reason}.</p> : null}
            <ConfirmAction small trigger="Stop repeating…" triggerLabel={`Stop repeating ${r.title}`} consequence="It stops starting by itself; the tasks it already ran stay in the list." confirm="Stop repeating" keep="Keep repeating" onConfirm={() => tasksApi.stopRepeat(r.id).then(read)} />
          </li>
        ))}
      </ul>
    </TurnSection>
  );
}
