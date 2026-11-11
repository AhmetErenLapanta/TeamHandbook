import { describe, expect, it } from "vitest";
import { weightOf } from "./change-weight";

describe("weightOf", () => {
  it("given a one-line addition, when it is weighed, then one square is green and four are empty", () => {
    // given
    const [added, removed] = [1, 0];

    // when
    const weight = weightOf(added, removed);

    // then
    expect(weight).toEqual({ added: 1, removed: 0, empty: 4 });
  });

  it("given a large change mostly added, when it is weighed, then all five squares fill, split by what was added against removed", () => {
    // given
    const [added, removed] = [47, 4];

    // when
    const weight = weightOf(added, removed);

    // then
    expect(weight).toEqual({ added: 5, removed: 0, empty: 0 });
  });

  it("given an even change of fourteen lines, when it is weighed, then three squares fill, two of one colour and one of the other", () => {
    // given
    const [added, removed] = [7, 7];

    // when
    const weight = weightOf(added, removed);

    // then
    expect(weight.added + weight.removed).toBe(3);
    expect(Math.abs(weight.added - weight.removed)).toBe(1);
  });

  it("given a change of no lines, when it is weighed, then no square fills", () => {
    // given
    const [added, removed] = [0, 0];

    // when
    const weight = weightOf(added, removed);

    // then
    expect(weight).toEqual({ added: 0, removed: 0, empty: 5 });
  });
});
