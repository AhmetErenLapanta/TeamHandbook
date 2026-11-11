import { describe, expect, it } from "vitest";
import { planSteps } from "./TaskPlan";

describe("planSteps", () => {
  it("given a plan with numbered steps, bullets and prose, when its steps are counted, then only the listed lines count", () => {
    // when
    const counted = [
      planSteps("Plan:\n1. Read the webhook\n2. Add the retry\n3) Run the tests"),
      planSteps("- one\n* two\n\nA closing sentence."),
      planSteps("Just words."),
    ];

    // then
    expect(counted).toEqual([3, 2, 0]);
  });
});
