import { describe, expect, it } from "vitest";
import { MAX_SLOTS, slotsFor } from "./slots.js";

describe("how many tasks a machine takes at once", () => {
  const idle = { perCore: 0.2, battery: null };

  it.each([
    ["the default of two on an idle machine", 2, idle, 2],
    ["more than the most it takes", 9, idle, MAX_SLOTS],
    ["less than one", 0, idle, 1],
    ["two on a machine busy past its cores", 2, { perCore: 0.9, battery: null }, 1],
    ["two on a low battery", 2, { perCore: 0.2, battery: { charging: false, percent: 20 } }, 1],
    ["two on a low battery that is charging", 2, { perCore: 0.2, battery: { charging: true, percent: 20 } }, 2],
  ])("given %s, when the machine counts its slots, then it takes the number that holds", (_case, wanted, load, slots) => {
    // when
    const taken = slotsFor(wanted, load);

    // then
    expect(taken).toBe(slots);
  });
});
