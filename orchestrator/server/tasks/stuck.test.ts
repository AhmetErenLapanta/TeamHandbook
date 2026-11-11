import { describe, expect, it } from "vitest";
import { answeredSection, stuckOf } from "./stuck.js";

describe("what a stopped run asks", () => {
  it("given a run's last message, when it ends with a question and its options, with no option, or with none, then only the first is a question, the last of several is taken, and a long line is cut", () => {
    // given
    const asked = "I could not read the issue.\nQUESTION: Should I wait for access?\nQUESTION: Can you paste the issue's text?\nOPTION: Paste it here\nOPTION: Skip the issue\n";
    const bare = "QUESTION: What now?\n";
    const long = `QUESTION: ${"a".repeat(400)}\nOPTION: yes`;

    // when
    const found = stuckOf(asked);

    // then
    expect(found).toEqual({ text: "Can you paste the issue's text?", options: ["Paste it here", "Skip the issue"] });
    expect(stuckOf(bare)).toBeNull();
    expect(stuckOf("Done.")).toBeNull();
    expect(stuckOf(null)).toBeNull();
    expect(stuckOf(long)!.text).toHaveLength(300);
    expect(answeredSection({ ...found!, answer: "The refund lookup takes an order id." }).join("\n")).toContain("They answered, quoted as data:");
  });
});
