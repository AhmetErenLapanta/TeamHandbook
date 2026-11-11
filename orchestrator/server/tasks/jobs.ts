/**
 * A task a team keeps ready to run by name: on a schedule, or when a teammate asks for it in a
 * comment on the team's forge. Either way it runs as any task does and ends in a request a
 * person reviews; nothing about how it was started counts as approving its change.
 */
export interface Job {
  id: string;
  title: string;
  description: string;
  agent: string;
  /** Five cron fields (minute, hour, day of month, month, day of week), read in UTC. */
  schedule?: string;
}

const JOB_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
const JOB_KEYS = new Set(["id", "title", "description", "agent", "schedule"]);
const FIELDS: [number, number][] = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 6]];

/** The values one cron field allows, or null when it is not one: `*`, numbers, `a-b` ranges, `,` lists and `/n` steps. */
function cronField(field: string, [min, max]: [number, number]): Set<number> | null {
  const values = new Set<number>();
  for (const part of field.split(",")) {
    const m = /^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(part);
    if (!m) return null;
    const from = m[1] === "*" ? min : Number(m[2]);
    const to = m[1] === "*" ? max : m[3] !== undefined ? Number(m[3]) : m[4] !== undefined ? max : from;
    const step = m[4] !== undefined ? Number(m[4]) : 1;
    if (from < min || to > max || from > to || step < 1) return null;
    for (let v = from; v <= to; v += step) values.add(v);
  }
  return values;
}

export function cronProblem(expr: string): string | null {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return "a schedule is five cron fields: minute, hour, day of month, month, day of week";
  const names = ["minute", "hour", "day of month", "month", "day of week"];
  const bad = fields.findIndex((f, i) => cronField(f, FIELDS[i]!) === null);
  return bad >= 0 ? `its ${names[bad]} field ${JSON.stringify(fields[bad])} is not one cron understands here` : null;
}

/** Whether a schedule names this minute, in UTC. Day of month and day of week both have to match. */
export function cronMatches(expr: string, at: Date): boolean {
  const fields = expr.trim().split(/\s+/).map((f, i) => cronField(f, FIELDS[i]!));
  if (fields.length !== 5 || fields.some((f) => f === null)) return false;
  const now = [at.getUTCMinutes(), at.getUTCHours(), at.getUTCDate(), at.getUTCMonth() + 1, at.getUTCDay()];
  return now.every((v, i) => fields[i]!.has(v));
}

/** A repository's jobs from the orchestrator's configuration, or a refusal naming the first thing wrong. */
export function parseJobs(value: unknown, repoId: string): Job[] {
  if (value === undefined) return [];
  const where = `repository ${repoId}: jobs`;
  if (!Array.isArray(value)) throw new Error(`${where} is a list`);
  const ids = new Set<string>();
  return value.map((raw, index) => {
    const at = `${where}[${index}]`;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${at} is an object`);
    const job = raw as Record<string, unknown>;
    const extra = Object.keys(job).filter((k) => !JOB_KEYS.has(k));
    if (extra.length) throw new Error(`${at} has ${extra.map((k) => JSON.stringify(k)).join(", ")}, which a job does not take`);
    if (typeof job.id !== "string" || !JOB_ID.test(job.id)) throw new Error(`${at}.id is lowercase letters, digits and dashes`);
    if (ids.has(job.id)) throw new Error(`${at}.id ${job.id} appears twice`);
    ids.add(job.id);
    for (const key of ["title", "agent"] as const) {
      if (typeof job[key] !== "string" || !(job[key] as string).trim() || /\p{C}/u.test(job[key] as string)) throw new Error(`${at}.${key} is one line of text`);
    }
    if (job.description !== undefined && typeof job.description !== "string") throw new Error(`${at}.description is text`);
    if (job.schedule !== undefined) {
      const problem = typeof job.schedule === "string" ? cronProblem(job.schedule) : "a schedule is text";
      if (problem) throw new Error(`${at}.schedule: ${problem}`);
    }
    return {
      id: job.id,
      title: (job.title as string).trim(),
      description: typeof job.description === "string" ? job.description : "",
      agent: job.agent as string,
      ...(typeof job.schedule === "string" ? { schedule: job.schedule.trim() } : {}),
    };
  });
}
