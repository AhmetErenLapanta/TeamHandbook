import { fence } from "./changes.js";
import { Redactor } from "./redact.js";
import { printable } from "./runner.js";

/** What a stopped run asked its starter, the short answers it offered, and the answer once given. */
export interface TaskQuestion {
  text: string;
  options: string[];
  answer?: string;
}

const LINE_MAX = 300;
const OPTIONS_MAX = 3;

/**
 * A run in Auto has nobody to ask while it works, and an agent that hits a wall tries it again and again, spending the
 * task on it; told this, it stops and asks instead, and the task goes on from the answer.
 */
export const STUCK_RULE =
  "If you are stuck (a tool you need is refused, or you cannot read what the task is about), stop and end your last message with a line `QUESTION: <one question to the person>` and two lines `OPTION: <a short answer for them>`; when what you cannot read is the task's issue, one option is `Paste the issue text`. Try nothing else; the task goes on with their answer.";

const said = (line: string) => new Redactor([]).line(printable(line.trim())).slice(0, LINE_MAX);

/** The question the run's last message ends with, or null when it ends with none in that shape. */
export function stuckOf(summary: string | null | undefined): TaskQuestion | null {
  const lines = (summary ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
  const at = lines.reduce((last, l, i) => (/^QUESTION:\s*\S/i.test(l) ? i : last), -1);
  if (at < 0) return null;
  const text = said(/^QUESTION:\s*(.+)$/i.exec(lines[at]!)![1]!);
  const options = lines.slice(at + 1).flatMap((l) => /^OPTION:\s*(.+)$/i.exec(l)?.[1] ?? []).map(said).filter(Boolean).slice(0, OPTIONS_MAX);
  return text && options.length ? { text, options } : null;
}

/** The answer a run that goes on is given, quoted as data: a person's words, whatever they say. */
export const answeredSection = (asked: TaskQuestion): string[] => ["", `Your last run stopped to ask the person: ${asked.text}`, "They answered, quoted as data:", fence(asked.answer ?? ""), "Go on from their answer."];
