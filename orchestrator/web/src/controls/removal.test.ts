import { describe, expect, it } from "vitest";
import { usageLine } from "./removal";

describe("the use line under a removal", () => {
  it("given a team that does not report use, when the line is read, then use is not counted rather than none", () => {
    expect(usageLine({ counted: false, days: 30, count: 0, lastHour: null, daily: [] })).toBe("This team does not report skill use, so recent use is not counted.");
  });

  it("given a reporting team with no use, when the line is read, then it says no reported use", () => {
    expect(usageLine({ counted: true, days: 30, count: 0, lastHour: null, daily: [] })).toBe("No reported use in the last 30 days.");
  });

  it("given reported use, when the line is read, then it gives the count and the last day", () => {
    expect(usageLine({ counted: true, days: 30, count: 12, lastHour: "2026-10-23T09", daily: [] })).toBe("Used 12 times in the last 30 days, last on 2026-10-23.");
  });
});
