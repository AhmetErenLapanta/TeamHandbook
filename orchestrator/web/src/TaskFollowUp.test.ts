import { describe, expect, it } from "vitest";
import { addQuote, MOST_QUOTES } from "./TaskFollowUp";

describe("addQuote", () => {
  it("given a quote of lines already quoted and one of other lines, when each is added, then the same lines stay once and the other joins after them", () => {
    // given
    const held = [{ path: "src/refund.ts", lines: "10-12", text: "+a" }];

    // when
    const again = addQuote(held, { path: "src/refund.ts", lines: "10-12", text: "+a" });
    const other = addQuote(held, { path: "src/refund.ts", lines: "30", text: "-b" });

    // then
    expect(again).toBe(held);
    expect(other.map((q) => q.lines)).toEqual(["10-12", "30"]);
  });

  it("given a follow-up holding as many quotes as it sends, when one more is added, then it is left out", () => {
    // given
    const full = Array.from({ length: MOST_QUOTES }, (_, i) => ({ path: "a.ts", lines: `${i + 1}`, text: "+x" }));

    // when
    const next = addQuote(full, { path: "b.ts", lines: "1", text: "+y" });

    // then
    expect(next).toBe(full);
  });
});
