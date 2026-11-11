import { describe, expect, it } from "vitest";
import { PLAN_TEXT_MAX } from "../shared/runner-wire.js";
import { answerProblem } from "./task-requests.js";

describe("what an answer to the agent's plan may hold", () => {
  it("given a plan request, when it is approved, approved as changed, declined with a note, allowed for the task, approved with an empty, too long or declined plan, then only the first three are taken", () => {
    // given
    const plan = { kind: "plan" as const, payload: { tool: "ExitPlanMode", summary: "1. Read", plan: "1. Read" } };

    // when
    const answers = [
      { decision: "allow_once" as const },
      { decision: "allow_once" as const, plan: "1. Only read" },
      { decision: "deny" as const, note: "Not now." },
      { decision: "allow_for_task" as const },
      { decision: "allow_once" as const, plan: "  " },
      { decision: "allow_once" as const, plan: "a".repeat(PLAN_TEXT_MAX + 1) },
      { decision: "deny" as const, plan: "1. Read" },
    ].map((answer) => answerProblem(plan, answer));

    // then
    expect(answers.slice(0, 3)).toEqual([null, null, null]);
    expect(answers.slice(3).every((p) => p !== null)).toBe(true);
  });
});
