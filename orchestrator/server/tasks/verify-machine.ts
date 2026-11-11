import type { CheckRuns, StepRun, TaskVerification, Verdict } from "../../shared/verification.js";
import type { OrchestratorContext } from "../app.js";
import { neutralizeReferences } from "./references.js";
import { taskMask } from "./task-text.js";
import type { TaskRecord } from "./types.js";
import { nextStep, saveEvidence, testOutcome, verdictOf } from "./verify.js";
import type { VerifyPlan } from "./verify.js";

type Handed = { plan: VerifyPlan; maxRepairs: number };

// Forty kept lines of at most 400 characters and an ellipsis each, with the line breaks between them.
const MAX_OUTPUT = 40 * 402;
const MAX_REASON = 300;

const text = (value: unknown, max: number): value is string => typeof value === "string" && value.length <= max;
const count = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0;

function stepRun(value: unknown): StepRun | null {
  if (typeof value !== "object" || value === null) return null;
  const { code, timedOut, ms, output, cut } = value as Record<string, unknown>;
  if (!(code === null || (typeof code === "number" && Number.isInteger(code))) || typeof timedOut !== "boolean" || !count(ms) || !text(output, MAX_OUTPUT) || !count(cut)) return null;
  return { code, timedOut, ms, output, cut };
}

/**
 * A machine's report of a task's checks as the orchestrator keeps it, or null when it is not one: the
 * machine is the person's, so the report is held to the plan it was handed (the same checks in the
 * same order, no setup it was not given, no more repair rounds than it was given), each check's text
 * is the plan's rather than the machine's, and each verdict is worked out again here from the exit
 * codes it reports rather than taken from it.
 */
function parsed(raw: unknown, handed: Handed, mask: (text: string) => string): TaskVerification | null {
  if (typeof raw !== "object" || raw === null) return null;
  const { checks, setup, repairs, verdict, reason } = raw as Record<string, unknown>;
  const planned = handed.plan.checks;
  if (!Array.isArray(checks) || checks.length !== planned.length || !count(repairs) || repairs > handed.maxRepairs) return null;
  const setupRun = setup === null || setup === undefined ? null : stepRun(setup);
  if (setup && (!setupRun || !handed.plan.setup)) return null;
  const runs: CheckRuns[] = [];
  for (const [i, entry] of checks.entries()) {
    if (typeof entry !== "object" || entry === null) return null;
    const { command, source, before, after } = entry as Record<string, unknown>;
    const check = planned[i]!;
    if (command !== check.command || source !== check.source || !Array.isArray(after) || after.length > handed.maxRepairs + 1) return null;
    const first = before === null ? null : stepRun(before);
    if (before !== null && !first) return null;
    const rounds = after.map(stepRun);
    if (rounds.some((run) => !run)) return null;
    runs.push({ command: check.command, runs: check.runs, source: check.source, before: first, after: rounds as StepRun[], verdict: "not-run" });
  }
  const ran = runs.filter((check) => check.after.length);
  if (!ran.length) {
    if (verdict !== "not-run" || !text(reason, MAX_REASON)) return null;
    return { checks: runs, setup: setupRun, repairs: 0, verdict: "not-run", reason: `The checks did not run on the machine: ${neutralizeReferences(mask(reason))}` };
  }
  if (ran.length !== runs.length || runs.some((check) => check.after.length !== repairs + 1)) return null;
  const { verdicts } = nextStep(runs.map((check) => check.before), Array.from({ length: repairs + 1 }, (_, i) => runs.map((check) => check.after[i]!)), repairs) as { verdicts: Verdict[] };
  const checked = runs.map((check, i) => ({ ...check, verdict: verdicts[i]! }));
  return { checks: checked, setup: setupRun, repairs, ...verdictOf(checked, repairs) };
}

/**
 * Keeps what a task's checks showed on its person's machine as the task's evidence, masked here with
 * the task's secrets, and gives the task record's one-word outcome; null when the machine was handed
 * no checks or the report is not one the orchestrator reads, and then nothing is kept.
 */
export async function recordMachineVerification(ctx: Pick<OrchestratorContext, "store" | "tenant" | "vault">, task: Pick<TaskRecord, "id" | "repoId" | "team">, raw: unknown, handed: Handed | null): Promise<"passed" | "failed" | "skipped" | null> {
  if (!handed) return null;
  const mask = await taskMask(ctx, task);
  const verification = parsed(raw, handed, mask);
  if (!verification) return null;
  await saveEvidence(ctx.store, ctx.tenant, task.id, task.repoId, verification, mask);
  return testOutcome(verification);
}
