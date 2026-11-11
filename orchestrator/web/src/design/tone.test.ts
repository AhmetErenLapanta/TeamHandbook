import { describe, expect, it } from "vitest";
import { toneOf } from "./tone";

describe("toneOf", () => {
  it("given the states that wait on a person, when each is toned, then each is amber", () => {
    // given
    const waiting = ["needs-review", "interrupted", "awaiting review", "open"];

    // when
    const tones = waiting.map(toneOf);

    // then
    expect(new Set(tones)).toEqual(new Set(["warn"]));
  });

  it("given a task's folder changes kept, undone and a request closed, when each is toned, then kept is green and the other two are grey", () => {
    // given
    const states = ["changes kept", "changes undone", "closed"];

    // when
    const tones = states.map(toneOf);

    // then
    expect(tones).toEqual(["ok", "neutral", "neutral"]);
  });

  it("given a state the table does not name, when it is toned, then it is grey rather than a colour that says something", () => {
    // given
    const state = "something new";

    // when
    const tone = toneOf(state);

    // then
    expect(tone).toBe("neutral");
  });
});
