import { describe, expect, it } from "vitest";
import { isId, newId, OLDER_IDS } from "./ids.js";

describe("the orchestrator's ids", () => {
  it("given ids made over time and several in one millisecond, when they are sorted as text, then they come in the order they were made and each names its kind", () => {
    // given
    const made = [newId("tsk", 1_700_000_000_000), newId("tsk", 1_700_000_000_001), newId("tsk", 1_700_000_000_001), newId("tsk", 1_700_000_000_001), newId("tsk", 1_800_000_000_000)];

    // when
    const sorted = [...made].sort();

    // then
    expect(sorted).toEqual(made);
    expect(new Set(made).size).toBe(made.length);
    expect(made.every((id) => /^tsk_[0-9a-hjkmnp-tv-z]{26}$/.test(id))).toBe(true);
  });

  it.each([
    ["a new task id", "tsk", newId("tsk"), OLDER_IDS.task, true],
    ["a task id from before prefixes", "tsk", "0a1b2c3d4e5f", OLDER_IDS.task, true],
    ["a user id from before prefixes", "usr", "123e4567-e89b-42d3-a456-426614174000", OLDER_IDS.uuid, true],
    ["an id of another kind", "tsk", newId("evt"), OLDER_IDS.task, false],
    ["a path in place of an id", "tsk", "../tsk_01jc5x7q4m0000000000012345", OLDER_IDS.task, false],
    ["a body with a letter base32 leaves out", "tsk", "tsk_01jc5x7q4m000000000001234u", OLDER_IDS.task, false],
  ])("given %s, when it is checked, then it is taken only if it is that kind's", (_label, prefix, value, older, taken) => {
    expect(isId(prefix as "tsk" | "usr", value, older)).toBe(taken);
  });
});
