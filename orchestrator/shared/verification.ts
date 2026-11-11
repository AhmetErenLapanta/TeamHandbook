/** What a project's check proves: its tests, its linter, its build or its type check. */
export type CheckKind = "test" | "lint" | "build" | "typecheck";

/**
 * A command read off a project's files, never run to be found: what the shell is given, what it
 * resolves to as the person approves it, where it was read, and whether it reaches the network or
 * takes long. The digest covers everything the command's effect is read from, so a change to any
 * of it (a teammate's, or the agent's in a repair round) asks for the approval again.
 */
export interface DetectedStep {
  command: string;
  runs: string;
  source: string;
  network: boolean;
  long: boolean;
  digest: string;
}

export interface DetectedCheck extends DetectedStep {
  kind: CheckKind;
}

/** What a project's files say it installs with and checks with; the first check is the one proposed. */
export interface DetectedVerification {
  setup: DetectedStep | null;
  checks: DetectedCheck[];
}

/** The checks a project's owner approved, in the order they run, with the setup that goes before them, as the files read then. */
export interface ApprovedVerification {
  checks: DetectedCheck[];
  setup: DetectedStep | null;
  by: string;
  at: string;
}

/**
 * A project's verification as its page shows it. `configured` is the command the orchestrator's
 * configuration file sets, which needs no approval and wins over one; `changed` names what moved
 * since the approval, which then runs nothing until it is approved again.
 */
export interface ProjectVerification {
  configured: string | null;
  approved: ApprovedVerification | null;
  detected: DetectedVerification | null;
  /** Why the project's files were not read, when they were not. */
  unread: string | null;
  changed: string[];
}

/** One run of a step: its exit code, whether it ran out of time, how long it took, and its last lines, masked. */
export interface StepRun {
  code: number | null;
  timedOut: boolean;
  ms: number;
  output: string;
  /** Lines of output left out ahead of the ones kept. */
  cut: number;
}

/**
 * - `passed`: green before and after the agent.
 * - `fixed`: red before the agent, green after it.
 * - `broken`: green before, still red after the repair rounds.
 * - `failing-before`: red before and after; the failure was there before the agent.
 * - `not-run`: no approved command, or one that changed since it was approved.
 */
export type Verdict = "passed" | "fixed" | "broken" | "failing-before" | "not-run";

/**
 * One command's runs on a task: before the agent, then each round after it (the first after the
 * agent's own turn, then one after each repair round), and its own verdict.
 */
export interface CheckRuns {
  command: string;
  runs: string;
  source: string;
  before: StepRun | null;
  after: StepRun[];
  verdict: Verdict;
}

/**
 * What a task's checks showed, for its page and its request: each command's runs, the setup's run,
 * the repair rounds asked, and the task's verdict, the worst of its commands', with its reason in
 * one sentence.
 */
export interface TaskVerification {
  checks: CheckRuns[];
  setup: StepRun | null;
  repairs: number;
  verdict: Verdict;
  reason: string;
}
