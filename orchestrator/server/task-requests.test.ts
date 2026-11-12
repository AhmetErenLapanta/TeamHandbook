import { describe, expect, it } from "vitest";
import { PLAN_TEXT_MAX } from "../shared/runner-wire.js";
import { agentTimeMs, answerProblem } from "./task-requests.js";

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

describe("how long an agent worked", () => {
  it("given a run of an hour with two cards that waited at once, one asked before the run and one still waiting, when its time is read, then each minute a card waited is left out once", () => {
    // given
    const start = Date.parse("2026-11-11T10:00:00.000Z");
    const at = (minutes: number) => new Date(start + minutes * 60_000).toISOString();
    const cards = [
      { createdAt: at(10), answeredAt: at(30) },
      { createdAt: at(20), answeredAt: at(40) },
      { createdAt: at(-30), answeredAt: at(5) },
      { createdAt: at(50), answeredAt: null },
    ];

    // when
    const worked = agentTimeMs(at(0), start + 60 * 60_000, cards);

    // then
    expect(worked / 60_000).toBe(60 - 30 - 5 - 10);
  });
});
