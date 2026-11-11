import { describe, expect, it } from "vitest";
import { neutralizeReferences } from "./references.js";

describe("taking a text's power over the tracker out", () => {
  it("given closing words before an issue reference, when the text is neutralized, then each word is bracketed and the reference kept", () => {
    expect(neutralizeReferences("Closes #1")).toBe("[Closes] #1");
    expect(neutralizeReferences("Fixes PAY-142")).toBe("[Fixes] PAY-142");
    expect(neutralizeReferences("fixed: acme/payments#3")).toBe("[fixed]: acme/payments#3");
    expect(neutralizeReferences("Resolves issue #4")).toBe("[Resolves] issue #4");
    expect(neutralizeReferences("Implements https://tracker.example.com/browse/PAY-142")).toBe("[Implements] https://tracker.example.com/browse/PAY-142");
    expect(neutralizeReferences("closing #5, #6 and #7")).toBe("[closing] #5, #6 and #7");
  });

  it("given smart-commit commands, when the text is neutralized, then no # is followed by a word", () => {
    const out = neutralizeReferences("PAY-142 #comment looks good #time 1h #done #start-progress");
    expect(out).toBe("PAY-142 # comment looks good # time 1h # done # start-progress");
    expect(out).not.toMatch(/#[A-Za-z]/);
  });

  it("given text with no reference to close and plain issue mentions, when it is neutralized, then it is unchanged, and neutralizing twice changes nothing more", () => {
    for (const text of ["Fixed the rounding in the ledger.", "See #12 and PAY-142.", "acme/payments#3 is related"]) expect(neutralizeReferences(text)).toBe(text);
    const once = neutralizeReferences("Fixes #1 #done");
    expect(neutralizeReferences(once)).toBe(once);
  });
});
