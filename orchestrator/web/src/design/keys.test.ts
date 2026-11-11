import { describe, expect, it } from "vitest";
import { readKey } from "./keys";
import type { Tab } from "./keys";

const TABS: Tab[] = [
  { section: "activity", label: "Activity" },
  { section: "tasks", label: "Tasks" },
  { section: "settings", label: "Settings" },
];

describe("readKey", () => {
  it("given g was pressed, when a shown tab's first letter follows, then it goes to that tab", () => {
    // given
    const afterG = true;

    // when
    const action = readKey("t", afterG, TABS);

    // then
    expect(action).toEqual({ kind: "go", section: "tasks" });
  });

  it("given g was pressed, when the letter of a tab this person is not shown follows, then nothing happens", () => {
    // given
    const afterG = true;

    // when
    const action = readKey("c", afterG, TABS);

    // then
    expect(action).toBeNull();
  });

  it("given no g before it, when a tab's letter is pressed alone, then nothing happens, and ?, / and g each do their own", () => {
    // given
    const afterG = false;

    // when
    const actions = ["t", "?", "/", "g"].map((k) => readKey(k, afterG, TABS));

    // then
    expect(actions).toEqual([null, { kind: "help" }, { kind: "search", anywhere: false }, { kind: "then" }]);
  });

  it("given Cmd or Ctrl held, when K is pressed, then it searches, and with any other key nothing happens", () => {
    // given
    const mod = true;

    // when
    const actions = ["k", "K", "1", "g"].map((k) => readKey(k, false, TABS, mod));

    // then
    expect(actions).toEqual([{ kind: "search", anywhere: true }, { kind: "search", anywhere: true }, null, null]);
  });
});
