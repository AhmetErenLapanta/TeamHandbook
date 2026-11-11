import { describe, expect, it } from "vitest";
import { nodeTooOld } from "./node-guard.mjs";

describe("asking whether this Node can run the orchestrator", () => {
  it("given a Node older than the range, when asked, then it names the Node needed and the one it is", () => {
    // given
    const range = ">=22.16";

    // when
    const answers = ["18.20.8", "20.20.0", "22.15.9"].map((version) => nodeTooOld(range, version));

    // then
    expect(answers[0]).toContain("needs Node 22.16 or newer; this is Node 18.20.8");
    expect(answers[1]).toContain("this is Node 20.20.0");
    expect(answers[2]).toContain("this is Node 22.15.9");
  });

  it("given the Node the range names, a later minor and a later major, when asked, then nothing is refused", () => {
    // given
    const range = ">=22.16";

    // when
    const answers = ["22.16.0", "22.17.1", "24.0.0", "26.8.1"].map((version) => nodeTooOld(range, version));

    // then
    expect(answers).toEqual([null, null, null, null]);
  });
});
