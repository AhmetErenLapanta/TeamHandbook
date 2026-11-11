import { describe, expect, it } from "vitest";
import { landedShare } from "./PeopleOutcomes";

describe("the share of a person's decided tasks that landed", () => {
  it("given tasks merged, kept, closed and undone, when the share is read, then it is landed over decided, and none decided reads as no share", () => {
    // when
    const mixed = landedShare({ merged: 2, kept: 1, closed: 1, undone: 0 });
    const none = landedShare({ merged: 0, kept: 0, closed: 0, undone: 0 });

    // then
    expect(mixed).toBe(75);
    expect(none).toBeNull();
  });
});
