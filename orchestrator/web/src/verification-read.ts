import { call } from "./api";
import type { CheckRuns, DetectedCheck, DetectedStep, ProjectVerification, StepRun, TaskVerification } from "../../shared/verification";

export type { CheckRuns, DetectedCheck, DetectedStep, ProjectVerification, StepRun, TaskVerification } from "../../shared/verification";

const choice = (step: DetectedStep) => ({ source: step.source, command: step.command, digest: step.digest });

/** A task's checks per repository it changed; a task whose project has none approved has none. */
export const verificationRead = {
  task: (id: string) => call<{ verifications: { repoId: string; verification: TaskVerification }[] }>("GET", `/api/tasks/${encodeURIComponent(id)}/verification`).then((b) => b.verifications),
  project: (id: string) => call<ProjectVerification>("GET", `/api/projects/${encodeURIComponent(id)}/verification`),
  /** Approves the checks as the person was shown them: by their digests, so files changed since are refused, not run. */
  approve: (id: string, checks: DetectedCheck[], setup: DetectedStep | null) =>
    call<ProjectVerification>("PUT", `/api/projects/${encodeURIComponent(id)}/verification`, { checks: checks.map(choice), setup: setup ? choice(setup) : null }),
  /** Takes the approval back, so a task runs no check rather than one the person unticked. */
  forget: (id: string) => call<ProjectVerification>("DELETE", `/api/projects/${encodeURIComponent(id)}/verification`),
};

/** What a first task's box says it checks with, and what its Start approves: built from one value, so nothing unsaid is sent. */
export interface ChecksSaid {
  configured: string | null;
  checks: DetectedStep[];
  setup: DetectedStep | null;
  approve: { checks: DetectedCheck[]; setup: DetectedStep | null } | null;
  canChange: boolean;
}

/**
 * The checks a first task runs with, as its box says them: the configured command alone; else the
 * approved ones while nothing they read has changed; else the ones picked, the first found by default,
 * with the setup found before them, since a fresh checkout of a project that installs fails without it.
 * `approve` is what Start approves first, by digest, and is exactly what the box says; null when
 * nothing waits on the person.
 */
export function checksToSay(v: ProjectVerification, picked: string[] | null): ChecksSaid {
  if (v.configured) return { configured: v.configured, checks: [], setup: null, approve: null, canChange: false };
  const found = v.detected?.checks ?? [];
  if (v.approved && !v.changed.length && picked === null) return { configured: null, checks: v.approved.checks, setup: v.approved.setup, approve: null, canChange: found.length > 0 };
  const chosen = picked === null ? found.slice(0, 1) : found.filter((c) => picked.includes(c.command));
  const setup = chosen.length ? (v.detected?.setup ?? null) : null;
  return { configured: null, checks: chosen, setup, approve: chosen.length ? { checks: chosen, setup } : null, canChange: found.length > 0 };
}

const state = (run: StepRun | null | undefined): string => (!run ? "not run" : run.timedOut ? "timed out" : run.code === 0 ? "passed" : "failed");

/**
 * One check's line in the task's rail: how it stood before the agent's work and after it, with the
 * repair rounds it took ("passed before, passed after 1 repair round"). The first run after is the
 * agent's own turn; each one after that is a repair round.
 */
export function checkWords(check: Pick<CheckRuns, "before" | "after">): string {
  const rounds = Math.max(0, check.after.length - 1);
  const after = `${state(check.after.at(-1))} after${rounds ? ` ${rounds} repair ${rounds === 1 ? "round" : "rounds"}` : ""}`;
  return `${state(check.before)} before, ${after}`;
}

/** Whether a check's line is drawn in the danger tone: it fails once the agent is done. */
export function stillFails(check: Pick<CheckRuns, "verdict">): boolean {
  return check.verdict === "broken" || check.verdict === "failing-before";
}
